'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('./catalog');
const { ApiError, buildOrder, createOrderCredentials, normalizeMobile, safeEqualHex, validateQuote } = require('./commerce');

function validOrder(overrides = {}) {
  return {
    lang: 'ar',
    ship: 'std',
    pay: 'later',
    terms: true,
    customer: {
      name: 'عميل تجريبي',
      mobile: '0551234567',
      city: 'الرياض',
      district: 'اليرموك'
    },
    lines: [{ id: 101, qty: 2, sel: {}, cfg: null }],
    ...overrides
  };
}

test('normalizes Saudi mobile numbers and rejects invalid values', () => {
  assert.equal(normalizeMobile('055 123 4567'), '+966551234567');
  assert.equal(normalizeMobile('+966551234567'), '+966551234567');
  assert.throws(() => normalizeMobile('12345'), ApiError);
});

test('recalculates prices and VAT from the server catalog', () => {
  const order = buildOrder(validOrder({
    lines: [{ id: 101, qty: 2, sel: {}, cfg: null, unitPrice: 0.01, total: 0.01 }]
  }), catalog);
  assert.equal(order.lines[0].unitPrice, catalog.P.find(item => item.id === 101).price);
  assert.equal(order.totals.subtotal, order.lines[0].total);
  assert.equal(order.totals.shipping, 25);
  assert.equal(order.totals.vat, Math.round(order.totals.total * 15 / 115 * 100) / 100);
});

test('rejects quote-only products and untrusted payment methods', () => {
  assert.throws(
    () => buildOrder(validOrder({ lines: [{ id: 999, qty: 1, sel: {}, cfg: null }] }), catalog),
    error => error instanceof ApiError && error.code === 'invalid_product'
  );
  assert.throws(
    () => buildOrder(validOrder({ pay: 'mada' }), catalog),
    error => error instanceof ApiError && error.code === 'payment_unavailable'
  );
});

test('accepts bank transfer as a manual payment method', () => {
  const order = buildOrder(validOrder({ pay: 'bank' }), catalog);
  assert.equal(order.paymentMethod, 'bank');
  assert.equal(order.lines.length, 1);
});

test('validates quantities for packaged grocery products', () => {
  const order = buildOrder(validOrder(), catalog);
  assert.equal(order.lines[0].quantity, 2);
  assert.equal(order.lines[0].unitPrice, catalog.P.find(item => item.id === 101).price);
  assert.throws(
    () => buildOrder(validOrder({
      lines: [{ id: 101, qty: 1.5, sel: {}, cfg: null }]
    }), catalog),
    error => error instanceof ApiError && error.code === 'invalid_quantity'
  );
});

test('validates quote inputs and file types', () => {
  const pdfData = Buffer.from('%PDF-1.7\n').toString('base64');
  const quote = validateQuote({
    productId: 101,
    name: 'عميل',
    mobile: '0551234567',
    city: 'الرياض',
    details: 'أحتاج عرض سعر للمنتج مع المقاسات.',
    files: [{ name: 'plan.pdf', data: pdfData }]
  }, catalog);
  assert.equal(quote.product.id, 101);
  assert.equal(quote.files[0].contentType, 'application/pdf');
  assert.throws(
    () => validateQuote({
      productId: 101,
      name: 'عميل',
      mobile: '0551234567',
      city: 'الرياض',
      details: 'أحتاج عرض سعر للمنتج مع المقاسات.',
      files: [{ name: 'plan.pdf', data: 'YWJj' }]
    }, catalog),
    error => error instanceof ApiError && error.code === 'invalid_files'
  );
});

test('creates unguessable order retrieval credentials', () => {
  const credentials = createOrderCredentials();
  assert.match(credentials.orderNo, /^SL-\d{6}-[A-F0-9]{8}$/);
  assert.equal(credentials.token.length > 30, true);
  assert.equal(safeEqualHex(credentials.tokenHash, credentials.tokenHash), true);
  assert.equal(safeEqualHex(credentials.tokenHash, '0'.repeat(64)), false);
});
