const ReferralAccount = require('../models/ReferralAccount');
const ReferralAttribution = require('../models/ReferralAttribution');
const ReferralCommission = require('../models/ReferralCommission');
const ReferralInvitation = require('../models/ReferralInvitation');
const ReferralProgramSettings = require('../models/ReferralProgramSettings');
const Booking = require('../models/Bookings');
const Listing = require('../models/ServiceListing');
const User = require('../models/users/User');
const stripe = require('../config/stripe');
const { createStripeOnBoardingLink, receiveAccount } = require('../utils/stripe-utils/connect-accounts.util');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const {
  REFERRAL_RULES_MODEL,
  REFERRAL_REWARD_AMOUNT,
  MINIMUM_PLATFORM_FEE,
  calculateReferralReward
} = require('../utils/referral-program');
const { getCurrentSettings, rewardOptionsFrom } = require('../utils/referralSettings');
const { hashToken, createAttributionForCode } = require('../utils/referralAttribution');
const {
  CODE_PATTERN,
  generateInvitationCode,
  ensurePrimaryInvitation,
  createInvitation: createReferralInvitation,
  isInvitationUsable
} = require('../utils/referralInvitations');

const referralUrlFor = (code) =>
  `${String(process.env.FRONTEND_URL || '').replace(/\/+$/, '')}/?ref=${encodeURIComponent(code)}`;

const publicSettings = (settings) => ({
  termsVersion: settings.termsVersion,
  enabled: settings.enabled,
  rewardAmount: settings.rewardAmount ?? REFERRAL_REWARD_AMOUNT,
  minimumPlatformFee: settings.minimumPlatformFee ?? MINIMUM_PLATFORM_FEE,
  attributionWindowDays: settings.attributionWindowDays,
  completionDelayHours: settings.completionDelayHours
});

const ensureAccount = async (userId) => {
  let account = await ReferralAccount.findOne({ user: userId });
  if (account) return account;

  const user = await User.findById(userId).select('_id role');
  if (!user) throw new AppError('User not found', 404);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      account = await ReferralAccount.create({ user: userId, code: generateInvitationCode() });
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

const canShareInvitations = (account, settings) =>
  Boolean(account?.referrerEnabled && settings.enabled && account.referrerConsent?.termsVersion === settings.termsVersion);

const getReferralOverview = catchAsync(async (req, res) => {
  const [account, settings] = await Promise.all([
    ReferralAccount.findOne({ user: req.user._id }),
    getCurrentSettings()
  ]);
  const rewardOptions = rewardOptionsFrom(settings);
  const shareable = canShareInvitations(account, settings);

  const [invitations, records, referredBookingCount] = await Promise.all([
    account
      ? ensurePrimaryInvitation(account).then(() => ReferralInvitation.find({ referrer: req.user._id }).sort({ createdAt: 1 }))
      : [],
    ReferralCommission.find({ referrer: req.user._id })
      .select('booking amount status createdAt updatedAt providerPayoutId providerTransferId recoverableAmount invitation canceledInvitation')
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
    amount: record.amount,
    status: record.status,
    updatedAt: record.updatedAt,
    payoutReference: record.providerTransferId || record.providerPayoutId || null,
    recoverableAmount: record.recoverableAmount
  }));

  const invitationList = invitations.map((invitation) => ({
    id: invitation._id,
    code: invitation.code,
    label: invitation.label,
    status: invitation.status,
    createdAt: invitation.createdAt,
    url: shareable && invitation.status === 'active' ? referralUrlFor(invitation.code) : null
  }));
  const firstActive = invitationList.find((invitation) => invitation.url);

  res.status(200).json({
    status: 'success',
    data: {
      enrolled: Boolean(account?.referrerEnabled),
      referrerNeedsConsent: Boolean(account?.referrerEnabled && account.referrerConsent?.termsVersion !== settings.termsVersion),
      code: firstActive?.code || null,
      referralUrl: firstActive?.url || null,
      invitations: invitationList,
      payoutOnboardingStatus: account?.payoutOnboardingStatus || 'not_started',
      currentSettings: publicSettings(settings),
      examples: [499, 500, 800].map((platformFee) => ({
        platformFee,
        reward: calculateReferralReward(platformFee, rewardOptions)
      })),
      summary
    }
  });
});

const updateParticipation = catchAsync(async (req, res, next) => {
  const { referrerEnabled, acceptReferrerTerms } = req.body;
  if (referrerEnabled !== undefined && typeof referrerEnabled !== 'boolean') {
    return next(new AppError('Participation settings must be boolean values.', 400));
  }
  const settings = await getCurrentSettings();
  if (!settings.enabled && referrerEnabled) {
    return next(new AppError('The referral program is not accepting new participants.', 403));
  }
  if (referrerEnabled === undefined) return next(new AppError('referrerEnabled is required.', 400));
  if (referrerEnabled && acceptReferrerTerms !== true) {
    return next(new AppError('Accept the referral terms before enrolling.', 400));
  }

  const account = await ensureAccount(req.user._id);
  account.referrerEnabled = referrerEnabled;
  if (referrerEnabled) {
    account.referrerConsent = { acceptedAt: new Date(), termsVersion: settings.termsVersion };
  }
  account.consentHistory.push({
    participantType: 'referrer',
    enabled: referrerEnabled,
    acceptedAt: new Date(),
    termsVersion: referrerEnabled ? settings.termsVersion : account.referrerConsent?.termsVersion
  });
  await account.save();
  res.status(200).json({ status: 'success', data: account });
});

const createInvitation = catchAsync(async (req, res, next) => {
  const [account, settings] = await Promise.all([
    ReferralAccount.findOne({ user: req.user._id }),
    getCurrentSettings()
  ]);
  if (!canShareInvitations(account, settings)) {
    return next(new AppError('Join the referral program and accept the current terms to create invitations.', 403));
  }
  let invitation;
  try {
    invitation = await createReferralInvitation({ account, label: req.body.label });
  } catch (error) {
    return next(error.statusCode ? new AppError(error.message, error.statusCode) : error);
  }
  res.status(201).json({
    status: 'success',
    data: { id: invitation._id, code: invitation.code, label: invitation.label, status: invitation.status, url: referralUrlFor(invitation.code) }
  });
});

const revokeInvitation = catchAsync(async (req, res, next) => {
  const invitation = await ReferralInvitation.findOneAndUpdate(
    { _id: req.params.invitationId, referrer: req.user._id, status: 'active' },
    { $set: { status: 'revoked' } },
    { new: true }
  );
  if (!invitation) return next(new AppError('Only your unused invitations can be revoked.', 404));
  res.status(200).json({ status: 'success', data: { id: invitation._id, status: invitation.status } });
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
      const invitation = existing.invitation ? await ReferralInvitation.findById(existing.invitation) : null;
      if (!invitation || isInvitationUsable(invitation, req.user?._id)) {
        return res.status(200).json({ status: 'success', data: { token: existingToken, expiresAt: existing.expiresAt, preserved: true } });
      }
    }
  }
  if (typeof code !== 'string' || !CODE_PATTERN.test(code.trim().toUpperCase())) {
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
  const commission = await ReferralCommission.findOne({ booking: booking._id });
  if (!commission) return next(new AppError('No referral reward is recorded for this booking.', 404));
  if (commission.status === 'canceled') return next(new AppError('The referral reward for this booking was canceled.', 400));
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
  const [settings, accounts, invitations, attributions, commissions] = await Promise.all([
    getCurrentSettings(),
    ReferralAccount.find().select('user code referrerEnabled referrerConsent consentHistory payoutOnboardingStatus').populate('user', 'firstName lastName email role'),
    ReferralInvitation.find().populate('referrer', 'firstName lastName email').sort({ createdAt: -1 }).limit(500),
    ReferralAttribution.find().populate('referrer', 'firstName lastName email').sort({ createdAt: -1 }).limit(500),
    ReferralCommission.find().populate('booking', 'bookingRef checkIn checkOut status paymentStatus inDispute').populate('referrer', 'firstName lastName email').populate('vendor', 'firstName lastName email').sort({ createdAt: -1 }).limit(500)
  ]);
  res.status(200).json({
    status: 'success',
    data: { settings: { ...publicSettings(settings), payoutsEnabled: Boolean(settings.payoutsEnabled), version: settings.version }, accounts, invitations, attributions, commissions }
  });
});

// The reward amount and the platform-fee minimum are fixed program rules, so
// administrators can only change the operating settings below.
const updateAdminSettings = catchAsync(async (req, res, next) => {
  const current = await getCurrentSettings();
  const { attributionWindowDays, completionDelayHours, enabled, payoutsEnabled, reason } = req.body;
  if (!String(reason || '').trim()) return next(new AppError('A reason is required for program setting changes.', 400));
  if ((enabled !== undefined && typeof enabled !== 'boolean') || (payoutsEnabled !== undefined && typeof payoutsEnabled !== 'boolean')) {
    return next(new AppError('Enabled settings must be boolean values.', 400));
  }
  const nextSettings = {
    version: Number(current.version || 0) + 1,
    termsVersion: current.termsVersion,
    enabled: enabled === undefined ? current.enabled : enabled,
    rulesModel: REFERRAL_RULES_MODEL,
    rewardAmount: REFERRAL_REWARD_AMOUNT,
    minimumPlatformFee: MINIMUM_PLATFORM_FEE,
    attributionWindowDays: Number(attributionWindowDays ?? current.attributionWindowDays),
    completionDelayHours: Number(completionDelayHours ?? current.completionDelayHours),
    payoutsEnabled: payoutsEnabled === undefined ? Boolean(current.payoutsEnabled) : payoutsEnabled,
    changedBy: req.user._id,
    changeReason: String(reason).trim()
  };
  if (!Number.isFinite(nextSettings.attributionWindowDays) || nextSettings.attributionWindowDays < 1 || nextSettings.attributionWindowDays > 90 ||
      !Number.isFinite(nextSettings.completionDelayHours) || nextSettings.completionDelayHours < 0 || nextSettings.completionDelayHours > 720) {
    return next(new AppError('One or more referral settings are outside the allowed range.', 400));
  }
  const saved = await ReferralProgramSettings.create(nextSettings);
  res.status(201).json({ status: 'success', data: saved });
});

const reviewCommission = catchAsync(async (req, res, next) => {
  const { action, reason } = req.body;
  if (!String(reason || '').trim()) return next(new AppError('A reason is required.', 400));
  const commission = await ReferralCommission.findById(req.params.commissionId);
  if (!commission) return next(new AppError('Referral reward not found.', 404));
  const actions = { pause: 'paused', review: 'review', resolve: 'pending' };
  if (!actions[action]) return next(new AppError('Invalid review action.', 400));
  if (!['paid', 'canceled', 'processing'].includes(commission.status)) commission.status = actions[action];
  commission.auditTrail.push({ action: `admin_${action}`, actor: req.user._id, reason: String(reason).trim() });
  await commission.save();
  res.status(200).json({ status: 'success', data: commission });
});

// Spreadsheet applications run cells that start with these characters as formulas.
const csvCell = (value) => {
  const text = String(value ?? '');
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};

const exportAdminRecords = catchAsync(async (req, res) => {
  const records = await ReferralCommission.find().populate('booking', 'bookingRef').populate('referrer', 'email').sort({ createdAt: -1 });
  const rows = [['bookingRef', 'referrerEmail', 'bookingTotal', 'platformFeeAmount', 'retainedPlatformFee', 'rewardAmount', 'status', 'providerTransferId']];
  records.forEach((item) => rows.push([
    item.booking?.bookingRef,
    item.referrer?.email,
    item.bookingTotal,
    item.platformFeeAmount,
    item.retainedPlatformFee,
    item.amount,
    item.status,
    item.providerTransferId
  ]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="gala-tab-referrals.csv"');
  res.status(200).send(rows.map((row) => row.map(csvCell).join(',')).join('\n'));
});

module.exports = {
  getReferralOverview,
  updateParticipation,
  createInvitation,
  revokeInvitation,
  createAttribution,
  confirmServiceCompletion,
  startPayoutOnboarding,
  getPayoutOnboardingStatus,
  getAdminOverview,
  updateAdminSettings,
  reviewCommission,
  exportAdminRecords
};
