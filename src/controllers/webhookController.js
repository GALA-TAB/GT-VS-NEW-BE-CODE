const stripe = require('../config/stripe');
const Vendor = require('../models/users/Vendor');
const Booking = require('../models/Bookings');
const Payments = require('../models/Payment');
const User = require('../models/users/User');
const sendNotification = require('../utils/storeNotification');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

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
  console.log("webhook triggered");
  console.log("event.type", event?.type);
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {

    case "account.updated": {
      const account = event.data.object;
      const stripeId = account.id;
      const stripeRecord = await Vendor.findOne({ stripeAccountId: stripeId });

      if (!stripeRecord) {
        return next(new AppError(`No Stripe account found with ID ${stripeId}`, 404));
      }

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

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.status(200).send();
});

