const test = require('node:test');
const assert = require('node:assert/strict');

const stripePath = require.resolve('../config/stripe');
const savedCardPath = require.resolve('./savedCard');

const loadWithStripe = (fake) => {
  require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: fake };
  delete require.cache[savedCardPath];
  return require('./savedCard');
};

const visa = (id, customer) => ({
  id,
  customer,
  type: 'card',
  card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 }
});

test('only real Stripe payment method ids count as cards', () => {
  const { isStripePaymentMethodId } = loadWithStripe(null);
  assert.equal(isStripePaymentMethodId('pm_1Abc23'), true);
  assert.equal(isStripePaymentMethodId('wallet_payment'), false);
  assert.equal(isStripePaymentMethodId('shared_cart_payment'), false);
  assert.equal(isStripePaymentMethodId(undefined), false);
});

test('the stored card is returned as a safe summary', async () => {
  const { getSavedCard } = loadWithStripe({
    customers: { retrieve: async () => ({ invoice_settings: {} }) },
    paymentMethods: { retrieve: async (id) => visa(id, 'cus_1') }
  });
  const card = await getSavedCard({ stripeCustomerId: 'cus_1', paymentMethodid: 'pm_1' });
  assert.deepEqual(card, { id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 });
});

test('a placeholder left by a wallet booking falls back to the default card', async () => {
  const { getSavedCard } = loadWithStripe({
    customers: { retrieve: async () => ({ invoice_settings: { default_payment_method: 'pm_default' } }) },
    paymentMethods: { retrieve: async (id) => visa(id, 'cus_1') }
  });
  const card = await getSavedCard({ stripeCustomerId: 'cus_1', paymentMethodid: 'wallet_payment' });
  assert.equal(card.id, 'pm_default');
});

test('no card is returned when none is usable or it belongs to someone else', async () => {
  const { getSavedCard } = loadWithStripe({
    customers: { retrieve: async () => ({ invoice_settings: {} }) },
    paymentMethods: { retrieve: async (id) => visa(id, 'cus_other') }
  });
  assert.equal(await getSavedCard({ stripeCustomerId: 'cus_1', paymentMethodid: 'pm_1' }), null);
  assert.equal(await getSavedCard({ paymentMethodid: 'pm_1' }), null);
});

test('forgetting a card never detaches one that is not the customer’s', async () => {
  const detached = [];
  const { forgetCard } = loadWithStripe({
    paymentMethods: {
      retrieve: async (id) => visa(id, id === 'pm_mine' ? 'cus_1' : 'cus_other'),
      detach: async (id) => detached.push(id)
    }
  });
  assert.equal(await forgetCard({ stripeCustomerId: 'cus_1' }, 'pm_theirs'), false);
  assert.equal(await forgetCard({ stripeCustomerId: 'cus_1' }, 'pm_mine'), true);
  assert.deepEqual(detached, ['pm_mine']);
});
