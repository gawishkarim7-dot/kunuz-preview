'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const catalog = require('./catalog');
const { ApiError, buildOrder, createOrderCredentials, safeEqualHex, validateQuote } = require('./commerce');
const { closePool, getPool } = require('./db');

const ROOT = path.resolve(__dirname, '..');
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const RATE_LIMITS = new Map();
const RATE_LIMIT_SECRET = process.env.RATE_LIMIT_SECRET || crypto.randomBytes(32).toString('hex');
const bankTransfer = {
  name: process.env.BANK_NAME_AR || '',
  nameEn: process.env.BANK_NAME_EN || '',
  holder: process.env.BANK_ACCOUNT_NAME_AR || '',
  holderEn: process.env.BANK_ACCOUNT_NAME_EN || '',
  accountNumber: process.env.BANK_ACCOUNT_NUMBER || '',
  iban: process.env.BANK_IBAN || '',
  swift: process.env.BANK_SWIFT || '',
  currency: process.env.BANK_CURRENCY || 'SAR',
  branch: process.env.BANK_BRANCH_AR || '',
  branchEn: process.env.BANK_BRANCH_EN || ''
};
const bankTransferConfigured = Boolean(
  process.env.MANUAL_PAYMENT_ENABLED === 'true' &&
  bankTransfer.name && bankTransfer.holder && bankTransfer.iban
);
const CHECKOUT_METHODS = Object.freeze({
  mada: false,
  card: false,
  apple: false,
  stc: false,
  tabby: false,
  tamara: false,
  bank: bankTransferConfigured,
  later: process.env.MANUAL_PAYMENT_ENABLED === 'true',
  cod: process.env.COD_ENABLED === 'true'
});

function checkoutEnabled() {
  return process.env.CATALOG_APPROVED === 'true' &&
    process.env.CHECKOUT_ENABLED === 'true' &&
    Object.values(CHECKOUT_METHODS).some(Boolean);
}

function config() {
  const enabled = checkoutEnabled();
  const whatsapp = String(process.env.CONTACT_WHATSAPP || process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
  return {
    checkoutEnabled: enabled,
    authEnabled: false,
    methods: CHECKOUT_METHODS,
    bank: enabled && bankTransferConfigured ? bankTransfer : null,
    whatsapp,
    seller: {
      crNo: enabled ? process.env.SELLER_CR_NO || '' : '',
      vatNo: enabled ? process.env.SELLER_VAT_NO || '' : ''
    }
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function errorResponse(res, error) {
  if (error instanceof ApiError) {
    return sendJson(res, error.status, { error: error.code });
  }
  if (error && error.code === 'database_unconfigured') {
    return sendJson(res, 503, { error: 'service_unavailable' });
  }
  if (error && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '08000', '08003', '08006'].includes(error.code)) {
    return sendJson(res, 503, { error: 'service_unavailable' });
  }
  console.error('Request failed:', error && error.message ? error.message : 'unknown error');
  return sendJson(res, 500, { error: 'internal_error' });
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(415, 'content_type_required');
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_JSON_BYTES) throw new ApiError(413, 'payload_too_large');

  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_JSON_BYTES) throw new ApiError(413, 'payload_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}

function requestIp(req) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(req, bucket, limit, windowMs) {
  const ipHash = crypto.createHmac('sha256', RATE_LIMIT_SECRET)
    .update(requestIp(req))
    .digest('hex');
  const key = `${bucket}:${ipHash}`;
  const now = Date.now();
  const record = RATE_LIMITS.get(key);
  if (!record || now - record.startedAt >= windowMs) {
    RATE_LIMITS.set(key, { startedAt: now, count: 1 });
  } else {
    record.count += 1;
    if (record.count > limit) throw new ApiError(429, 'rate_limited');
  }

  if (RATE_LIMITS.size > 10_000) {
    for (const [entry, value] of RATE_LIMITS) {
      if (now - value.startedAt > windowMs * 2) RATE_LIMITS.delete(entry);
    }
  }
}

function safeFile(root, relative) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, candidate);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? candidate : null;
}

function staticCandidates(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return [];
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return [];

  if (decoded === '/') return [path.join(ROOT, 'index.html')];
  if (['/catalog.js'].includes(decoded)) return [path.join(ROOT, 'assets', 'catalog.js')];
  if (decoded.startsWith('/img/')) {
    const file = safeFile(path.join(ROOT, 'downloaded', 'img'), decoded.slice('/img/'.length));
    return file ? [file] : [];
  }
  if (decoded.startsWith('/brand/')) {
    const file = safeFile(path.join(ROOT, 'downloaded', 'brand'), decoded.slice('/brand/'.length));
    return file ? [file] : [];
  }
  if (decoded.startsWith('/assets/')) {
    const file = safeFile(path.join(ROOT, 'assets'), decoded.slice('/assets/'.length));
    return file ? [file] : [];
  }
  if (/^\/(?:p|c|d|k|s)\/[^/]+$/.test(decoded) || ['/all', '/checkout', '/account'].includes(decoded)) {
    return [path.join(ROOT, 'index.html')];
  }

  const relative = decoded.slice(1);
  const fromDownloaded = safeFile(path.join(ROOT, 'downloaded'), relative);
  const fromAssets = safeFile(path.join(ROOT, 'assets'), relative);
  return [fromDownloaded, fromAssets].filter(Boolean);
}

function contentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
  })[ext] || 'application/octet-stream';
}

async function serveStatic(req, res, pathname) {
  for (const file of staticCandidates(pathname)) {
    let data;
    try {
      data = await fs.readFile(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') continue;
      throw error;
    }
    const isHtml = file.endsWith('.html');
    const isAppJs = file.endsWith('.js') && !file.includes(`${path.sep}node_modules${path.sep}`);
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Content-Length': data.length,
      'Cache-Control': isHtml || isAppJs ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY'
    });
    return res.end(req.method === 'HEAD' ? undefined : data);
  }
  return sendJson(res, 404, { error: 'not_found' });
}

function quoteReference() {
  return `SLQ-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function createQuote(input) {
  const quote = validateQuote(input, catalog);
  const pool = getPool();
  const client = await pool.connect();
  const reference = quoteReference();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO quotes (reference, product_id, customer_name, mobile, company, city, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [reference, quote.product ? quote.product.id : null, quote.name, quote.mobile, quote.company, quote.city, quote.details]
    );
    for (const file of quote.files) {
      await client.query(
        `INSERT INTO quote_files (quote_id, filename, content_type, byte_length, contents)
         VALUES ($1, $2, $3, $4, $5)`,
        [result.rows[0].id, file.name, file.contentType, file.data.length, file.data]
      );
    }
    await client.query('COMMIT');
    return reference;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createOrder(input) {
  if (!checkoutEnabled()) throw new ApiError(503, 'checkout_disabled');
  const order = buildOrder(input, catalog);
  if (!CHECKOUT_METHODS[order.paymentMethod]) throw new ApiError(503, 'payment_unavailable');

  const credentials = createOrderCredentials();
  const pool = getPool();
  const client = await pool.connect();
  let orderId;
  const status = order.paymentMethod === 'bank' ? 'awaiting_transfer' : 'awaiting_confirmation';
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO orders (order_no, token_hash, locale, status, payment_method, shipping_method, customer, totals)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        credentials.orderNo,
        credentials.tokenHash,
        order.lang,
        status,
        order.paymentMethod,
        order.shippingMethod,
        order.customer,
        order.totals
      ]
    );
    orderId = result.rows[0].id;
    for (const line of order.lines) {
      await client.query(
        `INSERT INTO order_items
         (order_id, product_id, sku, title, product_type, unit, quantity, unit_price, line_total, selection, configuration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          orderId,
          line.productId,
          line.sku,
          line.title,
          line.type,
          line.unit,
          line.quantity,
          line.unitPrice,
          line.total,
          line.selection,
          line.configuration
        ]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    orderNo: credentials.orderNo,
    token: credentials.token,
    order: {
      no: credentials.orderNo,
      token: credentials.token,
      status,
      lines: order.lines.map(line => ({ ...line, ar: line.title, en: line.title })),
      totals: {
        sub: order.totals.subtotal,
        shipping: order.totals.shipping,
        total: order.totals.total,
        vat: order.totals.vat,
        dueNow: order.totals.dueNow,
        hasCustom: order.totals.hasCustom
      },
      bank: order.paymentMethod === 'bank' ? bankTransfer : null
    }
  };
}

async function getOrder(orderNo, token) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const pool = getPool();
  const result = await pool.query(
    `SELECT order_no, token_hash, locale, status, payment_method, shipping_method, customer, totals, created_at
     FROM orders WHERE order_no = $1`,
    [orderNo]
  );
  const row = result.rows[0];
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (!row || !safeEqualHex(row.token_hash.trim(), tokenHash)) return null;

  const lines = await pool.query(
    `SELECT product_id AS "productId", sku, title, product_type AS type, unit,
            quantity, unit_price AS "unitPrice", line_total AS total, selection, configuration
     FROM order_items WHERE order_id = (SELECT id FROM orders WHERE order_no = $1)
     ORDER BY id`,
    [orderNo]
  );
  return {
    no: row.order_no,
    status: row.status,
    lang: row.locale,
    lines: lines.rows.map(line => ({
      ...line,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice),
      total: Number(line.total),
      ar: line.title,
      en: line.title
    })),
    totals: row.totals,
    bank: row.payment_method === 'bank' && bankTransferConfigured ? bankTransfer : null
  };
}

function pathOrderNo(pathname) {
  const match = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');

  if (req.method === 'GET' && pathname === '/api/config') return sendJson(res, 200, config());
  if (req.method === 'GET' && pathname === '/api/health') {
    try {
      await getPool().query('SELECT 1');
      return sendJson(res, 200, { ok: true, database: 'connected' });
    } catch (error) {
      return errorResponse(res, error);
    }
  }
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    return sendJson(res, 200, { login: false, user: null, channel: 'sms' });
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout') return sendJson(res, 200, { ok: true });
  if (pathname.startsWith('/api/auth/')) return sendJson(res, 503, { error: 'auth_unavailable' });

  if (req.method === 'POST' && pathname === '/api/quotes') {
    try {
      rateLimit(req, 'quote', 10, 15 * 60 * 1000);
      const input = await readJson(req);
      return sendJson(res, 201, { ref: await createQuote(input) });
    } catch (error) {
      return errorResponse(res, error);
    }
  }
  if (req.method === 'POST' && pathname === '/api/orders') {
    try {
      rateLimit(req, 'order', 8, 60 * 60 * 1000);
      const input = await readJson(req);
      return sendJson(res, 201, await createOrder(input));
    } catch (error) {
      return errorResponse(res, error);
    }
  }
  if (req.method === 'GET' && pathname.startsWith('/api/orders/')) {
    try {
      const orderNo = pathOrderNo(pathname);
      if (!orderNo) return sendJson(res, 404, { error: 'not_found' });
      const order = await getOrder(orderNo, url.searchParams.get('t'));
      return order ? sendJson(res, 200, order) : sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      return errorResponse(res, error);
    }
  }
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
  return serveStatic(req, res, pathname);
}

function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => errorResponse(res, error));
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

if (require.main === module) {
  const server = createServer();
  const port = Number(process.env.PORT || 3026);
  server.listen(port, () => console.log(`Kunooz store listening on port ${port}.`));

  const shutdown = () => {
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, config };
