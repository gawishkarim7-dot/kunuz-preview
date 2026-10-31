'use strict';

/*
 * File-backed store for everything the admin can edit without touching code:
 * company details, home texts, payments, shipping, categories, products and bundles.
 * Data lives in DATA_DIR (default ./data) so it survives code updates.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PAYMENT_KEYS = ['mada', 'card', 'apple', 'stc', 'tabby', 'tamara', 'bank', 'later', 'cod'];
const SECTIONS = ['site', 'home', 'payments', 'shipping', 'categories', 'products', 'bundles'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'validation_error';
    this.status = 400;
  }
}

function dataDir() {
  return path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
}
function storeFile() {
  return path.join(dataDir(), 'store.json');
}
function uploadsDir() {
  return path.join(dataDir(), 'uploads');
}

/* ---------- defaults (seeded once, then fully editable from the admin) ---------- */

const SPECS = {
  food: [
    ['حجم العبوة', 'Pack size', 'موضح في اسم المنتج', 'Shown in the product name'],
    ['السعر', 'Price', 'شامل ضريبة القيمة المضافة', 'VAT inclusive'],
    ['الصلاحية', 'Expiry', 'يرجى مراجعة العبوة', 'See product packaging'],
    ['التخزين', 'Storage', 'يرجى اتباع إرشادات العبوة', 'Follow the package storage instructions']
  ]
};

function defaultStore() {
  const cats = [
    ['coffee', 'القهوة', 'Coffee'],
    ['rice', 'الأرز', 'Rice'],
    ['legumes', 'البقوليات', 'Legumes'],
    ['pasta', 'المكرونة', 'Pasta'],
    ['spices', 'البهارات', 'Spices'],
    ['sweets', 'حلويات الأطفال', 'Sweets']
  ].map(([id, ar, en]) => ({ id, ar, en }));

  const prods = [
    [101, 'coffee', 'بوكس بن كولومبي 5 ظرف (60 جم)', 'Colombian Coffee Box, 5 Sachets (60 g)', 28, 'قهوة بن كولومبي coffee colombian'],
    [102, 'coffee', 'بوكس بن إثيوبي 5 ظرف (60 جم)', 'Ethiopian Coffee Box, 5 Sachets (60 g)', 28, 'قهوة بن اثيوبي coffee ethiopian'],
    [103, 'coffee', 'بوكس بن برازيلي 5 ظرف (60 جم)', 'Brazilian Coffee Box, 5 Sachets (60 g)', 28, 'قهوة بن برازيلي coffee brazilian'],
    [104, 'rice', 'أرز مصري - سلام (5 كيلو)', 'Salam Egyptian Rice (5 kg)', 27, 'ارز مصري rice egyptian salam'],
    [105, 'rice', 'أرز بسمتي - مزة (10 كيلو)', 'Mezza Basmati Rice (10 kg)', 48, 'ارز بسمتي مزة rice basmati mezza'],
    [106, 'rice', 'أرز بسمتي - مزة (5 كيلو)', 'Mezza Basmati Rice (5 kg)', 28, 'ارز بسمتي مزة rice basmati mezza'],
    [107, 'legumes', 'فول مصري (15 كيلو)', 'Egyptian Fava Beans (15 kg)', 72, 'فول مصري fava broad beans egyptian'],
    [108, 'pasta', 'مكرونة الملكة (1 كيلو)', 'Al Malika Pasta (1 kg)', 2.75, 'مكرونة الملكة pasta macaroni'],
    [109, 'legumes', 'فاصوليا مصرية (1 كيلو)', 'Egyptian Beans (1 kg)', 8, 'فاصوليا مصرية beans egyptian'],
    [110, 'spices', 'بهارات مشكلة (1 كيلو)', 'Mixed Spices (1 kg)', 19, 'بهارات مشكلة spices seasoning'],
    [111, 'sweets', 'حلويات الأطفال (كرتون)', "Children's Sweets (Carton)", 23, 'حلويات اطفال sweets candy carton']
  ].map(([id, cat, ar, en, price, kw]) => {
    const sku = `KNZ-${String(id - 100).padStart(3, '0')}`;
    return {
      id, sku, cat, ar, en, price, was: 0, kw, dar: '', den: '',
      images: [`kunuz/${sku}`], active: true, added: false
    };
  });

  return {
    site: {
      nameAr: 'كنوز الحقول',
      nameEn: 'Knooz',
      taglineAr: 'متجر منتجات غذائية',
      taglineEn: 'Food store',
      aboutAr: 'كنوز الحقول متجر إلكتروني لمنتجات غذائية مختارة: قهوة رشفة، أرز، بهارات وبقوليات — بأسعار شاملة الضريبة وتوصيل داخل المملكة.',
      aboutEn: 'Knooz is an online store for selected foods: Rashfa coffee, rice, spices and legumes — VAT-inclusive prices with delivery across the Kingdom.',
      whatsapp: String(process.env.CONTACT_WHATSAPP || process.env.WHATSAPP_NUMBER || '201055782314').replace(/\D/g, ''),
      phone: '',
      email: '',
      addressAr: '',
      addressEn: '',
      hoursAr: '',
      hoursEn: '',
      crNo: process.env.SELLER_CR_NO || '',
      vatNo: process.env.SELLER_VAT_NO || '',
      social: { instagram: '', x: '', snapchat: '', tiktok: '', facebook: '' }
    },
    home: {
      heroTitleAr: '', heroTitleEn: '', heroBlurbAr: '', heroBlurbEn: '',
      announceOn: false, announceAr: '', announceEn: ''
    },
    payments: {
      checkoutEnabled: false,
      accepted: Object.fromEntries(PAYMENT_KEYS.map(key => [key, key === 'later' ? process.env.MANUAL_PAYMENT_ENABLED === 'true' : key === 'cod' ? process.env.COD_ENABLED === 'true' : false])),
      noteAr: 'نتفق معك على طريقة الدفع عبر واتساب عند تأكيد الطلب.',
      noteEn: 'We agree on the payment method with you on WhatsApp when confirming the order.',
      bank: {
        name: process.env.BANK_NAME_AR || '', nameEn: process.env.BANK_NAME_EN || '',
        holder: process.env.BANK_ACCOUNT_NAME_AR || '', holderEn: process.env.BANK_ACCOUNT_NAME_EN || '',
        accountNumber: process.env.BANK_ACCOUNT_NUMBER || '', iban: process.env.BANK_IBAN || '',
        swift: process.env.BANK_SWIFT || '', currency: process.env.BANK_CURRENCY || 'SAR',
        branch: process.env.BANK_BRANCH_AR || '', branchEn: process.env.BANK_BRANCH_EN || ''
      }
    },
    shipping: { std: 25, exp: 45, ins: 150, freeOver: 500 },
    categories: cats,
    products: prods,
    bundles: [
      { id: 'home', ar: 'باقة خزين البيت', en: 'Home stock bundle', dAr: 'أرز + مكرونة + فول بسعر باقة موحّد يكفي البيت لفترة.', dEn: 'Rice + pasta + fava beans at one bundle price.', items: [{ id: 104, qty: 1 }, { id: 108, qty: 8 }, { id: 107, qty: 1 }], price: 115, active: true },
      { id: 'cook', ar: 'باقة المزاج والطبخ', en: 'Mood & cooking bundle', dAr: 'بن إثيوبي مع بهارات مشكلة للقهوة والطبخ.', dEn: 'Ethiopian coffee with mixed spices.', items: [{ id: 102, qty: 1 }, { id: 110, qty: 1 }], price: 44, active: true },
      { id: 'rashfa', ar: 'باقة رشفة المتنوعة', en: 'Rashfa tasting bundle', dAr: 'الأصول الثلاثة: كولومبي وإثيوبي وبرازيلي.', dEn: 'All three origins: Colombia, Ethiopia, Brazil.', items: [{ id: 101, qty: 1 }, { id: 102, qty: 1 }, { id: 103, qty: 1 }], price: 79, active: true }
    ],
    gateway: { enabled: false, secret: '' },
    admin: { username: '', salt: '', hash: '', secret: '' }
  };
}

/* ---------- persistence ---------- */

let state = null;
const attached = [];

const USERNAME_RE = /^[a-z0-9._@-]{3,40}$/;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function ensureAdmin(data) {
  let changed = false;
  if (!data.admin || typeof data.admin !== 'object') { data.admin = {}; changed = true; }
  if (!data.admin.secret) { data.admin.secret = crypto.randomBytes(32).toString('hex'); changed = true; }
  if (!data.admin.username) {
    const name = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    data.admin.username = USERNAME_RE.test(name) ? name : 'admin';
    changed = true;
  }
  if (!data.admin.hash || !data.admin.salt) {
    const initial = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    data.admin.salt = crypto.randomBytes(16).toString('hex');
    data.admin.hash = hashPassword(initial, data.admin.salt);
    changed = true;
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`Admin login -> username: ${data.admin.username} | password: ${initial} (change them after first login)`);
    }
  }
  return changed;
}

function mergeDefaults(target, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (target[key] === undefined) target[key] = structuredClone(value);
    else if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      mergeDefaults(target[key], value);
    }
  }
  return target;
}

function persist() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${storeFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storeFile());
}

function load() {
  if (state) return state;
  const defaults = defaultStore();
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read store.json, using defaults:', error.message);
  }
  state = mergeDefaults(data && typeof data === 'object' ? data : {}, defaults);
  const changed = ensureAdmin(state);
  if (!data || changed) {
    try { persist(); } catch (error) { console.error('Could not write store.json:', error.message); }
  }
  return state;
}

function get() {
  return load();
}

/* ---------- public views ---------- */

function activeCatalog() {
  const s = load();
  const cats = s.categories.map(c => ({ id: c.id, p: 'food', ar: c.ar, en: c.en || c.ar }));
  const catIds = new Set(cats.map(c => c.id));
  const products = s.products
    .filter(p => p.active !== false && catIds.has(p.cat))
    .map(p => ({
      id: p.id, sku: p.sku, cat: p.cat, ar: p.ar, en: p.en || p.ar, price: p.price, kw: p.kw || '',
      dar: p.dar || '', den: p.den || '',
      unit: 'pc', type: 'ready', added: Boolean(p.added), was: p.was || 0, lead: 0
    }));
  const IMG = {};
  for (const p of s.products) IMG[p.sku] = (p.images || []).slice();
  const CAT_IMG = {};
  for (const c of cats) {
    const first = products.find(p => p.cat === c.id && (IMG[p.sku] || []).length);
    if (first) CAT_IMG[c.id] = IMG[first.sku][0];
  }
  const ids = new Set(products.map(p => p.id));
  const BUNDLES = s.bundles
    .filter(b => b.active !== false && b.items.length && b.items.every(i => ids.has(i.id)))
    .map(b => ({ id: b.id, ar: b.ar, en: b.en || b.ar, dAr: b.dAr || '', dEn: b.dEn || '', items: b.items.map(i => [i.id, i.qty]), price: b.price }));
  return { CATS: cats, PARENTS: { food: { ar: 'منتجات غذائية', en: 'Groceries' } }, P: products, IMG, CAT_IMG, BUNDLES };
}

function publicConfig() {
  const s = load();
  const { site, home, shipping, payments } = s;
  return {
    site: {
      nameAr: site.nameAr, nameEn: site.nameEn, taglineAr: site.taglineAr, taglineEn: site.taglineEn,
      aboutAr: site.aboutAr, aboutEn: site.aboutEn, phone: site.phone, email: site.email,
      addressAr: site.addressAr, addressEn: site.addressEn, hoursAr: site.hoursAr, hoursEn: site.hoursEn,
      social: site.social
    },
    home,
    shipping,
    accepted: payments.accepted,
    payNote: { ar: payments.noteAr, en: payments.noteEn },
    whatsapp: site.whatsapp,
    seller: { crNo: site.crNo, vatNo: site.vatNo }
  };
}

function catalogJs() {
  const d = activeCatalog();
  const j = value => JSON.stringify(value);
  return `'use strict';
(function () {
  const data = window.__SL_DATA__;
  if (!data) throw new Error('The base catalog did not load.');
  data.CATS = ${j(d.CATS)};
  data.PARENTS = ${j(d.PARENTS)};
  data.P = ${j(d.P)};
  data.IMG = ${j(d.IMG)};
  data.CAT_IMG = ${j(d.CAT_IMG)};
  data.BUNDLES = ${j(d.BUNDLES)};
  data.OPTS = {};
  data.SPECS = ${j(SPECS)};
  data.PROJECTS = [];
  window.SL = Object.assign({}, window.SL, data);
})();
`;
}

/* Keep the in-memory server catalog (used to validate orders) in sync with the store. */
function replaceArray(target, next) { target.length = 0; target.push(...next); }
function replaceObject(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}
function applyTo(sl) {
  const d = activeCatalog();
  sl.CATS = sl.CATS || [];
  sl.P = sl.P || [];
  sl.IMG = sl.IMG || {};
  sl.CAT_IMG = sl.CAT_IMG || {};
  sl.BUNDLES = sl.BUNDLES || [];
  replaceArray(sl.CATS, d.CATS);
  replaceArray(sl.P, d.P);
  replaceArray(sl.BUNDLES, d.BUNDLES);
  replaceObject(sl.IMG, d.IMG);
  replaceObject(sl.CAT_IMG, d.CAT_IMG);
  sl.PARENTS = d.PARENTS;
  sl.SPECS = SPECS;
  sl.OPTS = {};
  sl.PROJECTS = [];
}
function attach(sl) {
  attached.push(sl);
  applyTo(sl);
}

/* ---------- validation ---------- */

function str(value, max, label, { required = false } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (required && !v) throw new ValidationError(`${label} مطلوب`);
  if (v.length > max) throw new ValidationError(`${label} أطول من ${max} حرفًا`);
  return v;
}
function money(value, label, { min = 0, max = 1_000_000, allowZero = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (!allowZero && n === 0)) {
    throw new ValidationError(`${label} غير صحيح`);
  }
  return Math.round(n * 100) / 100;
}
function slug(value, label) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(v)) throw new ValidationError(`${label}: استخدم حروفًا إنجليزية صغيرة وأرقامًا وشرطة فقط`);
  return v;
}
function url(value, label) {
  const v = str(value, 300, label);
  if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new ValidationError(`${label} يجب أن يبدأ بـ https://`);
  return v;
}
function digits(value, label) {
  const v = str(value, 20, label).replace(/\D/g, '');
  return v;
}
function list(value, label, max) {
  if (!Array.isArray(value)) throw new ValidationError(`${label} غير صحيح`);
  if (value.length > max) throw new ValidationError(`${label}: الحد الأقصى ${max}`);
  return value;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label} غير صحيح`);
  return value;
}

const validators = {
  site(input) {
    const i = object(input, 'بيانات الشركة');
    const social = object(i.social || {}, 'روابط التواصل');
    const whatsapp = digits(i.whatsapp, 'رقم واتساب');
    if (!/^\d{9,15}$/.test(whatsapp)) throw new ValidationError('رقم واتساب يجب أن يكون بصيغة دولية مثل 201055782314 أو 966501234567');
    return {
      nameAr: str(i.nameAr, 80, 'اسم المتجر (عربي)', { required: true }),
      nameEn: str(i.nameEn, 80, 'اسم المتجر (إنجليزي)', { required: true }),
      taglineAr: str(i.taglineAr, 80, 'الوصف المختصر (عربي)'),
      taglineEn: str(i.taglineEn, 80, 'الوصف المختصر (إنجليزي)'),
      aboutAr: str(i.aboutAr, 600, 'نبذة عن الشركة (عربي)'),
      aboutEn: str(i.aboutEn, 600, 'نبذة عن الشركة (إنجليزي)'),
      whatsapp,
      phone: str(i.phone, 40, 'الهاتف'),
      email: str(i.email, 120, 'البريد الإلكتروني'),
      addressAr: str(i.addressAr, 250, 'العنوان (عربي)'),
      addressEn: str(i.addressEn, 250, 'العنوان (إنجليزي)'),
      hoursAr: str(i.hoursAr, 120, 'ساعات العمل (عربي)'),
      hoursEn: str(i.hoursEn, 120, 'ساعات العمل (إنجليزي)'),
      crNo: str(i.crNo, 40, 'السجل التجاري'),
      vatNo: str(i.vatNo, 40, 'الرقم الضريبي'),
      social: {
        instagram: url(social.instagram, 'رابط إنستجرام'),
        x: url(social.x, 'رابط X'),
        snapchat: url(social.snapchat, 'رابط سناب شات'),
        tiktok: url(social.tiktok, 'رابط تيك توك'),
        facebook: url(social.facebook, 'رابط فيسبوك')
      }
    };
  },

  home(input) {
    const i = object(input, 'الصفحة الرئيسية');
    return {
      heroTitleAr: str(i.heroTitleAr, 140, 'عنوان الهيرو (عربي)'),
      heroTitleEn: str(i.heroTitleEn, 140, 'عنوان الهيرو (إنجليزي)'),
      heroBlurbAr: str(i.heroBlurbAr, 300, 'نص الهيرو (عربي)'),
      heroBlurbEn: str(i.heroBlurbEn, 300, 'نص الهيرو (إنجليزي)'),
      announceOn: i.announceOn === true,
      announceAr: str(i.announceAr, 160, 'نص الشريط الإعلاني (عربي)'),
      announceEn: str(i.announceEn, 160, 'نص الشريط الإعلاني (إنجليزي)')
    };
  },

  payments(input) {
    const i = object(input, 'الدفع');
    const accepted = object(i.accepted || {}, 'وسائل الدفع');
    const bank = object(i.bank || {}, 'البيانات البنكية');
    return {
      checkoutEnabled: i.checkoutEnabled === true,
      accepted: Object.fromEntries(PAYMENT_KEYS.map(key => [key, accepted[key] === true])),
      noteAr: str(i.noteAr, 300, 'ملاحظة الدفع (عربي)'),
      noteEn: str(i.noteEn, 300, 'ملاحظة الدفع (إنجليزي)'),
      bank: {
        name: str(bank.name, 120, 'اسم البنك (عربي)'),
        nameEn: str(bank.nameEn, 120, 'اسم البنك (إنجليزي)'),
        holder: str(bank.holder, 120, 'اسم صاحب الحساب (عربي)'),
        holderEn: str(bank.holderEn, 120, 'اسم صاحب الحساب (إنجليزي)'),
        accountNumber: str(bank.accountNumber, 40, 'رقم الحساب'),
        iban: str(bank.iban, 40, 'الآيبان').replace(/\s+/g, '').toUpperCase(),
        swift: str(bank.swift, 20, 'سويفت').toUpperCase(),
        currency: str(bank.currency, 5, 'العملة').toUpperCase() || 'SAR',
        branch: str(bank.branch, 120, 'الفرع (عربي)'),
        branchEn: str(bank.branchEn, 120, 'الفرع (إنجليزي)')
      }
    };
  },

  shipping(input) {
    const i = object(input, 'الشحن');
    return {
      std: money(i.std, 'رسوم الشحن العادي', { max: 5000 }),
      exp: money(i.exp, 'رسوم الشحن السريع', { max: 5000 }),
      ins: money(i.ins, 'رسوم التوصيل مع التركيب', { max: 5000 }),
      freeOver: money(i.freeOver, 'حد الشحن المجاني', { max: 1_000_000 })
    };
  },

  categories(input, current) {
    const rows = list(input, 'الأقسام', 40);
    if (!rows.length) throw new ValidationError('يجب أن يبقى قسم واحد على الأقل');
    const seen = new Set();
    const out = rows.map(row => {
      const r = object(row, 'قسم');
      const id = slug(r.id, 'معرّف القسم');
      if (seen.has(id)) throw new ValidationError(`معرّف القسم مكرر: ${id}`);
      seen.add(id);
      const ar = str(r.ar, 60, 'اسم القسم (عربي)', { required: true });
      return { id, ar, en: str(r.en, 60, 'اسم القسم (إنجليزي)') || ar };
    });
    for (const p of current.products) {
      if (!seen.has(p.cat)) {
        throw new ValidationError(`لا يمكن حذف قسم «${p.cat}» لأنه يحتوي منتجات. انقل المنتجات أو احذفها أولًا`);
      }
    }
    return out;
  },

  products(input, current) {
    const rows = list(input, 'المنتجات', 500);
    const catIds = new Set(current.categories.map(c => c.id));
    const used = new Set(rows.map(r => Number(r && r.id)).filter(Number.isInteger));
    let nextId = Math.max(100, ...used) + 1;
    const ids = new Set();
    const skus = new Set();
    const out = rows.map(row => {
      const r = object(row, 'منتج');
      let id = Number(r.id);
      if (!Number.isInteger(id) || id <= 0) id = nextId++;
      if (ids.has(id)) throw new ValidationError(`رقم منتج مكرر: ${id}`);
      ids.add(id);
      const ar = str(r.ar, 200, 'اسم المنتج (عربي)', { required: true });
      const cat = str(r.cat, 30, 'قسم المنتج', { required: true });
      if (!catIds.has(cat)) throw new ValidationError(`قسم غير موجود للمنتج «${ar}»`);
      const price = money(r.price, `سعر «${ar}»`, { min: 0.01, allowZero: false });
      const was = r.was === '' || r.was == null ? 0 : money(r.was, `السعر قبل الخصم لـ «${ar}»`);
      if (was && was <= price) throw new ValidationError(`السعر قبل الخصم لـ «${ar}» يجب أن يكون أكبر من السعر الحالي`);
      let sku = str(r.sku, 30, 'رمز المنتج').toUpperCase();
      if (!sku) sku = `KNZ-${String(id).padStart(3, '0')}`;
      if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(sku)) throw new ValidationError(`رمز المنتج غير صالح: ${sku}`);
      if (skus.has(sku)) throw new ValidationError(`رمز المنتج مكرر: ${sku}`);
      skus.add(sku);
      const images = list(r.images || [], `صور «${ar}»`, 8).map(img => {
        const v = typeof img === 'string' ? img.trim() : '';
        if (!/^(?:\/uploads\/[a-f0-9]{16}\.(?:webp|jpg|png)|[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)$/.test(v)) {
          throw new ValidationError(`مسار صورة غير صالح في «${ar}»`);
        }
        return v;
      });
      return {
        id, sku, cat, ar,
        en: str(r.en, 200, 'اسم المنتج (إنجليزي)') || ar,
        price, was,
        kw: str(r.kw, 200, 'كلمات البحث'),
        dar: str(r.dar, 2000, 'وصف المنتج (عربي)'),
        den: str(r.den, 2000, 'وصف المنتج (إنجليزي)'),
        images,
        active: r.active !== false,
        added: r.added === true
      };
    });
    return out;
  },

  bundles(input, current) {
    const rows = list(input, 'الباقات', 30);
    const ids = new Set(current.products.map(p => p.id));
    const seen = new Set();
    return rows.map(row => {
      const r = object(row, 'باقة');
      const id = slug(r.id, 'معرّف الباقة');
      if (seen.has(id)) throw new ValidationError(`معرّف الباقة مكرر: ${id}`);
      seen.add(id);
      const ar = str(r.ar, 80, 'اسم الباقة (عربي)', { required: true });
      const items = list(r.items || [], `منتجات الباقة «${ar}»`, 12).map(item => {
        const it = object(item, 'منتج داخل الباقة');
        const pid = Number(it.id);
        const qty = Number(it.qty);
        if (!ids.has(pid)) throw new ValidationError(`منتج غير موجود داخل الباقة «${ar}»`);
        if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw new ValidationError(`كمية غير صحيحة داخل الباقة «${ar}»`);
        return { id: pid, qty };
      });
      if (!items.length) throw new ValidationError(`الباقة «${ar}» بلا منتجات`);
      return {
        id, ar,
        en: str(r.en, 80, 'اسم الباقة (إنجليزي)') || ar,
        dAr: str(r.dAr, 200, 'وصف الباقة (عربي)'),
        dEn: str(r.dEn, 200, 'وصف الباقة (إنجليزي)'),
        items,
        price: money(r.price, `سعر الباقة «${ar}»`, { min: 0.01, allowZero: false }),
        active: r.active !== false
      };
    });
  }
};

function update(section, input) {
  if (!SECTIONS.includes(section)) throw new ValidationError('قسم غير معروف');
  const s = load();
  const next = validators[section](input, s);
  // Products removed from the list must not stay inside bundles.
  if (section === 'products') {
    const ids = new Set(next.map(p => p.id));
    for (const b of s.bundles) {
      if (!b.items.every(i => ids.has(i.id))) {
        throw new ValidationError(`الباقة «${b.ar}» تحتوي منتجًا محذوفًا. عدّل الباقة أولًا`);
      }
    }
  }
  s[section] = next;
  persist();
  for (const sl of attached) applyTo(sl);
  return next;
}

/* ---------- admin auth ---------- */

function verifyPassword(password) {
  const { admin } = load();
  if (typeof password !== 'string' || !password || password.length > 200) return false;
  const given = Buffer.from(hashPassword(password, admin.salt), 'hex');
  const real = Buffer.from(admin.hash, 'hex');
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function adminUsername() {
  return load().admin.username;
}

// Both checks always run so a wrong username and a wrong password take the same time.
function verifyLogin(username, password) {
  const nameOk = typeof username === 'string' && sameText(username.trim().toLowerCase(), adminUsername());
  const passOk = verifyPassword(password);
  return nameOk && passOk;
}

function changeCredentials(current, { username, next } = {}) {
  if (!verifyPassword(current)) throw new ValidationError('كلمة المرور الحالية غير صحيحة');
  const s = load();
  let touched = false;
  if (username !== undefined && username !== null && String(username).trim() !== '') {
    const name = String(username).trim().toLowerCase();
    if (!USERNAME_RE.test(name)) throw new ValidationError('اسم المستخدم من 3 إلى 40 حرفًا إنجليزيًا أو أرقامًا أو . _ - @');
    s.admin.username = name;
    touched = true;
  }
  if (next !== undefined && next !== null && next !== '') {
    if (typeof next !== 'string' || next.length < 8 || next.length > 200) {
      throw new ValidationError('كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف');
    }
    s.admin.salt = crypto.randomBytes(16).toString('hex');
    s.admin.hash = hashPassword(next, s.admin.salt);
    touched = true;
  }
  if (!touched) throw new ValidationError('لا يوجد تغيير لحفظه');
  s.admin.secret = crypto.randomBytes(32).toString('hex'); // signs out every other session
  persist();
}

/* ---------- payment gateway (Moyasar) ----------
   The secret key is write-only: it is never returned by any API, only the
   fact that one is saved (and whether it is a test or live key). A key set in
   the MOYASAR_SECRET_KEY environment variable wins over the saved one. */

const SECRET_KEY_RE = /^sk_(test|live)_[A-Za-z0-9]{16,}$/;

function envGatewaySecret() {
  const key = String(process.env.MOYASAR_SECRET_KEY || '').trim();
  return SECRET_KEY_RE.test(key) ? key : '';
}

function gatewaySecret() {
  return envGatewaySecret() || load().gateway.secret || '';
}

function gatewayPublic() {
  const g = load().gateway;
  const fromEnv = envGatewaySecret();
  const key = fromEnv || g.secret || '';
  return {
    provider: 'moyasar',
    enabled: g.enabled === true,
    hasSecret: Boolean(key),
    source: fromEnv ? 'env' : g.secret ? 'admin' : 'none',
    mode: key ? (key.startsWith('sk_test_') ? 'test' : 'live') : null
  };
}

function setGateway(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('بيانات غير صحيحة');
  const s = load();
  if (input.enabled !== undefined) s.gateway.enabled = input.enabled === true;
  if (input.clearSecret === true) s.gateway.secret = '';
  if (typeof input.secretKey === 'string' && input.secretKey.trim()) {
    const key = input.secretKey.trim();
    if (key.startsWith('pk_')) throw new ValidationError('هذا هو المفتاح العام (pk_). المطلوب هو المفتاح السري الذي يبدأ بـ sk_');
    if (!SECRET_KEY_RE.test(key)) throw new ValidationError('صيغة المفتاح غير صحيحة. يجب أن يبدأ بـ sk_test_ أو sk_live_');
    s.gateway.secret = key;
  }
  persist();
  return gatewayPublic();
}

const SESSION_MS = 12 * 60 * 60 * 1000;
function signSession() {
  const exp = String(Date.now() + SESSION_MS);
  const sig = crypto.createHmac('sha256', load().admin.secret).update(exp).digest('hex');
  return { token: `${exp}.${sig}`, maxAge: SESSION_MS / 1000 };
}
function verifySession(token) {
  if (typeof token !== 'string') return false;
  const [exp, sig] = token.split('.');
  if (!/^\d{10,16}$/.test(exp || '') || !/^[a-f0-9]{64}$/.test(sig || '')) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', load().admin.secret).update(exp).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(sig, 'hex'));
}

/* ---------- image uploads ---------- */

function saveUpload(base64) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(base64) || base64.length > 9_000_000) {
    throw new ValidationError('الصورة غير صالحة');
  }
  const data = Buffer.from(base64, 'base64');
  if (!data.length || data.length > 6 * 1024 * 1024) throw new ValidationError('حجم الصورة يجب ألا يزيد عن 6 ميجابايت');
  let ext = null;
  if (data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';
  else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) ext = 'jpg';
  else if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ext = 'png';
  if (!ext) throw new ValidationError('الصيغ المسموحة: WEBP أو JPG أو PNG');
  fs.mkdirSync(uploadsDir(), { recursive: true });
  const name = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir(), name), data, { mode: 0o644 });
  return `/uploads/${name}`;
}

module.exports = {
  PAYMENT_KEYS, SECTIONS, ValidationError,
  get, update, attach, activeCatalog, catalogJs, publicConfig,
  verifyLogin, adminUsername, changeCredentials, signSession, verifySession,
  gatewaySecret, gatewayPublic, setGateway,
  saveUpload, uploadsDir, dataDir
};
