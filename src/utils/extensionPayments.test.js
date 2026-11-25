const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planExtensionPayment,
  validateChangeWindow,
  getTaxRate,
  isExpired,
  isIntentUsable,
  describePaymentError,
  buildExpiresAt,
  getExpiryHours
} = require('./extensionPayments');

test('charges only the increase and avoids floating point drift', () => {
  const plan = planExtensionPayment(100.1, 250.3);
  assert.equal(plan.chargeAmount, 150.2);
  assert.equal(plan.refundAmount, 0);
});

test('adds the booking tax to a charge and returns it with a refund', () => {
  assert.deepEqual(planExtensionPayment(100, 200, 8.875), {
    chargeAmount: 108.88,
    refundAmount: 0,
    taxAmount: 8.88,
    taxRate: 8.875,
    deltaBase: 100,
    deltaTotal: 108.88
  });
  assert.deepEqual(planExtensionPayment(200, 150, 8.875), {
    chargeAmount: 0,
    refundAmount: 54.44,
    taxAmount: 4.44,
    taxRate: 8.875,
    deltaBase: -50,
    deltaTotal: -54.44
  });
});

test('untaxed bookings are not taxed on a change', () => {
  assert.equal(getTaxRate({ taxRate: 0 }), 0);
  assert.equal(getTaxRate({}), 0);
  assert.equal(getTaxRate({ taxRate: 8.875 }), 8.875);
  assert.equal(planExtensionPayment(100, 150, getTaxRate({})).chargeAmount, 50);
});

test('refunds a decrease and charges nothing', () => {
  const plan = planExtensionPayment(300, 275.5);
  assert.equal(plan.chargeAmount, 0);
  assert.equal(plan.refundAmount, 24.5);
});

test('moves no money when the price is unchanged', () => {
  const plan = planExtensionPayment(120, 120, 8.875);
  assert.equal(plan.chargeAmount, 0);
  assert.equal(plan.refundAmount, 0);
  assert.equal(plan.taxAmount, 0);
});

test('expiry applies only when expiresAt has passed', () => {
  const now = new Date('2026-01-02T00:00:00Z');
  assert.equal(isExpired({ expiresAt: new Date('2026-01-01T00:00:00Z') }, now), true);
  assert.equal(isExpired({ expiresAt: new Date('2026-01-03T00:00:00Z') }, now), false);
  assert.equal(isExpired({}, now), false);
});

test('expiry window defaults to 24h and is capped below the card hold lifetime', () => {
  delete process.env.EXTENSION_REQUEST_EXPIRY_HOURS;
  assert.equal(getExpiryHours(), 24);
  process.env.EXTENSION_REQUEST_EXPIRY_HOURS = '500';
  assert.equal(getExpiryHours(), 96);
  delete process.env.EXTENSION_REQUEST_EXPIRY_HOURS;
  const now = new Date('2026-01-01T00:00:00Z');
  assert.equal(buildExpiresAt(now).toISOString(), '2026-01-02T00:00:00.000Z');
});

test('only held or completed intents are usable', () => {
  assert.equal(isIntentUsable({ status: 'requires_capture' }), true);
  assert.equal(isIntentUsable({ status: 'succeeded' }), true);
  assert.equal(isIntentUsable({ status: 'requires_action' }), false);
  assert.equal(isIntentUsable(null), false);
});

test('payment errors become customer-friendly messages', () => {
  assert.match(describePaymentError('requires_action'), /extra verification/);
  assert.match(describePaymentError(new Error('Your card was declined.')), /declined/);
  assert.match(describePaymentError(new Error('boom')), /could not process/);
});

test('a change window can move or shrink while the stay is in the future', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const booking = { checkIn: '2026-06-10T10:00:00Z', checkOut: '2026-06-10T18:00:00Z' };
  assert.equal(validateChangeWindow(booking, '2026-06-10T12:00:00Z', '2026-06-10T16:00:00Z', now), null);
  assert.equal(validateChangeWindow(booking, '2026-06-20T10:00:00Z', '2026-06-20T18:00:00Z', now), null);
  assert.match(validateChangeWindow(booking, '2026-05-30T10:00:00Z', '2026-06-10T18:00:00Z', now), /future/);
  assert.match(validateChangeWindow(booking, '2026-06-10T18:00:00Z', '2026-06-10T10:00:00Z', now), /after the start/);
});

test('a stay that has started keeps its start but can still change its end', () => {
  const now = new Date('2026-06-10T12:00:00Z');
  const booking = { checkIn: '2026-06-10T10:00:00Z', checkOut: '2026-06-10T18:00:00Z' };
  assert.equal(validateChangeWindow(booking, '2026-06-10T10:00:00Z', '2026-06-10T20:00:00Z', now), null);
  assert.match(validateChangeWindow(booking, '2026-06-10T11:00:00Z', '2026-06-10T20:00:00Z', now), /already started/);
  assert.match(validateChangeWindow(booking, '2026-06-10T10:00:00Z', '2026-06-10T11:00:00Z', now), /future/);
});
