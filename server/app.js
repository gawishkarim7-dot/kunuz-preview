'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const catalog = require('./catalog');
const store = require('./store');
const { ApiError, buildOrder, createOrderCredentials, safeEqualHex, validateQuote } = require('./commerce');
const { closePool, getPool } = require('./db');

const ROOT = path.resolve(__dirname, '..');
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const RATE_LIMITS = new Map();
const RATE_LIMIT_SECRET = process.env.RATE_LIMIT_SECRET || crypto.randomBytes(32).toString('hex');
// Online gateways (mada, cards, Apple Pay, STC Pay, Tabby, Tamara) are not integrated yet,
// so only these methods can create an order in full checkout mode.
const gateway = require('./gateway');

const CHECKOUT_CAPABLE = ['bank', 'later', 'cod'];
const GATEWAY_METHODS = ['mada', 'card', 'apple', 'stc'];
const ORDER_STATUSES = ['awaiting_confirmation', 'pending_payment', 'awaiting_transfer', 'cod_confirmed', 'paid', 'deposit_paid', 'payment_failed', 'in_fabrication', 'shipped', 'delivered', 'cancelled'];

function gatewayReady() {
  const g = store.gatewayPublic();
  return dbConfigured() && g.enabled && g.hasSecret;
}

function publicOrigin(req) {
  const fixed = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(fixed)) return fixed;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto === 'https' ? 'https' : 'http'}://${req.headers.host || 'localhost'}`;
}

function callbackSig(orderNo) {
  return crypto.createHmac('sha256', store.gatewaySecret() || 'none').update(`cb:${orderNo}`).digest('hex').slice(0, 32);
}

function dbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function bankInfo() {
  const bank = store.get().payments.bank;
  return bank.name && bank.holder && bank.iban ? { ...bank } : null;
}

function checkoutMethods() {
  const { accepted } = store.get().payments;
  const methods = Object.fromEntries(store.PAYMENT_KEYS.map(key => [key, false]));
  for (const key of CHECKOUT_CAPABLE) {
    methods[key] = accepted[key] === true && (key !== 'bank' || Boolean(bankInfo()));
  }
  for (const key of GATEWAY_METHODS) {
    methods[key] = accepted[key] === true && gatewayReady();
  }
  return methods;
}

function checkoutEnabled() {
  return store.get().payments.checkoutEnabled === true &&
    dbConfigured() &&
    Object.values(checkoutMethods()).some(Boolean);
}

function config() {
  const enabled = checkoutEnabled();
  const pub = store.publicConfig();
  const { accepted } = store.get().payments;
  return {
    checkoutEnabled: enabled,
    authEnabled: false,
    methods: checkoutMethods(),
    accepted: pub.accepted,
    bank: accepted.bank === true ? bankInfo() : null,
    payNote: pub.payNote,
    whatsapp: pub.whatsapp,
    site: pub.site,
    home: pub.home,
    shipping: pub.shipping,
    seller: pub.seller
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
  if (error && error.code === 'validation_error') {
    return sendJson(res, 400, { error: 'validation_error', message: error.message });
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
  if (decoded === '/admin' || decoded === '/admin/') return [path.join(ROOT, 'admin.html')];
  if (decoded.startsWith('/uploads/')) {
    const file = safeFile(store.uploadsDir(), decoded.slice('/uploads/'.length));
    return file ? [file] : [];
  }
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
    const isUpload = file.startsWith(store.uploadsDir() + path.sep);
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Content-Length': data.length,
      ...(file.endsWith('admin.html') ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
      'Cache-Control': file.endsWith('admin.html') ? 'no-store' :
        isUpload ? 'public, max-age=31536000, immutable' :
        isHtml || isAppJs ? 'no-cache' : 'public, max-age=3600',
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

async function createOrder(input, req) {
  if (!checkoutEnabled()) throw new ApiError(503, 'checkout_disabled');
  const order = buildOrder(input, catalog, store.get().shipping);
  if (!checkoutMethods()[order.paymentMethod]) throw new ApiError(503, 'payment_unavailable');

  const credentials = createOrderCredentials();
  const online = GATEWAY_METHODS.includes(order.paymentMethod);
  let payment = null;
  if (online) {
    // Create the hosted payment page first; if the gateway is down no order is saved.
    const origin = publicOrigin(req);
    const no = encodeURIComponent(credentials.orderNo);
    try {
      const invoice = await gateway.createInvoice(store.gatewaySecret(), {
        orderNo: credentials.orderNo,
        amount: order.totals.dueNow,
        description: `${store.get().site.nameEn || 'Order'} - ${credentials.orderNo}`,
        successUrl: `${origin}/?order=${no}&t=${encodeURIComponent(credentials.token)}`,
        backUrl: `${origin}/checkout`,
        callbackUrl: `${origin}/api/webhooks/moyasar?order=${no}&k=${callbackSig(credentials.orderNo)}`
      });
      payment = { provider: 'moyasar', invoiceId: invoice.id, url: invoice.url, amount: invoice.amount };
    } catch (error) {
      console.error('Payment gateway error:', error.message);
      throw new ApiError(502, 'payment_gateway_error');
    }
  }

  const pool = getPool();
  const client = await pool.connect();
  let orderId;
  const status = online ? 'pending_payment' : order.paymentMethod === 'bank' ? 'awaiting_transfer' : 'awaiting_confirmation';
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO orders (order_no, token_hash, locale, status, payment_method, shipping_method, customer, totals, payment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        credentials.orderNo,
        credentials.tokenHash,
        order.lang,
        status,
        order.paymentMethod,
        order.shippingMethod,
        order.customer,
        order.totals,
        payment
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
    ...(payment ? { redirect: payment.url } : {}),
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
      bank: order.paymentMethod === 'bank' ? bankInfo() : null
    }
  };
}

// Asks Moyasar (never the customer's browser) whether a pending order was paid.
async function verifyPayment(orderNo) {
  const pool = getPool();
  const found = await pool.query('SELECT status, payment, totals FROM orders WHERE order_no = $1', [orderNo]);
  const row = found.rows[0];
  if (!row) return null;
  if (row.status !== 'pending_payment' || !row.payment || row.payment.provider !== 'moyasar') return row.status;
  const secret = store.gatewaySecret();
  if (!secret) return row.status;

  let verdict;
  try {
    verdict = await gateway.checkInvoice(secret, {
      invoiceId: row.payment.invoiceId,
      amount: row.payment.amount,
      orderNo
    });
  } catch (error) {
    console.error(`Could not verify payment for ${orderNo}:`, error.message);
    return row.status;
  }
  let next = row.status;
  if (verdict === 'paid') next = Number(row.totals.dueNow) < Number(row.totals.total) ? 'deposit_paid' : 'paid';
  else if (verdict === 'closed') next = 'payment_failed';
  if (next !== row.status) {
    await pool.query(
      `UPDATE orders SET status = $2, updated_at = now() WHERE order_no = $1 AND status = 'pending_payment'`,
      [orderNo, next]
    );
  }
  return next;
}

async function getOrder(orderNo, token) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const pool = getPool();
  const result = await pool.query(
    `SELECT order_no, token_hash, locale, status, payment_method, shipping_method, customer, totals, payment, created_at
     FROM orders WHERE order_no = $1`,
    [orderNo]
  );
  const row = result.rows[0];
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (!row || !safeEqualHex(row.token_hash.trim(), tokenHash)) return null;
  if (row.status === 'pending_payment') row.status = await verifyPayment(orderNo);

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
    bank: row.payment_method === 'bank' ? bankInfo() : null,
    ...(row.status === 'pending_payment' && row.payment && row.payment.url ? { payUrl: row.payment.url } : {})
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

/* ---------- admin ---------- */

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isSecureRequest(req) {
  return process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, value, maxAge) {
  return `kz_admin=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecureRequest(req) ? '; Secure' : ''}`;
}

// The admin panel is for the owner's own computer only. A request counts as
// local when it comes straight from this machine's loopback address, was not
// relayed by a proxy or tunnel (Render, Cloudflare, ngrok...) and was addressed
// to localhost (which also blocks DNS-rebinding). Set ADMIN_ALLOW_REMOTE=true
// to open it up on purpose.
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'true-client-ip', 'x-original-forwarded-for'];

function isLocalRequest(req) {
  if (process.env.ADMIN_ALLOW_REMOTE === 'true') return true;
  const addr = String(req.socket && req.socket.remoteAddress || '');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return false;
  if (FORWARD_HEADERS.some(h => req.headers[h] !== undefined)) return false;
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

function isAdmin(req) {
  return store.verifySession(parseCookies(req).kz_admin);
}

function adminData() {
  const s = store.get();
  return {
    site: s.site,
    home: s.home,
    payments: s.payments,
    shipping: s.shipping,
    categories: s.categories,
    products: s.products,
    bundles: s.bundles,
    username: store.adminUsername(),
    gateway: store.gatewayPublic(),
    env: { databaseConfigured: dbConfigured(), checkoutActive: checkoutEnabled(), gatewaysReady: gatewayReady(), publicUrl: /^https?:\/\//.test(String(process.env.PUBLIC_URL || '')) }
  };
}

async function handleAdminApi(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    rateLimit(req, 'admin-login', 8, 15 * 60 * 1000);
    const input = await readJson(req);
    if (!store.verifyLogin(input && input.username, input && input.password)) throw new ApiError(401, 'invalid_credentials');
    const { token, maxAge } = store.signSession();
    res.setHeader('Set-Cookie', sessionCookie(req, token, maxAge));
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return sendJson(res, 200, { ok: true });
  }
  if (!isAdmin(req)) throw new ApiError(401, 'unauthorized');

  if (req.method === 'GET' && pathname === '/api/admin/data') return sendJson(res, 200, adminData());

  if (req.method === 'POST' && pathname === '/api/admin/upload') {
    const input = await readJson(req);
    return sendJson(res, 201, { url: store.saveUpload(input && input.data) });
  }

  if (req.method === 'POST' && pathname === '/api/admin/password') {
    const input = await readJson(req);
    store.changeCredentials(input && input.current, { username: input && input.username, next: input && input.next });
    const { token, maxAge } = store.signSession();
    res.setHeader('Set-Cookie', sessionCookie(req, token, maxAge));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'PUT' && pathname === '/api/admin/gateway') {
    const input = await readJson(req);
    store.setGateway(input);
    return sendJson(res, 200, adminData());
  }

  if (req.method === 'POST' && pathname === '/api/admin/gateway/test') {
    const key = store.gatewaySecret();
    if (!key) throw new ApiError(400, 'no_gateway_key');
    try {
      await gateway.ping(key);
    } catch (error) {
      return sendJson(res, 200, { ok: false, message: error.status === 401 ? 'المفتاح مرفوض من ميسر. تأكد أنه المفتاح السري الصحيح.' : 'تعذّر الوصول إلى ميسر الآن. حاول لاحقًا.' });
    }
    return sendJson(res, 200, { ok: true, mode: store.gatewayPublic().mode });
  }

  if (req.method === 'GET' && pathname === '/api/admin/orders') {
    if (!dbConfigured()) return sendJson(res, 200, { configured: false, orders: [] });
    const result = await getPool().query(
      `SELECT o.order_no, o.status, o.payment_method, o.shipping_method, o.customer, o.totals, o.created_at,
              (SELECT count(*) FROM order_items i WHERE i.order_id = o.id)::int AS items
       FROM orders o ORDER BY o.created_at DESC LIMIT 200`
    );
    return sendJson(res, 200, {
      configured: true,
      orders: result.rows.map(r => ({
        no: r.order_no,
        status: r.status,
        pay: r.payment_method,
        ship: r.shipping_method,
        name: r.customer && r.customer.name,
        mobile: r.customer && r.customer.mobile,
        city: r.customer && [r.customer.city, r.customer.district].filter(Boolean).join(' - '),
        total: r.totals && r.totals.total,
        dueNow: r.totals && r.totals.dueNow,
        items: r.items,
        at: r.created_at
      }))
    });
  }

  const statusMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
  if (req.method === 'PUT' && statusMatch) {
    if (!dbConfigured()) throw new ApiError(400, 'database_required');
    const input = await readJson(req);
    if (!ORDER_STATUSES.includes(input && input.status)) throw new ApiError(400, 'invalid_status');
    const done = await getPool().query(
      'UPDATE orders SET status = $2, updated_at = now() WHERE order_no = $1 RETURNING order_no',
      [decodeURIComponent(statusMatch[1]), input.status]
    );
    if (!done.rowCount) throw new ApiError(404, 'not_found');
    return sendJson(res, 200, { ok: true });
  }

  const match = pathname.match(/^\/api\/admin\/([a-z]+)$/);
  if (req.method === 'PUT' && match && store.SECTIONS.includes(match[1])) {
    const input = await readJson(req);
    store.update(match[1], input);
    return sendJson(res, 200, adminData());
  }
  throw new ApiError(404, 'not_found');
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');

  if (req.method === 'GET' && pathname === '/kunuz-catalog.js') {
    const body = store.catalogJs();
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache'
    });
    return res.end(body);
  }
  const isAdminPath = pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/api/admin/');
  if (isAdminPath && !isLocalRequest(req)) {
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 404, { error: 'not_found' });
  }

  if (pathname.startsWith('/api/admin/')) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return await handleAdminApi(req, res, pathname);
    } catch (error) {
      return errorResponse(res, error);
    }
  }
  if (req.method === 'POST' && pathname === '/api/webhooks/moyasar') {
    req.resume(); // the body is ignored on purpose: we re-check with Moyasar ourselves
    try {
      rateLimit(req, 'webhook', 120, 60 * 1000);
      const orderNo = url.searchParams.get('order') || '';
      const given = url.searchParams.get('k') || '';
      const expected = callbackSig(orderNo);
      const ok = orderNo && given.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!ok || !dbConfigured()) return sendJson(res, 403, { error: 'forbidden' });
      const status = await verifyPayment(orderNo);
      return sendJson(res, 200, { ok: true, status });
    } catch (error) {
      return errorResponse(res, error);
    }
  }
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
      return sendJson(res, 201, await createOrder(input, req));
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
  server.listen(port, () => console.log(`Knooz store listening on port ${port}.`));

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
