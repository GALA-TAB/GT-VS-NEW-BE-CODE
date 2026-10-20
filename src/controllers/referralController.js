const crypto = require('node:crypto');
const ReferralAccount = require('../models/ReferralAccount');
const ReferralAttribution = require('../models/ReferralAttribution');
const ReferralCommission = require('../models/ReferralCommission');
const ReferralProgramSettings = require('../models/ReferralProgramSettings');
const Booking = require('../models/Bookings');
const Listing = require('../models/ServiceListing');
const Pricing = require('../models/Pricing');
const User = require('../models/users/User');
const stripe = require('../config/stripe');
const { createStripeOnBoardingLink, receiveAccount } = require('../utils/stripe-utils/connect-accounts.util');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const {
  DEFAULT_REFERRAL_RATE_PERCENT,
  DEFAULT_MINIMUM_SERVICE_SUBTOTAL,
  calculateReferralCommission,
  calculateVendorNet
} = require('../utils/referral-program');
const { hashToken, createAttributionForCode } = require('../utils/referralAttribution');

const TERMS_VERSION = 'gala-tab-referral-2026-10-v1';
const DEFAULT_SETTINGS = {
  version: 1,
  termsVersion: TERMS_VERSION,
  enabled: true,
  commissionRatePercent: DEFAULT_REFERRAL_RATE_PERCENT,
  minimumServiceSubtotal: DEFAULT_MINIMUM_SERVICE_SUBTOTAL,
  attributionWindowDays: 30,
  completionDelayHours: 48,
  payoutsEnabled: false
};

const getCurrentSettings = async () =>
  (await ReferralProgramSettings.findOne().sort({ version: -1 })) || DEFAULT_SETTINGS;

const ensureAccount = async (userId) => {
  let account = await ReferralAccount.findOne({ user: userId });
  if (account) return account;

  const user = await User.findById(userId).select('_id role');
  if (!user) throw new AppError('User not found', 404);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      account = await ReferralAccount.create({
        user: userId,
        code: `GT${crypto.randomBytes(5).toString('hex').toUpperCase()}`
      });
      return account;
    } catch (error) {
      if (error.code !== 11000) throw error;
      account = await ReferralAccount.findOne({ user: userId });
      if (account) return account;
      if (attempt === 2) throw error;
    }
  }
  throw new AppError('Could not create a referral account', 500);
};

const getReferralOverview = catchAsync(async (req, res) => {
  const [account, settings] = await Promise.all([
    ReferralAccount.findOne({ user: req.user._id }),
    getCurrentSettings()
  ]);
  const currentFee = await Pricing.findOne().sort({ createdAt: -1 });
  const feePercent = Number(req.user.customPricingPercentage || currentFee?.pricingPercentage || 0);
  const example = {
    serviceSubtotal: 2000,
    platformFee: Number(((2000 * feePercent) / 100).toFixed(2)),
    commission: 100,
    expectedVendorProceeds: calculateVendorNet(2000, feePercent, 100),
    platformFeePercent: feePercent
  };

  const [records, referredBookingCount] = await Promise.all([
    ReferralCommission.find({ referrer: req.user._id })
      .select('booking serviceSubtotal remainingServiceSubtotal amount status createdAt updatedAt providerPayoutId recoverableAmount')
      .populate({ path: 'booking', select: 'bookingRef checkIn checkOut status' })
      .sort({ createdAt: -1 }),
    Booking.countDocuments({ 'referral.referrer': req.user._id })
  ]);
  const summary = { bookings: referredBookingCount, pending: 0, eligible: 0, processing: 0, paid: 0, canceled: 0, failed: 0, paused: 0, review: 0, totalEarnings: 0, paidEarnings: 0, commissions: [] };
  for (const record of records) {
    if (Object.hasOwn(summary, record.status)) summary[record.status] += 1;
    if (record.status === 'paid') summary.paidEarnings += record.amount;
    if (!['canceled', 'failed'].includes(record.status)) summary.totalEarnings += record.amount;
  }
  summary.commissions = records.map((record) => ({
    bookingRef: record.booking?.bookingRef || 'Booking',
    serviceDate: record.booking?.checkOut || record.booking?.checkIn || null,
    serviceSubtotal: record.remainingServiceSubtotal ?? record.serviceSubtotal,
    amount: record.amount,
    status: record.status,
    updatedAt: record.updatedAt,
    payoutReference: record.providerPayoutId || null,
    recoverableAmount: record.recoverableAmount
  }));

  res.status(200).json({
    status: 'success',
    data: {
      enrolled: Boolean(account?.referrerEnabled),
      vendorFundingEnabled: Boolean(account?.vendorFundingEnabled),
      referrerNeedsConsent: Boolean(account?.referrerEnabled && account.referrerConsent?.termsVersion !== settings.termsVersion),
      vendorNeedsConsent: Boolean(account?.vendorFundingEnabled && account.vendorConsent?.termsVersion !== settings.termsVersion),
      code: account?.code || null,
      referralUrl: account?.code && account.referrerEnabled && settings.enabled &&
        account.referrerConsent?.termsVersion === settings.termsVersion &&
        account.referrerConsent?.ratePercent === settings.commissionRatePercent &&
        account.referrerConsent?.minimumServiceSubtotal === settings.minimumServiceSubtotal
        ? `${String(process.env.FRONTEND_URL || '').replace(/\/+$/, '')}/?ref=${encodeURIComponent(account.code)}`
        : null,
      payoutOnboardingStatus: account?.payoutOnboardingStatus || 'not_started',
      currentSettings: settings,
      example,
      summary
    }
  });
});

const updateParticipation = catchAsync(async (req, res, next) => {
  const { referrerEnabled, vendorFundingEnabled, acceptReferrerTerms, acceptVendorTerms } = req.body;
  if ((referrerEnabled !== undefined && typeof referrerEnabled !== 'boolean') ||
      (vendorFundingEnabled !== undefined && typeof vendorFundingEnabled !== 'boolean')) {
    return next(new AppError('Participation settings must be boolean values.', 400));
  }
  const settings = await getCurrentSettings();
  if (!settings.enabled && (referrerEnabled || vendorFundingEnabled)) {
    return next(new AppError('The referral program is not accepting new participants.', 403));
  }
  const account = await ensureAccount(req.user._id);
  const user = await User.findById(req.user._id).select('_id role');

  if (referrerEnabled !== undefined) {
    if (referrerEnabled && acceptReferrerTerms !== true) {
      return next(new AppError('Accept the referral terms before enrolling.', 400));
    }
    account.referrerEnabled = Boolean(referrerEnabled);
    if (referrerEnabled) {
      account.referrerConsent = {
        acceptedAt: new Date(),
        termsVersion: settings.termsVersion,
        ratePercent: settings.commissionRatePercent,
        minimumServiceSubtotal: settings.minimumServiceSubtotal
      };
    }
    account.consentHistory.push({
      participantType: 'referrer',
      enabled: Boolean(referrerEnabled),
      acceptedAt: new Date(),
      termsVersion: referrerEnabled ? settings.termsVersion : account.referrerConsent?.termsVersion,
      ratePercent: referrerEnabled ? settings.commissionRatePercent : account.referrerConsent?.ratePercent,
      minimumServiceSubtotal: referrerEnabled ? settings.minimumServiceSubtotal : account.referrerConsent?.minimumServiceSubtotal
    });
  }

  if (vendorFundingEnabled !== undefined) {
    if (user.role !== 'vendor') return next(new AppError('Only vendor accounts can fund referral commissions.', 403));
    if (req.user.vendorRole === 'staff' || req.user.staffOf) {
      return next(new AppError('Vendor staff cannot accept commission funding terms for a business.', 403));
    }
    if (vendorFundingEnabled && acceptVendorTerms !== true) {
      return next(new AppError('Explicit vendor commission consent is required.', 400));
    }
    account.vendorFundingEnabled = Boolean(vendorFundingEnabled);
    if (vendorFundingEnabled) {
      account.vendorConsent = {
        acceptedAt: new Date(),
        termsVersion: settings.termsVersion,
        ratePercent: settings.commissionRatePercent,
        minimumServiceSubtotal: settings.minimumServiceSubtotal
      };
    }
    account.consentHistory.push({
      participantType: 'vendor',
      enabled: Boolean(vendorFundingEnabled),
      acceptedAt: new Date(),
      termsVersion: vendorFundingEnabled ? settings.termsVersion : account.vendorConsent?.termsVersion,
      ratePercent: vendorFundingEnabled ? settings.commissionRatePercent : account.vendorConsent?.ratePercent,
      minimumServiceSubtotal: vendorFundingEnabled ? settings.minimumServiceSubtotal : account.vendorConsent?.minimumServiceSubtotal
    });
  }

  await account.save();
  res.status(200).json({ status: 'success', data: account });
});

const createAttribution = catchAsync(async (req, res, next) => {
  const { code, existingToken } = req.body;
  if (typeof req.body.visitorId !== 'string' || req.body.visitorId.length < 10 || req.body.visitorId.length > 128) {
    return next(new AppError('A valid visitor identifier is required.', 400));
  }
  if (existingToken) {
    if (typeof existingToken !== 'string' || !/^[a-f0-9]{64}$/i.test(existingToken)) {
      return next(new AppError('Invalid attribution token.', 400));
    }
    const existing = await ReferralAttribution.findOne({ tokenHash: hashToken(existingToken), status: 'active' });
    if (existing && existing.expiresAt > new Date()) {
      return res.status(200).json({ status: 'success', data: { token: existingToken, expiresAt: existing.expiresAt, preserved: true } });
    }
  }
  if (typeof code !== 'string' || !/^GT[A-F0-9]{10}$/i.test(code.trim())) {
    return next(new AppError('Invalid referral code.', 400));
  }
  const created = await createAttributionForCode(code, req.user?._id, req.body.visitorId);
  if (!created) return next(new AppError('This referral link is unavailable.', 404));
  res.status(201).json({
    status: 'success',
    data: { token: created.token, expiresAt: created.attribution.expiresAt, preserved: Boolean(created.preserved) }
  });
});

const confirmServiceCompletion = catchAsync(async (req, res, next) => {
  const booking = await Booking.findById(req.params.bookingId);
  if (!booking) return next(new AppError('Booking not found', 404));
  const listing = await Listing.findById(booking.service).select('vendorId');
  if (req.user.role !== 'admin' && String(listing?.vendorId) !== String(req.user._id)) {
    return next(new AppError('Only the booked vendor or an administrator can confirm completion.', 403));
  }
  if (new Date(booking.checkOut) > new Date()) {
    return next(new AppError('Completion cannot be confirmed before the scheduled service end time.', 400));
  }
  if (!['booked', 'completed'].includes(booking.status)) {
    return next(new AppError('Only a confirmed booking can be marked complete.', 400));
  }
  if (['canceled', 'rejected'].includes(booking.status)) {
    return next(new AppError('Canceled or rejected bookings cannot be confirmed complete.', 400));
  }
  const commission = await ReferralCommission.findOne({ booking: booking._id });
  if (!commission) return next(new AppError('No referral commission is recorded for this booking.', 404));
  if (req.user.role === 'admin' && !String(req.body.reason || '').trim()) {
    return next(new AppError('An administrator reason is required.', 400));
  }
  const confirmedAt = new Date();
  commission.completionConfirmedAt = confirmedAt;
  booking.status = 'completed';
  booking.referral.completionConfirmedAt = confirmedAt;
  await booking.save();
  commission.auditTrail.push({
    action: req.user.role === 'admin' ? 'admin_completion_override' : 'vendor_completion_confirmed',
    actor: req.user._id,
    reason: String(req.body.reason || '').trim(),
    at: confirmedAt
  });
  await commission.save();
  res.status(200).json({ status: 'success', data: { completionConfirmedAt: confirmedAt, status: commission.status } });
});

const startPayoutOnboarding = catchAsync(async (req, res, next) => {
  if (!stripe) return next(new AppError('Referral payout onboarding is not configured.', 503));
  const account = await ensureAccount(req.user._id);
  const user = await User.findById(req.user._id).select('email firstName lastName countryName');
  if (!account.stripeAccountId) {
    const connected = await stripe.accounts.create(
      {
        type: 'express',
        email: user.email,
        country: 'US',
        capabilities: { transfers: { requested: true } },
        metadata: { userId: String(req.user._id), purpose: 'referral_reward_payouts' }
      },
      { idempotencyKey: `referral-account-${req.user._id}` }
    );
    account.stripeAccountId = connected.id;
  }
  account.payoutOnboardingStatus = 'pending';
  await account.save();
  const url = await createStripeOnBoardingLink({ accountId: account.stripeAccountId });
  res.status(200).json({ status: 'success', data: { url, onboardingStatus: account.payoutOnboardingStatus } });
});

const getPayoutOnboardingStatus = catchAsync(async (req, res, next) => {
  const account = await ReferralAccount.findOne({ user: req.user._id });
  if (!account?.stripeAccountId) {
    return res.status(200).json({ status: 'success', data: { onboardingStatus: 'not_started', requiredActions: [] } });
  }
  if (!stripe) return next(new AppError('Referral payout onboarding is not configured.', 503));
  const connected = await receiveAccount(account.stripeAccountId);
  if (!connected) return next(new AppError('Could not verify the connected payout account.', 502));
  const onboardingStatus = connected.payouts_enabled ? 'verified' : connected.requirements?.disabled_reason ? 'restricted' : 'pending';
  account.payoutOnboardingStatus = onboardingStatus;
  await account.save();
  res.status(200).json({
    status: 'success',
    data: {
      onboardingStatus,
      requiredActions: connected.requirements?.currently_due || [],
      payoutsEnabled: Boolean(connected.payouts_enabled)
    }
  });
});

const getAdminOverview = catchAsync(async (req, res) => {
  const [settings, accounts, attributions, commissions] = await Promise.all([
    getCurrentSettings(),
    ReferralAccount.find().select('user code referrerEnabled vendorFundingEnabled referrerConsent vendorConsent consentHistory payoutOnboardingStatus').populate('user', 'firstName lastName email role'),
    ReferralAttribution.find().populate('referrer', 'firstName lastName email').sort({ createdAt: -1 }).limit(500),
    ReferralCommission.find().populate('booking', 'bookingRef checkIn checkOut status paymentStatus inDispute').populate('referrer', 'firstName lastName email').populate('vendor', 'firstName lastName email').sort({ createdAt: -1 }).limit(500)
  ]);
  res.status(200).json({ status: 'success', data: { settings, accounts, attributions, commissions } });
});

const updateAdminSettings = catchAsync(async (req, res, next) => {
  const current = await getCurrentSettings();
  const { commissionRatePercent, minimumServiceSubtotal, attributionWindowDays, completionDelayHours, enabled, reason } = req.body;
  if (!String(reason || '').trim()) return next(new AppError('A reason is required for program setting changes.', 400));
  const nextSettings = {
    version: Number(current.version || 0) + 1,
    termsVersion: `${TERMS_VERSION}-v${Number(current.version || 0) + 1}`,
    enabled: enabled === undefined ? current.enabled : Boolean(enabled),
    commissionRatePercent: Number(commissionRatePercent ?? current.commissionRatePercent),
    minimumServiceSubtotal: Number(minimumServiceSubtotal ?? current.minimumServiceSubtotal),
    attributionWindowDays: Number(attributionWindowDays ?? current.attributionWindowDays),
    completionDelayHours: Number(completionDelayHours ?? current.completionDelayHours),
    payoutsEnabled: false,
    changedBy: req.user._id,
    changeReason: String(reason).trim()
  };
  if (nextSettings.commissionRatePercent <= 0 || nextSettings.commissionRatePercent > 25 || nextSettings.minimumServiceSubtotal < 0 || nextSettings.attributionWindowDays < 1 || nextSettings.attributionWindowDays > 90 || nextSettings.completionDelayHours < 0 || nextSettings.completionDelayHours > 720) {
    return next(new AppError('One or more referral settings are outside the allowed range.', 400));
  }
  const saved = await ReferralProgramSettings.create(nextSettings);
  res.status(201).json({ status: 'success', data: saved });
});

const reviewCommission = catchAsync(async (req, res, next) => {
  const { action, reason } = req.body;
  if (!String(reason || '').trim()) return next(new AppError('A reason is required.', 400));
  const commission = await ReferralCommission.findById(req.params.commissionId);
  if (!commission) return next(new AppError('Referral commission not found.', 404));
  const actions = { pause: 'paused', review: 'review', resolve: 'pending' };
  if (!actions[action]) return next(new AppError('Invalid review action.', 400));
  if (commission.status !== 'paid') commission.status = actions[action];
  commission.auditTrail.push({ action: `admin_${action}`, actor: req.user._id, reason: String(reason).trim() });
  await commission.save();
  res.status(200).json({ status: 'success', data: commission });
});

const exportAdminRecords = catchAsync(async (req, res) => {
  const records = await ReferralCommission.find().populate('booking', 'bookingRef').populate('referrer', 'email').populate('vendor', 'email').sort({ createdAt: -1 });
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [['bookingRef', 'referrerEmail', 'vendorEmail', 'serviceSubtotal', 'ratePercent', 'amount', 'status', 'providerTransferId', 'providerPayoutId']];
  records.forEach((item) => rows.push([
    item.booking?.bookingRef,
    item.referrer?.email,
    item.vendor?.email,
    item.serviceSubtotal,
    item.ratePercent,
    item.amount,
    item.status,
    item.providerTransferId,
    item.providerPayoutId
  ]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="gala-tab-referrals.csv"');
  res.status(200).send(rows.map((row) => row.map(quote).join(',')).join('\n'));
});

module.exports = {
  getReferralOverview,
  updateParticipation,
  createAttribution,
  confirmServiceCompletion,
  startPayoutOnboarding,
  getPayoutOnboardingStatus,
  getAdminOverview,
  updateAdminSettings,
  reviewCommission,
  exportAdminRecords,
  calculateReferralCommission
};