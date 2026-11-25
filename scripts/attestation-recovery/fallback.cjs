// Temporary workaround for npm's broken Better Forge attestation endpoints.
// All replacement bundles are still verified by npm's unchanged Sigstore verifier.
const fs = require('node:fs');
const path = require('node:path');

const SLSA = 'https://slsa.dev/provenance/v1';
const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const packages = {
  audit: ['0.2.0', 'sha512-RhuZWBVe0ojL7Ypc2LQ28bDxG8dn4Qrb3TFWqyJKM97eOUGivjY1SzMjXZ4v4rWlCeEwcz6PfbNK1TkweAsgSQ=='],
  contracts: ['0.2.0', 'sha512-0LafsRZIqKlapw4obJZZESsUmMUjej0xYmb0KCaiQ3oC8PeBAMfjmBhA+BcQ3IprvvhV2psC9awqS5ZKR4AKVg=='],
  db: ['0.2.0', 'sha512-ZgpzbDj6p5uO9yr2LTbi0V4qfShDx0NuNVDrT18j7efGM/AcC6OB9yZw+2UYVg4pwEvXTEDRRia5Awc1HReOkA=='],
  ui: ['0.4.0', 'sha512-fmWXxELM1fUUDRd6U6CJpUL8QkcU/99QK4pO1JKNcPLroLWxAib+9MOmTTCai//k7LpCI8l8nd4rzRwM+qccrQ=='],
};
const registry = 'https://registry.npmjs.org';
// A registry response is untrusted. Bound buffering even when npm has no size limit.
const MAX_ATTESTATION_BYTES = 4 * 1024 * 1024;
const targets = new Map(Object.entries(packages).map(([name, [version, integrity]]) => [
  `${registry}/-/npm/v1/attestations/@better-forge%2f${name}@${version}`,
  { name, version, integrity },
]));

async function readBounded(body) {
  const chunks = [];
  let length = 0;
  if (!body) return Buffer.alloc(0);
  const iterable = Buffer.isBuffer(body) ? [body] : body;
  for await (const chunk of iterable) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_ATTESTATION_BYTES) throw Error('Attestation response exceeds size limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function validateBundle(data, info) {
  if (!Array.isArray(data.attestations) || data.attestations.length !== 2) throw Error('Unexpected recovered attestation count');
  const types = new Set();
  for (const { predicateType, bundle } of data.attestations) {
    if (![SLSA, PUBLISH].includes(predicateType) || types.has(predicateType)) throw Error('Unexpected recovered attestation type');
    types.add(predicateType);
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
    const subject = statement.subject;
    if (statement.predicateType !== predicateType || !Array.isArray(subject) || subject.length !== 1 ||
      subject[0].name !== `pkg:npm/%40better-forge/${info.name}@${info.version}` ||
      subject[0].digest?.sha512 !== Buffer.from(info.integrity.slice('sha512-'.length), 'base64').toString('hex')) {
      throw Error('Recovered attestation subject or predicate mismatch');
    }
  }
}

function wrapFetch(original, options = {}) {
  const root = options.root || path.resolve(__dirname, '../..');
  const bundleDir = options.bundleDir || __dirname;
  return new Proxy(original, { apply(target, receiver, args) {
    const info = targets.get(String(args[0]));
    if (!info) return Reflect.apply(target, receiver, args);
    return (async () => {
      const liveOpts = { ...args[1], cache: null, preferOnline: true, preferOffline: false, offline: false, strictSSL: true };
      const res = await Reflect.apply(target, receiver, [args[0], liveOpts]);
      if (res.status !== 200) return res;
      // minipass-fetch's clone tees into two streams and pauses the source if
      // either is unread. Awaiting only the clone can deadlock before EOF.
      // Consume once and reconstruct a response for npm when it was not the
      // broken endpoint sentinel, so npm still parses and verifies the bytes.
      const body = await readBounded(res.body);
      if (!body.equals(Buffer.from('OK\r\n'))) return new res.constructor(body, {
        status: res.status, statusText: res.statusText, headers: res.headers, url: res.url,
      });
      const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
      const locked = lock.packages[`node_modules/@better-forge/${info.name}`];
      if (!locked || locked.version !== info.version || locked.integrity !== info.integrity) throw Error('Attestation recovery does not match lockfile');
      const metaRes = await Reflect.apply(target, receiver, [`${registry}/@better-forge%2f${info.name}/${info.version}`, liveOpts]);
      if (metaRes.status !== 200) throw Error('Cannot read live package metadata');
      const metadata = await metaRes.json();
      const advertised = metadata.dist?.attestations;
      if (metadata.name !== `@better-forge/${info.name}` || metadata.version !== info.version || metadata.dist?.integrity !== info.integrity ||
        advertised?.url !== args[0] || advertised?.provenance?.predicateType !== SLSA ||
        Object.keys(advertised).sort().join(',') !== 'provenance,url' ||
        Object.keys(advertised.provenance).join(',') !== 'predicateType') throw Error('Live attestation metadata changed');
      const data = JSON.parse(fs.readFileSync(path.join(bundleDir, `${info.name}.json`), 'utf8'));
      validateBundle(data, info);
      console.error(`Using recovered transparency-log attestations for @better-forge/${info.name}@${info.version}`);
      return { json: async () => data };
    })();
  } });
}
module.exports = { wrapFetch, validateBundle, targets };
