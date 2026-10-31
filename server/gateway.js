'use strict';

// Minimal Moyasar client (hosted invoice flow). The customer is redirected to a
// Moyasar-hosted page, so card data never reaches this server. We never trust a
// redirect or a webhook body: a payment counts as paid only when we fetch the
// invoice from Moyasar ourselves with the secret key and it says so.

function apiBase() {
  return String(process.env.MOYASAR_API_BASE || 'https://api.moyasar.com/v1').replace(/\/+$/, '');
}

class GatewayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GatewayError';
    this.status = status || 502;
  }
}

async function call(secretKey, method, path, body) {
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new GatewayError(`gateway_unreachable: ${error.message}`, 502);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const detail = data && (data.message || data.type) ? `${data.type || 'error'}: ${data.message || ''}` : `HTTP ${res.status}`;
    throw new GatewayError(detail.trim(), res.status === 401 || res.status === 403 ? 401 : 502);
  }
  return data;
}

const toHalalas = amount => Math.round(Number(amount) * 100);

async function createInvoice(secretKey, { orderNo, amount, description, successUrl, backUrl, callbackUrl }) {
  const halalas = toHalalas(amount);
  if (!Number.isInteger(halalas) || halalas < 100) throw new GatewayError('invalid_amount', 400);
  const invoice = await call(secretKey, 'POST', '/invoices', {
    amount: halalas,
    currency: 'SAR',
    description,
    success_url: successUrl,
    back_url: backUrl,
    callback_url: callbackUrl,
    metadata: { order_no: orderNo }
  });
  if (!invoice || !invoice.id || !invoice.url) throw new GatewayError('invalid_gateway_response', 502);
  return { id: String(invoice.id), url: String(invoice.url), amount: halalas };
}

// Returns 'paid' | 'closed' | 'open'. 'closed' = expired/cancelled, so the
// customer must start a new order. Anything else leaves the order waiting.
async function checkInvoice(secretKey, { invoiceId, amount, orderNo }) {
  const invoice = await call(secretKey, 'GET', `/invoices/${encodeURIComponent(invoiceId)}`);
  if (!invoice || String(invoice.id) !== String(invoiceId)) throw new GatewayError('invalid_gateway_response', 502);
  const metaOrder = invoice.metadata && invoice.metadata.order_no;
  if (metaOrder && metaOrder !== orderNo) throw new GatewayError('order_mismatch', 502);
  const status = String(invoice.status || '').toLowerCase();
  if (status === 'paid') {
    if (Number(invoice.amount) !== Number(amount)) throw new GatewayError('amount_mismatch', 502);
    return 'paid';
  }
  if (['expired', 'canceled', 'cancelled', 'voided'].includes(status)) return 'closed';
  return 'open';
}

async function ping(secretKey) {
  await call(secretKey, 'GET', '/invoices?per_page=1');
  return true;
}

module.exports = { GatewayError, createInvoice, checkInvoice, ping, toHalalas };
