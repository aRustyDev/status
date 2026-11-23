const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { wrapFetch, targets, validateBundle } = require('./fallback.cjs');

const [url, info] = targets.entries().next().value;
const data = JSON.parse(fs.readFileSync(path.join(__dirname, `${info.name}.json`), 'utf8'));
const metadata = { name: `@better-forge/${info.name}`, version: info.version, dist: { integrity: info.integrity,
  attestations: { url, provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } };
const response = (status, text, json) => ({ status, clone: () => ({ text: async () => text }), json: async () => json });
const good = response(200, 'OK\r\n');
function fixture(first = good, meta = metadata, root) {
  const calls = [];
  const fetch = (...args) => { calls.push(args); return Promise.resolve(calls.length === 1 ? first : response(200, '', meta)); };
  return { calls, fetch: wrapFetch(fetch, root ? { root } : {}) };
}

test('known response uses recovered original attestations with live metadata', async () => {
  const f = fixture();
  const res = await f.fetch(url, { cache: 'old' });
  assert.deepEqual(await res.json(), data);
  assert.equal(f.calls.length, 2);
  for (const [, opts] of f.calls) { assert.equal(opts.cache, null); assert.equal(opts.preferOnline, true); assert.equal(opts.preferOffline, false); assert.equal(opts.strictSSL, true); }
});
test('other addresses pass through, and other bodies or HTTP errors are never replaced', async () => {
  const f = fixture(); await f.fetch(url.replace('registry.npmjs.org', 'example.com')); assert.equal(f.calls.length, 1);
  for (const res of [response(404, 'OK\r\n'), response(200, '{}'), response(200, 'OK\n')]) {
    const f = fixture(res); assert.equal(await f.fetch(url), res); assert.equal(f.calls.length, 1);
  }
});
test('transport error is not hidden', async () => {
  const wrapped = wrapFetch(async () => { throw Error('network failed'); });
  await assert.rejects(wrapped(url), /network failed/);
});
test('changed metadata or lockfile fails closed', async () => {
  const changed = structuredClone(metadata); changed.dist.attestations.extra = true;
  await assert.rejects(fixture(good, changed).fetch(url), /metadata changed/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attestation-test-'));
  try { fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ packages: {} })); await assert.rejects(fixture(good, metadata, dir).fetch(url), /lockfile/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('recovered statements require unique known predicates and exact package digest', () => {
  const duplicate = structuredClone(data); duplicate.attestations[1] = duplicate.attestations[0];
  assert.throws(() => validateBundle(duplicate, info), /type/);
  const tampered = structuredClone(data); const env = tampered.attestations[0].bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(env.payload, 'base64')); statement.subject[0].digest.sha512 = '00';
  env.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  assert.throws(() => validateBundle(tampered, info), /subject/);
});
test('metadata response failure and changed integrity fail closed', async () => {
  let count = 0;
  const f = wrapFetch(async () => (++count === 1 ? good : response(500, '')));
  await assert.rejects(f(url), /metadata/);
  const changed = structuredClone(metadata); changed.dist.integrity = 'sha512-other';
  await assert.rejects(fixture(good, changed).fetch(url), /metadata changed/);
});
