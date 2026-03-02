const cron = require('node-cron');
const moment = require('moment');
const Payments = require('../models/Payment');
const Booking = require('../models/Bookings');
const { maintoConnect } = require('./stripe-utils/stripe-transfer.util');
const { receiveAccount } = require('./stripe-utils/connect-accounts.util');
const sendNotification = require('./storeNotification');

// ─────────────────────────────────────────────────────────────────────────────
// Escrow Release Cron  (runs every minute)
//
// Releases held escrow payments to vendors when ALL of the following are true:
//   1. escrowStatus == 'held'
//   2. escrowReleaseAt <= now   (72-hour window has passed)
//   3. booking.inDispute == false
//
// If a dispute is active the payment stays 'held' until an admin resolves it.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const now = moment().utc().toDate();

    const eligiblePayments = await Payments.find({
      escrowStatus: 'held',
      escrowReleaseAt: { $lte: now }
    }).populate([
      { path: 'vendorId', model: 'User' },
      {
        path: 'booking',
        model: 'Booking',
        populate: { path: 'service', select: 'title' }
      }
    ]);

    if (eligiblePayments.length > 0) {
      console.log('[PayoutCrone] Found ' + eligiblePayments.length + ' escrow payment(s) eligible for release.');
    }

    for (const payment of eligiblePayments) {
      try {
        // Reload booking to get fresh inDispute flag
        const booking = await Booking.findById(payment.booking?._id);
        if (!booking) {
          console.log('[PayoutCrone] Booking not found for payment ' + payment._id + ', skipping.');
          continue;
        }

        if (booking.inDispute) {
          console.log('[PayoutCrone] Booking ' + booking._id + ' is in dispute - escrow remains held.');
          continue;
        }

        if (!payment.vendorId?.stripeAccountId) {
          console.log('[PayoutCrone] Vendor ' + payment.vendorId?._id + ' has no Stripe account - skipping.');
          continue;
        }

        const account = await receiveAccount(payment.vendorId.stripeAccountId);
        if (!account?.charges_enabled && !account?.payouts_enabled) {
          console.log('[PayoutCrone] Vendor ' + payment.vendorId._id + ' Stripe account not enabled - skipping.');
          continue;
        }

        const amountInCents = Math.round(payment.amount * 100);
        const transfer = await maintoConnect({
          vendor: payment.vendorId,
          amountInCents
        });

        if (transfer) {
          payment.escrowStatus = 'released';
          payment.stripeTransferId = transfer.id || null;
          payment.status = 'completed';
          await payment.save();

          booking.paymentStatus = true;
          await booking.save();

          sendNotification({
            userId: payment.vendorId._id,
            title: 'Payout Released',
            message:
              'Your payout of $' + Number(payment.amount).toFixed(2) +
              ' for booking #' + booking._id +
              ' ("' + (payment.booking?.service?.title || '') + '") has been released to your Stripe account.',
            type: 'payout',
            fortype: 'payout',
            permission: 'bookings',
            linkUrl: '/vendor-dashboard/PayOut-Details'
          });

          console.log('[PayoutCrone] Released payment ' + payment._id + ' to vendor ' + payment.vendorId._id + '. Transfer: ' + transfer.id);
        }
      } catch (paymentErr) {
        console.error('[PayoutCrone] Error releasing payment ' + payment._id + ':', paymentErr);
      }
    }
  } catch (err) {
    console.error('[PayoutCrone] Fatal cron error:', err);
  }
});
