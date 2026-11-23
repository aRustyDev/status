// Only supply a response for the known broken endpoints; verification stays in npm.
const Module = require('node:module');
const { wrapFetch } = require('./fallback.cjs');
const load = Module._load;
Module._load = function (request, parent) {
  const value = load.apply(this, arguments);
  if (request === 'npm-registry-fetch' && parent?.filename.endsWith('/pacote/lib/registry.js')) return wrapFetch(value);
  return value;
};
