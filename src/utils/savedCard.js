const stripe = require('../config/stripe');

// Wallet and shared-cart bookings send placeholder text instead of a Stripe id, so only real
// payment method ids may ever be stored or charged.
const isStripePaymentMethodId = (value) => typeof value === 'string' && /^pm_[A-Za-z0-9_]+$/.test(value);

const toCardSummary = (paymentMethod) => {
  const card = paymentMethod?.card;
  if (!card) return null;
  return {
    id: paymentMethod.id,
    brand: card.brand,
    last4: card.last4,
    expMonth: card.exp_month,
    expYear: card.exp_year
  };
};

// The card to reuse for a booking change: the one stored on the customer, otherwise the default
// card on their Stripe customer. Returns null when nothing usable is attached.
const getSavedCard = async (user) => {
  if (!stripe || !user?.stripeCustomerId) return null;

  const candidates = [];
  if (isStripePaymentMethodId(user.paymentMethodid)) candidates.push(user.paymentMethodid);
  try {
    const customer = await stripe.customers.retrieve(user.stripeCustomerId);
    const fallback = customer?.deleted ? null : customer?.invoice_settings?.default_payment_method;
    if (isStripePaymentMethodId(fallback)) candidates.push(fallback);
  } catch (err) {
    console.error('[savedCard] could not read Stripe customer:', err.message);
  }

  for (const id of [...new Set(candidates)]) {
    try {
      const paymentMethod = await stripe.paymentMethods.retrieve(id);
      if (paymentMethod.customer === user.stripeCustomerId && paymentMethod.type === 'card') {
        return toCardSummary(paymentMethod);
      }
    } catch (err) {
      console.error('[savedCard] saved payment method is not usable:', id, err.message);
    }
  }
  return null;
};

// Removes a card from the customer in Stripe, but only if it really belongs to them.
const forgetCard = async (user, paymentMethodId) => {
  if (!stripe || !user?.stripeCustomerId || !isStripePaymentMethodId(paymentMethodId)) return false;
  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (paymentMethod.customer !== user.stripeCustomerId) return false;
  await stripe.paymentMethods.detach(paymentMethodId);
  return true;
};

module.exports = { isStripePaymentMethodId, toCardSummary, getSavedCard, forgetCard };
