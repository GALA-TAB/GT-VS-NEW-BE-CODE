const stripe = require('../config/stripe');
const Vendor = require('../models/users/Vendor');
const Booking = require('../models/Bookings');
const Payments = require('../models/Payment');
const User = require('../models/users/User');
const sendNotification = require('../utils/storeNotification');
const catchAsync = require('../utils/catchAsync');
const StripeWebhookEvent = require('../models/StripeWebhookEvent');
const ReferralAccount = require('../models/ReferralAccount');
const ReferralCommission = require('../models/ReferralCommission');
const { applyRefundToReferralReward } = require('../utils/referralRewards');

// Stripe Webhook Controller
exports.stripeWebhook = catchAsync(async (req, res, next) => {
  if (!stripe) {
    return res.status(503).json({
      status: 'fail',
      message: 'Stripe is not configured on this environment.'
    });
  }

  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  let eventRecord = await StripeWebhookEvent.findOne({ eventId: event.id });
  if (eventRecord?.status === 'processed') return res.status(200).send();
  let claimed = false;
  if (!eventRecord) {
    try {
      eventRecord = await StripeWebhookEvent.create({ eventId: event.id, eventType: event.type, status: 'processing' });
      claimed = true;
    } catch (error) {
      if (error.code !== 11000) throw error;
      eventRecord = await StripeWebhookEvent.findOne({ eventId: event.id });
    }
  }
  if (!claimed && eventRecord?.status !== 'processed') {
    eventRecord = await StripeWebhookEvent.findOneAndUpdate(
      {
        eventId: event.id,
        $or: [
          { status: 'failed' },
          { status: 'processing', processingStartedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }
        ]
      },
      { $set: { status: 'processing', processingStartedAt: new Date(), failureReason: '' } },
      { new: true }
    );
    claimed = Boolean(eventRecord);
  }
  if (!claimed) return res.status(500).send('Webhook event is already being processed; retry later.');

  try {
    switch (event.type) {

    case "account.updated": {
      const account = event.data.object;
      const stripeId = account.id;
      const stripeRecord = await Vendor.findOne({ stripeAccountId: stripeId });
      const referralRecord = await ReferralAccount.findOne({ stripeAccountId: stripeId });
      if (referralRecord) {
        referralRecord.payoutOnboardingStatus = account.payouts_enabled ? 'verified' : account.requirements?.disabled_reason ? 'restricted' : 'pending';
        await referralRecord.save();
      }

      if (!stripeRecord) break;

      // Check if account is fully onboarded and can accept payments
      let status  ;
      if (account?.charges_enabled && account.details_submitted) {
        status = "active";
      } else {
        status = "inactive";
      }

      await Vendor.findOneAndUpdate(
        { stripeAccountId: stripeId },
        { accountStatus: status },
        { new: true }
      );
      console.log(`✅ Account status updated for Stripe ID: ${stripeId}`);
      console.log(`Current status: ${status}`);

      break;
    }

    case "account.application.authorized": {
      const account = event.data.object;
      console.log(`🔓 Application authorized for connected account: ${account.id}`);
      break;
    }

    case "account.application.deauthorized": {
      const account = event.data.object;
      console.log(`🚫 Application deauthorized for connected account: ${account.id}`);
      break;
    }

    // ── Stripe-initiated dispute (chargeback) ──────────────────────────────
    case "charge.dispute.created": {
      const dispute = event.data.object;
      const chargeId = dispute.charge;

      const payment = await Payments.findOne({ stripeChargeId: chargeId });
      if (payment) {
        payment.escrowStatus = 'disputed';
        await payment.save();
        await ReferralCommission.updateOne(
          { booking: payment.booking, status: { $nin: ['paid', 'canceled'] } },
          { $set: { status: 'paused' }, $push: { auditTrail: { action: 'dispute_opened', metadata: { chargeId, disputeId: dispute.id } } } }
        );

        const booking = await Booking.findById(payment.booking);
        if (booking) {
          booking.inDispute = true;
          booking.disputeReason = 'Stripe chargeback: ' + (dispute.reason || 'unspecified');
          booking.disputeFiledAt = new Date();
          await booking.save();
        }

        // Alert admins
        const admins = await User.find({ role: 'admin' });
        for (const admin of admins) {
          sendNotification({
            userId: admin._id,
            title: 'Stripe Chargeback Filed',
            message: 'A Stripe chargeback has been filed for booking #' + payment.booking + '. Reason: ' + (dispute.reason || 'unspecified') + '. Delayed payout held pending review.',
            type: 'dispute',
            fortype: 'dispute',
            permission: 'bookings',
            linkUrl: '/admin-dashboard/disputes'
          });
        }
        console.log('[webhook] charge.dispute.created — escrow held for charge', chargeId);
      }
      break;
    }

    case "charge.dispute.closed": {
      const dispute = event.data.object;
      const chargeId = dispute.charge;

      const payment = await Payments.findOne({ stripeChargeId: chargeId });
      if (payment) {
        const booking = await Booking.findById(payment.booking).populate({
          path: 'service',
          select: 'vendorId',
          populate: { path: 'vendorId', model: 'User' }
        });

        if (dispute.status === 'lost') {
          // Customer won — funds already refunded by Stripe
          payment.escrowStatus = 'refunded';
          payment.status = 'completed';
          if (booking) {
            booking.inDispute = false;
            booking.disputeResolvedAt = new Date();
            booking.disputeResolution = 'refunded';
            await booking.save();
          }
        } else {
          // Merchant won — release to vendor
          payment.escrowStatus = 'released';
          payment.status = 'completed';
          if (booking) {
            booking.inDispute = false;
            booking.disputeResolvedAt = new Date();
            booking.disputeResolution = 'released';
            booking.paymentStatus = true;
            await booking.save();
          }
          sendNotification({
            userId: booking?.service?.vendorId?._id,
            title: 'Dispute Resolved – Payout Released',
            message: 'The chargeback dispute for booking #' + payment.booking + ' was resolved in your favour. Funds have been released.',
            type: 'payout',
            fortype: 'payout',
            permission: 'bookings',
            linkUrl: '/vendor-dashboard/PayOut-Details'
          });
        }
        await payment.save();
        if (dispute.status === 'lost') {
          // The customer won the chargeback, so the booking fee is gone with the charge.
          if (booking?.referral?.eligibility) {
            await applyRefundToReferralReward({
              booking,
              fullRefund: true,
              bookingCanceled: true,
              source: 'chargeback_lost',
              metadata: { disputeId: dispute.id }
            });
          }
        } else {
          await ReferralCommission.updateOne(
            { booking: payment.booking, status: 'paused' },
            { $set: { status: 'pending' }, $push: { auditTrail: { action: 'dispute_closed', metadata: { disputeId: dispute.id, resolution: dispute.status } } } }
          );
        }
        console.log('[webhook] charge.dispute.closed — status:', dispute.status, '— charge:', chargeId);
      }
      break;
    }

    // ── Store chargeId when a payment intent succeeds ──────────────────────
    case "payment_intent.succeeded": {
      const pi = event.data.object;
      const latestCharge = pi.latest_charge;
      if (latestCharge && pi.metadata?.bookingId) {
        const payment = await Payments.findOne({ booking: pi.metadata.bookingId });
        if (payment && !payment.stripeChargeId) {
          payment.stripeChargeId = latestCharge;
          await payment.save();
          console.log('[webhook] payment_intent.succeeded — stored chargeId', latestCharge, 'for booking', pi.metadata.bookingId);
        }
      }
      break;
    }

    // Refunds made outside the app (e.g. the Stripe dashboard) still reduce the fee Gala Tab retains.
    case "charge.refunded": {
      const charge = event.data.object;
      const payment = await Payments.findOne({ stripeChargeId: charge.id });
      const booking = payment ? await Booking.findById(payment.booking) : null;
      if (booking?.referral?.eligibility) {
        await applyRefundToReferralReward({
          booking,
          refundedTotal: Number(charge.amount_refunded || 0) / 100,
          fullRefund: Boolean(charge.refunded),
          source: 'stripe_refund',
          metadata: { chargeId: charge.id }
        });
      }
      break;
    }

      default:
        console.log(`Unhandled event type ${event.type}`);
    }
    await StripeWebhookEvent.updateOne(
      { eventId: event.id, status: 'processing' },
      { $set: { status: 'processed', processedAt: new Date(), failureReason: '' } }
    );
    return res.status(200).send();
  } catch (error) {
    await StripeWebhookEvent.updateOne(
      { eventId: event.id },
      { $set: { status: 'failed', failureReason: String(error.message || error).slice(0, 500) } }
    );
    return next(error);
  }
});

