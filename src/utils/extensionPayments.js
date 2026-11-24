const stripe = require('../config/stripe');
const Extensionbooking = require('../models/Extensionbooking');

const toCents = (dollars) => Math.round(Number(dollars) * 100);

// How long a change request may stay pending before it expires and any card hold is released.
// Stripe card holds lapse after about 7 days, so keep this well below that.
const getExpiryHours = () => {
  const hours = Number(process.env.EXTENSION_REQUEST_EXPIRY_HOURS);
  return Number.isFinite(hours) && hours > 0 ? Math.min(hours, 96) : 24;
};

const buildExpiresAt = (now = new Date()) => new Date(now.getTime() + getExpiryHours() * 3600 * 1000);

// 0 disables the rule. Otherwise changes are blocked when check-in is closer than this many hours.
const getMinHoursBeforeCheckIn = () => {
  const hours = Number(process.env.EXTENSION_MIN_HOURS_BEFORE_CHECKIN);
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
};

const isExpired = (extension, now = new Date()) =>
  Boolean(extension?.expiresAt) && new Date(extension.expiresAt).getTime() <= now.getTime();

// Splits the price change into what to charge and what to give back (both in dollars, 2 decimals).
const planExtensionPayment = (previousPrice, currentPrice) => {
  const diffCents = toCents(currentPrice) - toCents(previousPrice);
  return {
    chargeAmount: diffCents > 0 ? diffCents / 100 : 0,
    refundAmount: diffCents < 0 ? -diffCents / 100 : 0
  };
};

// A manual-capture intent is usable once it is held; an automatic one once it has succeeded.
const isIntentUsable = (paymentIntent) =>
  Boolean(paymentIntent) && ['requires_capture', 'succeeded'].includes(paymentIntent.status);

const describePaymentError = (err) => {
  const raw = String(err?.message || err || '');
  if (/authentication|requires_action|3d/i.test(raw)) {
    return 'Your card needs extra verification for this payment. Please use a different card or contact your bank.';
  }
  if (/declin|insufficient|card_declined/i.test(raw)) {
    return 'Your card was declined. Please update your payment method and try again.';
  }
  if (/payment_method|customer/i.test(raw) && /no such|missing|required|invalid/i.test(raw)) {
    return 'No valid payment method is saved on your account. Please add a card and try again.';
  }
  return 'We could not process the payment for this change. Please check your card and try again.';
};

// Payment intents that can return money for a booking: the original payment first, then accepted
// extensions (newest first). Only intents that were actually charged are returned.
const getRefundableIntents = async (booking) => {
  if (!stripe) return [];
  const accepted = await Extensionbooking.find({
    bookingId: booking._id,
    request: 'accept',
    paymentIntentId: { $exists: true, $ne: null }
  }).sort({ createdAt: -1 });

  const ids = [booking.paymentIntentId, ...accepted.map((e) => e.paymentIntentId)].filter(Boolean);
  const intents = [];
  for (const id of [...new Set(ids)]) {
    try {
      const intent = await stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
      if (intent.status !== 'succeeded') continue;
      const refunded = Number(intent.latest_charge?.amount_refunded || 0);
      const refundable = Number(intent.amount_received || 0) - refunded;
      if (refundable > 0) intents.push({ id, refundable });
    } catch (err) {
      console.error('[extensionPayments] could not read payment intent', id, err.message);
    }
  }
  return intents;
};

const getRefundableCents = async (booking) =>
  (await getRefundableIntents(booking)).reduce((sum, intent) => sum + intent.refundable, 0);

// Refunds amountCents across the booking's payments. Throws if the full amount can't be returned.
const refundBookingAmount = async (booking, amountCents, metadata = {}) => {
  const intents = await getRefundableIntents(booking);
  const capacity = intents.reduce((sum, intent) => sum + intent.refundable, 0);
  if (capacity < amountCents) {
    throw new Error('Not enough refundable payment on this booking');
  }

  let remaining = amountCents;
  const refunds = [];
  for (const intent of intents) {
    if (remaining <= 0) break;
    const portion = Math.min(remaining, intent.refundable);
    // The key makes a retry after a partial failure return the refund already made instead of repeating it
    const refund = await stripe.refunds.create(
      { payment_intent: intent.id, amount: portion, metadata },
      metadata.extensionRequestId
        ? { idempotencyKey: `extension-${metadata.extensionRequestId}-refund-${intent.id}` }
        : undefined
    );
    refunds.push(refund);
    remaining -= portion;
  }
  return refunds;
};

module.exports = {
  toCents,
  getExpiryHours,
  buildExpiresAt,
  getMinHoursBeforeCheckIn,
  isExpired,
  planExtensionPayment,
  isIntentUsable,
  describePaymentError,
  getRefundableCents,
  refundBookingAmount
};
