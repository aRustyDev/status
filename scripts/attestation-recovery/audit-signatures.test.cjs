const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'audit-signatures.sh');

function run(outcomes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signature-audit-test-'));
  try {
    const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.FAKE_AUDIT_COUNT;
const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
fs.writeFileSync(file, String(n + 1));
if (process.argv.slice(2).join(' ') !== 'audit signatures --maxsockets=1000' || !process.env.NODE_OPTIONS.includes('--require ./scripts/attestation-recovery/preload.cjs')) process.exit(99);
const outcome = JSON.parse(process.env.FAKE_AUDIT_OUTCOMES)[n] || JSON.parse(process.env.FAKE_AUDIT_OUTCOMES).at(-1);
console.error(outcome.message);
process.exit(outcome.status);
`;
    fs.writeFileSync(path.join(dir, 'npm'), fake, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const counter = path.join(dir, 'count');
    const result = spawnSync('bash', [script], {
      cwd: path.join(__dirname, '../..'), encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_AUDIT_COUNT: counter, FAKE_AUDIT_OUTCOMES: JSON.stringify(outcomes) },
    });
    return { ...result, calls: fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0 };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const ok = { status: 0, message: 'all signatures verified' };
const exitHandler = { status: 1, message: 'npm error Exit handler never called!' };
const malformed = { status: 1, message: `npm error invalid json response body at https://registry.npmjs.org/-/npm/v1/attestations/%40better-forge%2faudit@0.2.0 reason: Unexpected token 'O', "OK` };

test('runs the full audit with the recovery preload', () => {
  const r = run([ok]); assert.equal(r.status, 0); assert.equal(r.calls, 1);
});
test('retries the observed npm and registry failures', () => {
  for (const failure of [exitHandler, malformed]) {
    const r = run([failure, ok]); assert.equal(r.status, 0); assert.equal(r.calls, 2);
  }
});
test('persistent failures exhaust the retry limit', () => {
  const r = run([exitHandler]); assert.equal(r.status, 1); assert.equal(r.calls, 3);
});
test('explicit verification errors fail immediately even with a retryable error', () => {
  for (const message of ['EINTEGRITYSIGNATURE', 'EATTESTATIONVERIFY', 'invalid registry signatures', 'missing registry signatures']) {
    const r = run([{ status: 1, message: `${message}\nExit handler never called!` }, ok]);
    assert.equal(r.status, 1); assert.equal(r.calls, 1);
  }
});
test('unrelated errors and malformed responses from other endpoints fail immediately', () => {
  for (const message of ['connection refused', `invalid json response body at https://example.com reason: Unexpected token 'O', "OK`]) {
    const r = run([{ status: 1, message }, ok]); assert.equal(r.status, 1); assert.equal(r.calls, 1);
  }
});
