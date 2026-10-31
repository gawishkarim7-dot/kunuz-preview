'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const gateway = require('./gateway');

const KEY = ['sk', 'test', 'abcdefghijklmnopqrstuvwx'].join('_');
const invoices = new Map();
let server;
let lastAuth = '';

test.before(async () => {
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (lastAuth !== `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`) return json(401, { type: 'authentication_error', message: 'Invalid key' });
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/v1/invoices') {
        const b = JSON.parse(raw);
        const id = `inv_${invoices.size + 1}`;
        const inv = { id, status: 'initiated', amount: b.amount, metadata: b.metadata, url: `https://pay.example/${id}` };
        invoices.set(id, inv);
        return json(201, inv);
      }
      if (req.method === 'GET' && url.pathname === '/v1/invoices') return json(200, { invoices: [] });
      const m = url.pathname.match(/^\/v1\/invoices\/(.+)$/);
      if (req.method === 'GET' && m && invoices.has(m[1])) return json(200, invoices.get(m[1]));
      return json(404, { type: 'not_found', message: 'nope' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.MOYASAR_API_BASE = `http://127.0.0.1:${server.address().port}/v1`;
});

test.after(() => server.close());

test('createInvoice sends halalas, metadata and basic auth', async () => {
  const inv = await gateway.createInvoice(KEY, {
    orderNo: 'SL-1', amount: 28.5, description: 'Order SL-1',
    successUrl: 'https://x/ok', backUrl: 'https://x/back', callbackUrl: 'https://x/cb'
  });
  assert.equal(inv.amount, 2850);
  assert.equal(inv.url, 'https://pay.example/inv_1');
  assert.equal(invoices.get(inv.id).metadata.order_no, 'SL-1');
});

test('createInvoice rejects tiny or invalid amounts', async () => {
  await assert.rejects(() => gateway.createInvoice(KEY, { orderNo: 'SL-2', amount: 0.5, description: 'x' }), /invalid_amount/);
});

test('checkInvoice: open, then paid only when amount and order match', async () => {
  const inv = await gateway.createInvoice(KEY, { orderNo: 'SL-3', amount: 10, description: 'x', successUrl: 'a', backUrl: 'b', callbackUrl: 'c' });
  assert.equal(await gateway.checkInvoice(KEY, { invoiceId: inv.id, amount: inv.amount, orderNo: 'SL-3' }), 'open');

  invoices.get(inv.id).status = 'paid';
  assert.equal(await gateway.checkInvoice(KEY, { invoiceId: inv.id, amount: inv.amount, orderNo: 'SL-3' }), 'paid');

  await assert.rejects(() => gateway.checkInvoice(KEY, { invoiceId: inv.id, amount: inv.amount + 1, orderNo: 'SL-3' }), /amount_mismatch/);
  await assert.rejects(() => gateway.checkInvoice(KEY, { invoiceId: inv.id, amount: inv.amount, orderNo: 'SL-OTHER' }), /order_mismatch/);
});

test('checkInvoice: expired invoice is closed', async () => {
  const inv = await gateway.createInvoice(KEY, { orderNo: 'SL-4', amount: 10, description: 'x', successUrl: 'a', backUrl: 'b', callbackUrl: 'c' });
  invoices.get(inv.id).status = 'expired';
  assert.equal(await gateway.checkInvoice(KEY, { invoiceId: inv.id, amount: inv.amount, orderNo: 'SL-4' }), 'closed');
});

test('ping works with the right key and reports 401 with a wrong one', async () => {
  assert.equal(await gateway.ping(KEY), true);
  await assert.rejects(() => gateway.ping(['sk', 'test', 'wrongwrongwrongwrongwrong'].join('_')), err => err.status === 401);
});
