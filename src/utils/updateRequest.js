const cron = require('node-cron');
const moment = require('moment');
const Booking = require('../models/Bookings');
const sendNotification = require('./storeNotification');
const Pricing = require('../models/Pricing');
const Payments = require('../models/Payment');

// ─────────────────────────────────────────────────────────────────────────────
// Booking Completion Cron  (runs every minute)
//
// When a booking's checkOut has passed and status is still 'booked':
//   1. Mark booking as 'completed'
//   2. Create/update a Payment record with escrowStatus = 'held'
//   3. Set escrowReleaseAt = checkIn + 72 hours  (Airbnb-style: 72h from booking date)
//   4. Notify vendor + customer
//
// The actual Stripe transfer is handled by PayoutCrone.js after the 72-hour
// dispute window closes — NOT here.
// ─────────────────────────────────────────────────────────────────────────────
const ESCROW_HOLD_HOURS = 72;

cron.schedule('* * * * *', async () => {
  try {
    const now = moment().utc().toDate();

    const bookings = await Booking.find({
      checkOut: { $lte: now },
      status: 'booked',
      isDeleted: false
    }).populate({
      path: 'service',
      select: 'vendorId title',
      populate: { path: 'vendorId', model: 'User' }
    });

    if (bookings.length > 0) {
      console.log('[updateRequest] Found ' + bookings.length + ' booking(s) to complete.');
    }

    for (const booking of bookings) {
      try {
        // ── 1. Calculate payout (after platform fee) ───────────────────────
        let amountAfterFee = booking.totalPrice;
        let platformFee = 0;

        if (booking.service.vendorId.customPricingPercentage) {
          platformFee = (booking.totalPrice * booking.service.vendorId.customPricingPercentage) / 100;
        } else {
          const pricing = await Pricing.findOne({});
          if (pricing) {
            platformFee = (booking.totalPrice * pricing.pricingPercentage) / 100;
          }
        }
        amountAfterFee = booking.totalPrice - platformFee;

        // ── 2. Escrow release timestamp (checkIn + 72h, Airbnb-style: window starts
        //          from the booking date, not checkout date) ─────────────────
        const escrowReleaseAt = moment(booking.checkIn)
          .add(ESCROW_HOLD_HOURS, 'hours')
          .toDate();

        // ── 3. Mark booking completed + store escrow timestamp ─────────────
        booking.status = 'completed';
        booking.escrowReleaseAt = escrowReleaseAt;
        await booking.save();

        // ── 4. Create or update escrow Payment record ──────────────────────
        const existingPayment = await Payments.findOne({ booking: booking._id.toString() });
        if (existingPayment) {
          existingPayment.escrowStatus = 'held';
          existingPayment.escrowReleaseAt = escrowReleaseAt;
          existingPayment.amount = amountAfterFee;
          existingPayment.systemFee = platformFee;
          await existingPayment.save();
        } else {
          await Payments.create({
            booking: booking._id.toString(),
            vendorId: booking.service.vendorId._id.toString(),
            amount: amountAfterFee,
            systemFee: platformFee,
            escrowStatus: 'held',
            escrowReleaseAt,
            status: 'pending'
          });
        }

        const releaseDate = moment(escrowReleaseAt).format('MMMM Do YYYY, h:mm a [UTC]');

        // ── 5. Notify vendor ───────────────────────────────────────────────
        sendNotification({
          userId: booking.service.vendorId._id,
          title: 'Booking Completed - Payout Pending',
          message:
            'Booking #' + booking._id + ' ("' + booking.service.title + '") is complete. ' +
            'Your payout of $' + Number(amountAfterFee).toFixed(2) +
            ' is held in escrow and will be released on ' + releaseDate +
            ' if no dispute is filed.',
          type: 'payout',
          fortype: 'payout',
          permission: 'bookings',
          linkUrl: '/vendor-dashboard/PayOut-Details'
        });

        // ── 6. Notify customer of 72-hour dispute window ───────────────────
        sendNotification({
          userId: booking.user,
          title: 'Booking Completed - 72-Hour Dispute Window Open',
          message:
            'Your booking #' + booking._id + ' ("' + booking.service.title + '") is complete. ' +
            'You have 72 hours (until ' + releaseDate + ') to file a dispute before funds are released to the vendor.',
          type: 'booking',
          fortype: 'booking',
          permission: 'bookings',
          linkUrl: '/user-dashboard/user-booking?tab=2'
        });

        console.log('[updateRequest] Booking ' + booking._id + ' completed. Escrow held until ' + escrowReleaseAt);
      } catch (bookingErr) {
        console.error('[updateRequest] Error processing booking ' + booking._id + ':', bookingErr);
      }
    }
  } catch (err) {
    console.error('[updateRequest] Fatal cron error:', err);
  }
});
