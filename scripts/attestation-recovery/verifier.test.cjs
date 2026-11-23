// End-to-end negative tests: use real npm audit and corrupt only the returned
// registry JSON to ensure npm's own attestation verifier remains active.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

test('npm rejects corrupted signatures and incorrect package digests', { timeout: 180000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-verifier-test-'));
  try {
    for (const name of ['contracts', 'db', 'ui']) fs.copyFileSync(path.join(__dirname, `${name}.json`), path.join(dir, `${name}.json`));
    fs.writeFileSync(path.join(dir, 'preload.cjs'), `
const Module = require('node:module'); const fs = require('node:fs'); const path = require('node:path'); const load = Module._load;
Module._load = function(request, parent) {
  const value = load.apply(this, arguments);
  if (request !== 'npm-registry-fetch' || !parent?.filename.endsWith('/pacote/lib/registry.js')) return value;
  return new Proxy(value, { apply(target, receiver, args) {
    const match = /^https:\\/\\/registry\\.npmjs\\.org\\/-\\/npm\\/v1\\/attestations\\/@better-forge%2f(contracts@0\\.2\\.0|db@0\\.2\\.0|ui@0\\.4\\.0)$/.exec(String(args[0]));
    if (!match) return Reflect.apply(target, receiver, args);
    return Promise.resolve({ json: async () => JSON.parse(fs.readFileSync(path.join(process.env.RECOVERY_TEST_DIR, match[1].split('@')[0] + '.json'), 'utf8')) });
  }});
};`);
    const file = path.join(dir, 'contracts.json');
    const original = fs.readFileSync(file, 'utf8');
    function runAudit() {
      const result = spawnSync('npm', ['audit', 'signatures'], { cwd: root, encoding: 'utf8', timeout: 80000,
        env: { ...process.env, NODE_OPTIONS: `--require ${path.join(dir, 'preload.cjs')}`, RECOVERY_TEST_DIR: dir } });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, 'corrupt attestation must fail npm audit');
      return `${result.stdout}\n${result.stderr}`;
    }
    const badSignature = JSON.parse(original);
    const sig = badSignature.attestations[0].bundle.dsseEnvelope.signatures[0];
    sig.sig = (sig.sig[0] === 'A' ? 'B' : 'A') + sig.sig.slice(1);
    fs.writeFileSync(file, JSON.stringify(badSignature));
    const signatureResult = runAudit();
    assert.match(signatureResult, /invalid attestation/i);
    assert.match(signatureResult, /@better-forge\/contracts@0\.2\.0/);
    const badDigest = JSON.parse(original);
    const env = badDigest.attestations[0].bundle.dsseEnvelope;
    const statement = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'));
    statement.subject[0].digest.sha512 = '00';
    env.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
    fs.writeFileSync(file, JSON.stringify(badDigest));
    const digestResult = runAudit();
    assert.match(digestResult, /EATTESTATIONSUBJECT/);
    assert.match(digestResult, /@better-forge\/contracts@0\.2\.0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
