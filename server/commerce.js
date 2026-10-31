'use strict';

const crypto = require('node:crypto');

const DEFAULT_SHIPPING = Object.freeze({ std: 25, exp: 45, ins: 150, freeOver: 500 });
const ORDERABLE_PAYMENTS = new Set(['bank', 'later', 'cod', 'mada', 'card', 'apple', 'stc']);

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code) {
  throw new ApiError(status, code);
}

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeMobile(value) {
  const compact = text(value, 32).replace(/[\s()-]/g, '');
  if (/^05\d{8}$/.test(compact)) return `+966${compact.slice(1)}`;
  if (/^(?:\+?966)5\d{8}$/.test(compact)) {
    return `+966${compact.replace(/^\+/, '').slice(3)}`;
  }
  fail(400, 'invalid_mobile');
}

function validateCustomer(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_customer');

  const name = text(input.name, 120);
  const mobile = normalizeMobile(input.mobile);
  const email = text(input.email, 254).toLowerCase();
  const city = text(input.city, 80);
  const district = text(input.district, 100);
  const nat = text(input.nat, 8).toUpperCase();
  const b2b = input.b2b === true;
  const company = text(input.company, 160);
  const vat = text(input.vat, 20);
  const cr = text(input.cr, 20);

  if (name.length < 2 || !city || !district) fail(400, 'invalid_customer');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email');
  if (nat && !/^[A-Z0-9]{4,8}$/.test(nat)) fail(400, 'invalid_address');
  if (b2b && !company) fail(400, 'invalid_company');

  return { name, mobile, email, city, district, nat, b2b, company, vat, cr };
}

function validateSelection(product, selection, catalog) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) fail(400, 'invalid_options');
  const optionGroups = catalog.OPTS[product.cat] || [];
  const allowedKeys = new Set(optionGroups.map(option => option.k));

  for (const key of Object.keys(selection)) {
    if (!allowedKeys.has(key)) fail(400, 'invalid_options');
  }

  const normalized = {};
  for (const option of optionGroups) {
    const raw = selection[option.k] ?? 0;
    if (!Number.isInteger(raw) || raw < 0 || raw >= option.v.length) fail(400, 'invalid_options');
    normalized[option.k] = raw;
  }
  return normalized;
}

function validateConfiguration(product, raw, submittedQty) {
  if (raw !== null && raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    fail(400, 'invalid_configuration');
  }
  const cfg = raw || {};
  if (cfg.ins !== undefined && typeof cfg.ins !== 'boolean') fail(400, 'invalid_configuration');
  if (cfg.ins && product.type !== 'custom') fail(400, 'invalid_configuration');

  let quantity = submittedQty;
  const safeCfg = product.type === 'custom' ? { ins: cfg.ins === true } : null;
  if (product.type === 'custom' && product.unit === 'm2') {
    const width = Number(cfg.w);
    const height = Number(cfg.h);
    if (!Number.isFinite(width) || width < 20 || width > 1200 ||
        !Number.isFinite(height) || height < 20 || height > 600) {
      fail(400, 'invalid_configuration');
    }
    quantity = Math.max(0.1, Math.round((width * height / 10000) * 100) / 100);
    safeCfg.w = width;
    safeCfg.h = height;
  } else if (product.type === 'custom' && product.unit === 'm') {
    const length = Number(cfg.len);
    if (!Number.isFinite(length) || length < 0.5 || length > 500) fail(400, 'invalid_configuration');
    quantity = Math.round(length * 1000) / 1000;
    safeCfg.len = quantity;
  }

  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000) fail(400, 'invalid_quantity');
  if (product.unit === 'pc' && !Number.isInteger(quantity)) fail(400, 'invalid_quantity');
  return { quantity, cfg: safeCfg };
}

function buildOrder(input, catalog, shippingConfig = DEFAULT_SHIPPING) {
  const SHIPPING = { std: shippingConfig.std, exp: shippingConfig.exp, ins: shippingConfig.ins, pick: 0 };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_order');
  if (input.terms !== true) fail(400, 'terms_required');
  if (!['ar', 'en'].includes(input.lang)) fail(400, 'invalid_language');
  if (!Object.hasOwn(SHIPPING, input.ship)) fail(400, 'invalid_shipping');
  if (!ORDERABLE_PAYMENTS.has(input.pay)) fail(400, 'payment_unavailable');
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) fail(400, 'invalid_lines');

  const customer = validateCustomer(input.customer);
  const lines = input.lines.map(line => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) fail(400, 'invalid_lines');
    const productId = Number(line.id);
    const product = catalog.P.find(item => item.id === productId);
    if (!product || product.type === 'quote' || !Number.isFinite(product.price) || product.price <= 0) {
      fail(400, 'invalid_product');
    }

    const selection = validateSelection(product, line.sel || {}, catalog);
    const submittedQty = Number(line.qty);
    const { quantity, cfg } = validateConfiguration(product, line.cfg, submittedQty);
    const selectedUnitPrice = catalog.unitPrice(product, selection);
    const installed = product.type === 'custom' && cfg && cfg.ins === true;
    const unitPrice = roundMoney(selectedUnitPrice * (installed ? 1.12 : 1));
    const total = roundMoney(unitPrice * quantity);
    const title = input.lang === 'ar' ? product.ar : product.en;

    return {
      productId: product.id,
      sku: product.sku,
      title,
      type: product.type,
      unit: product.unit,
      quantity,
      unitPrice,
      total,
      selection,
      configuration: cfg
    };
  });

  const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.total, 0));
  const shipping = input.ship === 'std' && shippingConfig.freeOver > 0 && subtotal >= shippingConfig.freeOver ? 0 : SHIPPING[input.ship];
  const total = roundMoney(subtotal + shipping);
  const customTotal = roundMoney(lines.reduce(
    (sum, line) => sum + (line.type === 'custom' ? line.total : 0), 0
  ));
  const dueNow = roundMoney(total - customTotal * 0.5);
  const vat = roundMoney(total * 15 / 115);

  return {
    customer,
    lang: input.lang,
    shippingMethod: input.ship,
    paymentMethod: input.pay,
    lines,
    totals: { subtotal, shipping, total, vat, dueNow, hasCustom: customTotal > 0 }
  };
}

function validateQuote(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_quote');
  const name = text(input.name, 120);
  const mobile = normalizeMobile(input.mobile);
  const company = text(input.company, 160);
  const city = text(input.city, 80);
  const details = text(input.details, 5000);
  const productId = Number(input.productId);
  const product = productId === 0 ? null : catalog.P.find(item => item.id === productId);

  if (name.length < 2 || !city || details.length < 10) fail(400, 'invalid_quote');
  if (productId !== 0 && !product) fail(400, 'invalid_product');

  const files = input.files === undefined ? [] : input.files;
  if (!Array.isArray(files) || files.length > 5) fail(400, 'invalid_files');
  let totalBytes = 0;
  const safeFiles = files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) fail(400, 'invalid_files');
    const name = text(file.name, 180).replace(/[\\/]/g, '_');
    const ext = name.split('.').pop().toLowerCase();
    const typeByExtension = {
      pdf: 'application/pdf',
      dwg: 'application/acad',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp'
    };
    const contentType = typeByExtension[ext];
    if (!contentType || typeof file.data !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
      fail(400, 'invalid_files');
    }
    const data = Buffer.from(file.data, 'base64');
    if (data.toString('base64') !== file.data || data.length === 0) fail(400, 'invalid_files');
    const validSignature = ext === 'pdf' ? data.subarray(0, 5).toString() === '%PDF-' :
      ext === 'png' ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
      ext === 'jpg' || ext === 'jpeg' ? data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255 :
      ext === 'webp' ? data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' :
      /^AC10\d{2}/.test(data.toString('ascii', 0, 6));
    if (!validSignature) fail(400, 'invalid_files');
    totalBytes += data.length;
    if (totalBytes > 10 * 1024 * 1024) fail(413, 'files_too_large');
    return { name, contentType, data };
  });

  return { name, mobile, company, city, details, product, files: safeFiles };
}

function createOrderCredentials() {
  const orderNo = `SL-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { orderNo, token, tokenHash };
}

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

module.exports = {
  ApiError,
  buildOrder,
  createOrderCredentials,
  normalizeMobile,
  safeEqualHex,
  validateQuote
};
