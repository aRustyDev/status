import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

test('R2-backed backup integrity verification runs in workerd', async () => {
  const bundle = await build({ stdin: {
    contents: `import { backupService } from './core.ts';
      const id = 'a'.repeat(64);
      export default { async fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path === '/seed') {
          const body = 'CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (42);';
          const bytes = new TextEncoder().encode(body);
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2,'0')).join('');
          await env.BACKUP_BUCKET.put('jobs/9999999998999-' + id + '.json', '{}');
          await env.BACKUP_BUCKET.put('exports/' + id + '.sql', body);
          await env.BACKUP_BUCKET.put('exports/' + id + '.json', JSON.stringify({id,createdAt:1000,size:bytes.length,sha256:hash}));
          return new Response('seeded');
        }
        return backupService(request, env);
      } };`,
    resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), sourcefile: 'backup-workerd-test.ts', loader: 'ts',
  }, bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], write: false })
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, r2Buckets: ['BACKUP_BUCKET'] }))
  try {
    assert.equal((await mf.dispatchFetch('https://backup.internal/seed')).status, 200)
    const verified = await mf.dispatchFetch(`https://backup.internal/backups/${'a'.repeat(64)}/verify`)
    assert.equal(verified.status, 200)
    assert.equal((await verified.json() as {valid:boolean}).valid, true)
    const downloaded = await mf.dispatchFetch(`https://backup.internal/backups/${'a'.repeat(64)}/download`)
    assert.match(await downloaded.text(), /INSERT INTO t VALUES \(42\)/)
  } finally { await mf.dispose() }
})
