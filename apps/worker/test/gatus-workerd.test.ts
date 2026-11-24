import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

test('Gatus manual redirects work in workerd and a 3xx fails closed', async () => {
  const bundle = await build({ stdin: {
    contents: `import { getGatusSnapshot } from './gatus.ts';
      export default { async fetch(request) {
        let calls = 0;
        const mode = new URL(request.url).searchParams.get('mode');
        const binding = { async fetch(req) {
          calls++;
          if (req.redirect !== 'manual') throw new Error('Unexpected redirect mode');
          if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://untrusted.example/' } });
          if (new URL(req.url).pathname.includes('/suites/')) return Response.json([]);
          return Response.json([{ key: 'test_check', name: 'Check', group: 'Test', results: [
            { success: true, timestamp: new Date().toISOString(), duration: 1000000 }
          ] }]);
        } };
        const catalog = [{ kind: 'endpoint', key: 'test_check', name: 'Check', group: 'Test', staleAfterSeconds: 180, advisory: false }];
        const snapshot = await getGatusSnapshot(binding, catalog);
        return Response.json({ available: snapshot.available, health: snapshot.monitors[0].health, calls });
      } };`,
    resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), sourcefile: 'gatus-test.ts', loader: 'ts',
  }, bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], write: false })
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text }))
  try {
    const healthy = await mf.dispatchFetch('https://status.example/')
    assert.deepEqual(await healthy.json(), { available: true, health: 'up', calls: 2 })
    const redirected = await mf.dispatchFetch('https://status.example/?mode=redirect')
    assert.deepEqual(await redirected.json(), { available: false, health: 'pending', calls: 2 })
  } finally { await mf.dispose() }
})
