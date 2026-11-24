const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planExtensionPayment,
  isExpired,
  isIntentUsable,
  describePaymentError,
  buildExpiresAt,
  getExpiryHours
} = require('./extensionPayments');

test('charges only the increase and avoids floating point drift', () => {
  assert.deepEqual(planExtensionPayment(100.1, 250.3), { chargeAmount: 150.2, refundAmount: 0 });
});

test('refunds a decrease and charges nothing', () => {
  assert.deepEqual(planExtensionPayment(300, 275.5), { chargeAmount: 0, refundAmount: 24.5 });
});

test('moves no money when the price is unchanged', () => {
  assert.deepEqual(planExtensionPayment(120, 120), { chargeAmount: 0, refundAmount: 0 });
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
