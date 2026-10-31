'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const store = require('./store');

const catalogPath = path.join(__dirname, '..', 'assets', 'catalog.js');
const window = {};

vm.runInNewContext(fs.readFileSync(catalogPath, 'utf8'), { window }, {
  timeout: 1000,
  filename: catalogPath
});

if (!window.SL || !Array.isArray(window.SL.P) || !Array.isArray(window.SL.CATS)) {
  throw new Error('The storefront catalog could not be loaded.');
}

// Products, categories and prices come from the admin-managed store.
store.attach(window.SL);

module.exports = window.SL;
