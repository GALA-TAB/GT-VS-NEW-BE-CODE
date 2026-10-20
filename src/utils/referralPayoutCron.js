const cron = require('node-cron');
const ReferralCommission = require('../models/ReferralCommission');
const ReferralProgramSettings = require('../models/ReferralProgramSettings');
const ReferralAccount = require('../models/ReferralAccount');
const Booking = require('../models/Bookings');
const Listing = require('../models/ServiceListing');
const { evaluateReferralPayoutEligibility } = require('./referral-program');

const DEFAULT_SETTINGS = { completionDelayHours: 48, payoutsEnabled: false };

const referralPayoutCron = cron.schedule('* * * * *', async () => {
  try {
    const settings = (await ReferralProgramSettings.findOne().sort({ version: -1 })) || DEFAULT_SETTINGS;
    const commissionBookings = await Booking.find({
      'referral.eligibility': 'eligible',
      'referral.commissionAmount': { $gt: 0 }
    }).select('service referral paymentIntentId user');
    for (const booking of commissionBookings) {
      if (await ReferralCommission.exists({ booking: booking._id })) continue;
      const listing = await Listing.findById(booking.service).select('vendorId');
      if (!listing) continue;
      const referrerAccount = await ReferralAccount.findOne({ user: booking.referral.referrer });
      try {
        await ReferralCommission.create({
          booking: booking._id,
          attribution: booking.referral.attribution,
          referrer: booking.referral.referrer,
          vendor: listing.vendorId,
          paymentIntentIds: booking.paymentIntentId ? [booking.paymentIntentId] : [],
          serviceSubtotal: booking.referral.serviceSubtotal,
          remainingServiceSubtotal: booking.referral.serviceSubtotal,
          ratePercent: booking.referral.ratePercent,
          minimumServiceSubtotal: booking.referral.minimumServiceSubtotal,
          completionDelayHours: booking.referral.completionDelayHours,
          amount: booking.referral.commissionAmount,
          payoutOnboardingRequired: referrerAccount?.payoutOnboardingStatus !== 'verified',
          auditTrail: [{ action: 'ledger_reconciled_from_booking_snapshot' }]
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
    const candidates = await ReferralCommission.find({ status: { $in: ['pending', 'failed'] } }).limit(100);

    for (const commission of candidates) {
      try {
        const booking = await Booking.findById(commission.booking);
        if (!booking) continue;
        const payoutAccount = await ReferralAccount.findOne({ user: commission.referrer });
        const eligibility = evaluateReferralPayoutEligibility({
          booking,
          commission,
          settings,
          payoutAccount,
        });
        if (!eligibility.eligible) {
          if (eligibility.reason === 'booking_canceled') {
            commission.status = 'canceled';
            commission.auditTrail.push({ action: 'booking_canceled', metadata: { bookingStatus: booking.status } });
            await commission.save();
          }
          continue;
        }

        commission.status = 'eligible';
        commission.eligibleAt = eligibility.eligibleAt;
        commission.payoutOnboardingRequired = false;
        commission.auditTrail.push({ action: 'payout_eligibility_confirmed', metadata: { eligibleAt: eligibility.eligibleAt } });
        await commission.save();
      } catch (error) {
        console.error('[referralPayoutCron] Commission eligibility check failed:', commission._id, error.message);
      }
    }
  } catch (error) {
    console.error('[referralPayoutCron] Eligibility scan failed:', error.message);
  }
});

module.exports = referralPayoutCron;