'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const catalogPath = path.join(__dirname, '..', 'assets', 'catalog.js');
const kunuzCatalogPath = path.join(__dirname, '..', 'assets', 'kunuz-catalog.js');
const window = {};

vm.runInNewContext(fs.readFileSync(catalogPath, 'utf8'), { window }, {
  timeout: 1000,
  filename: catalogPath
});
vm.runInNewContext(fs.readFileSync(kunuzCatalogPath, 'utf8'), { window }, {
  timeout: 1000,
  filename: kunuzCatalogPath
});

if (!window.SL || !Array.isArray(window.SL.P) || !Array.isArray(window.SL.CATS)) {
  throw new Error('The storefront catalog could not be loaded.');
}

module.exports = window.SL;
