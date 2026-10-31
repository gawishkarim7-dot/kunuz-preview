'use strict';

(function () {
  const data = window.__SL_DATA__;
  if (!data) throw new Error('The base catalog did not load.');

  const categories = [
    { id: 'coffee', p: 'food', ar: 'القهوة', en: 'Coffee' },
    { id: 'rice', p: 'food', ar: 'الأرز', en: 'Rice' },
    { id: 'legumes', p: 'food', ar: 'البقوليات', en: 'Legumes' },
    { id: 'pasta', p: 'food', ar: 'المكرونة', en: 'Pasta' },
    { id: 'spices', p: 'food', ar: 'البهارات', en: 'Spices' },
    { id: 'sweets', p: 'food', ar: 'حلويات الأطفال', en: 'Sweets' }
  ];

  const products = [
    { id: 101, sku: 'KNZ-001', cat: 'coffee', ar: 'بوكس بن كولومبي 5 ظرف (60 جم)', en: 'Colombian Coffee Box, 5 Sachets (60 g)', price: 28, kw: 'قهوة بن كولومبي coffee colombian' },
    { id: 102, sku: 'KNZ-002', cat: 'coffee', ar: 'بوكس بن إثيوبي 5 ظرف (60 جم)', en: 'Ethiopian Coffee Box, 5 Sachets (60 g)', price: 28, kw: 'قهوة بن اثيوبي coffee ethiopian' },
    { id: 103, sku: 'KNZ-003', cat: 'coffee', ar: 'بوكس بن برازيلي 5 ظرف (60 جم)', en: 'Brazilian Coffee Box, 5 Sachets (60 g)', price: 28, kw: 'قهوة بن برازيلي coffee brazilian' },
    { id: 104, sku: 'KNZ-004', cat: 'rice', ar: 'أرز مصري - سلام (5 كيلو)', en: 'Salam Egyptian Rice (5 kg)', price: 27, kw: 'ارز مصري rice egyptian salam' },
    { id: 105, sku: 'KNZ-005', cat: 'rice', ar: 'أرز بسمتي - مزة (10 كيلو)', en: 'Mezza Basmati Rice (10 kg)', price: 48, kw: 'ارز بسمتي مزة rice basmati mezza' },
    { id: 106, sku: 'KNZ-006', cat: 'rice', ar: 'أرز بسمتي - مزة (5 كيلو)', en: 'Mezza Basmati Rice (5 kg)', price: 28, kw: 'ارز بسمتي مزة rice basmati mezza' },
    { id: 107, sku: 'KNZ-007', cat: 'legumes', ar: 'فول مصري (15 كيلو)', en: 'Egyptian Fava Beans (15 kg)', price: 72, kw: 'فول مصري fava broad beans egyptian' },
    { id: 108, sku: 'KNZ-008', cat: 'pasta', ar: 'مكرونة الملكة (1 كيلو)', en: 'Al Malika Pasta (1 kg)', price: 2.75, kw: 'مكرونة الملكة pasta macaroni' },
    { id: 109, sku: 'KNZ-009', cat: 'legumes', ar: 'فاصوليا مصرية (1 كيلو)', en: 'Egyptian Beans (1 kg)', price: 8, kw: 'فاصوليا مصرية beans egyptian' },
    { id: 110, sku: 'KNZ-010', cat: 'spices', ar: 'بهارات مشكلة (1 كيلو)', en: 'Mixed Spices (1 kg)', price: 19, kw: 'بهارات مشكلة spices seasoning' },
    { id: 111, sku: 'KNZ-011', cat: 'sweets', ar: 'حلويات الأطفال (كرتون)', en: "Children's Sweets (Carton)", price: 23, kw: 'حلويات اطفال sweets candy carton' }
  ].map(product => ({
    ...product,
    unit: 'pc',
    type: 'ready',
    added: false,
    was: 0,
    lead: 0
  }));

  const images = Object.fromEntries(products.map(product => [
    product.sku,
    [`kunuz/${product.sku}`]
  ]));
  const categoryImages = Object.fromEntries(categories.map(category => [
    category.id,
    images[products.find(product => product.cat === category.id).sku][0]
  ]));

  data.CATS = categories;
  data.PARENTS = { food: { ar: 'منتجات غذائية', en: 'Groceries' } };
  data.P = products;
  data.IMG = images;
  data.CAT_IMG = categoryImages;
  data.OPTS = {};
  data.SPECS = {
    food: [
      ['حجم العبوة', 'Pack size', 'موضح في اسم المنتج', 'Shown in the product name'],
      ['السعر', 'Price', 'شامل ضريبة القيمة المضافة', 'VAT inclusive'],
      ['الصلاحية', 'Expiry', 'يرجى مراجعة العبوة', 'See product packaging'],
      ['التخزين', 'Storage', 'يرجى اتباع إرشادات العبوة', 'Follow the package storage instructions']
    ]
  };
  data.PROJECTS = [];
  data.BASKET = [101, 106, 110];
  window.SL = Object.assign({}, window.SL, data);
})();
