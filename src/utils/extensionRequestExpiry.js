const cron = require('node-cron');
const Extensionbooking = require('../models/Extensionbooking');
const sendNotification = require('./storeNotification');
const { cancelPaymentIntent } = require('./stripe-utils/customers.utils');
const { getExpiryHours } = require('./extensionPayments');

// Marks a pending change request as expired, releases any card hold and tells both people.
// The status is flipped atomically so the cron and an accept/reject click can't both act on it.
const expireExtensionRequest = async (extensionId, { reason = 'it was not answered in time' } = {}) => {
  const extension = await Extensionbooking.findOneAndUpdate(
    { _id: extensionId, request: 'pending' },
    { request: 'expired' },
    { new: true }
  );
  if (!extension) return null;

  if (extension.paymentIntentId) {
    try {
      await cancelPaymentIntent({ paymentIntentId: extension.paymentIntentId });
      extension.paymentStatus = 'released';
    } catch (err) {
      console.error('[extensionExpiry] could not release hold for', extension._id, err.message);
      extension.paymentStatus = 'failed';
    }
    await extension.save();
  }

  const released = extension.paymentStatus === 'released';
  sendNotification({
    userId: extension.customerId,
    title: 'Booking Change Request Expired',
    message: `Your booking change request was closed because ${reason}.${released ? ' The hold on your card has been released and you were not charged.' : ''} You can send a new request at any time.`,
    type: 'booking',
    fortype: 'booking_extension_rejected',
    permission: 'bookings',
    linkUrl: '/user-dashboard/user-booking?tab=5'
  });
  sendNotification({
    userId: extension.vendorId,
    title: 'Booking Change Request Expired',
    message: `A booking change request was closed because ${reason}. No changes were made to the booking.`,
    type: 'booking',
    fortype: 'booking_extension_rejected',
    permission: 'bookings',
    linkUrl: '/vendor-dashboard/extend-requests'
  });
  return extension;
};

const expireDueRequests = async () => {
  const now = new Date();
  // Requests created before expiry existed have no expiresAt; their card holds lapse at ~7 days anyway
  const legacyCutoff = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const due = await Extensionbooking.find({
    request: 'pending',
    $or: [
      { expiresAt: { $ne: null, $lte: now } },
      { expiresAt: null, createdAt: { $lte: legacyCutoff } }
    ]
  }).select('_id');
  for (const { _id } of due) {
    try {
      await expireExtensionRequest(_id);
    } catch (err) {
      console.error('[extensionExpiry] failed for', _id, err.message);
    }
  }
  return due.length;
};

cron.schedule('*/5 * * * *', async () => {
  try {
    const count = await expireDueRequests();
    if (count > 0) {
      console.log(`[extensionExpiry] processed ${count} expired request(s) (window ${getExpiryHours()}h)`);
    }
  } catch (err) {
    console.error('[extensionExpiry] job error:', err.message);
  }
});

module.exports = { expireExtensionRequest, expireDueRequests };
