/**
 * One-time migration: add bookingRef to all existing bookings that don't have one.
 * Run with: node backfill-booking-refs.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');

const generateBookingRef = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `GT-${year}${month}-${suffix}`;
};

async function backfill() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const Booking = mongoose.connection.collection('bookings');

  const bookings = await Booking.find({ bookingRef: { $exists: false } }).toArray();
  console.log(`Found ${bookings.length} bookings without a ref`);

  let updated = 0;
  for (const booking of bookings) {
    let ref;
    let attempts = 0;
    // Use the booking's createdAt date for accurate year/month in the ref
    const created = booking.createdAt || new Date();
    while (attempts < 5) {
      const year = created.getFullYear();
      const month = String(created.getMonth() + 1).padStart(2, '0');
      const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
      ref = `GT-${year}${month}-${suffix}`;
      const exists = await Booking.findOne({ bookingRef: ref });
      if (!exists) break;
      attempts++;
    }

    await Booking.updateOne({ _id: booking._id }, { $set: { bookingRef: ref } });
    updated++;
  }

  console.log(`Done — updated ${updated} bookings`);
  await mongoose.disconnect();
}

backfill().catch((err) => {
  console.error(err);
  process.exit(1);
});
