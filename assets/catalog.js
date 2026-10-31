'use strict';

window.__SL_DATA__ = {
  CATS: [],
  PARENTS: {},
  UNITS: {
    pc: { ar: 'عبوة', en: 'pack' }
  },
  P: [],
  OPTS: {},
  SPECS: {},
  PROJECTS: [],
  IMG: {},
  CAT_IMG: {}
};

const catalogData = window.__SL_DATA__;
const catOf = (id) => catalogData.CATS.find((category) => category.id === id);
window.SL = Object.assign({}, catalogData, {
  catOf,
  unitPrice: (product) => product.price
});
