import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const entry = 'scripts/preview-browser.mjs'
function start(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exit = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  const ready = Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    exit.then(() => { throw new Error('Pilot process ended before it became ready.') }),
  ])
  return { child, exit, ready }
}

test('two flag contexts, on-request viewer, redirect scoping and owner cleanup', { timeout: 60_000 }, async t => {
  const fixture = start(['--import','tsx','scripts/preview/test-support/browser-pilot.mjs'], process.env)
  t.after(async () => { fixture.child.kill(); await fixture.exit })
  const { variants, configPath, fixtureEnv } = await fixture.ready
  const env = { ...process.env, ...fixtureEnv }
  const run = async (...args) => (await exec(process.execPath, [entry, ...args], { env, timeout: 25_000 })).stdout.trim()
  const owner = start([entry,'compare', ...variants.flatMap(v => [v.selector,v.release]), '--config',configPath], env)
  t.after(async () => { owner.child.kill(); await owner.exit })
  const { run: id } = await owner.ready
  for (const [i,v] of variants.entries()) {
    const info = JSON.parse(await run('inspect', id, i ? 'b' : 'a'))
    assert.equal(info.revision, v.release)
    assert.ok(info.snapshot.includes(v.title))
  }
  const url = await run('show', id, 'b')
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  assert.match(response.headers.get('content-type'), /multipart\/x-mixed-replace/)
  const reader = response.body.getReader()
  assert.ok((await reader.read()).value.length)
  await reader.cancel()
  await run('goto', id, 'a', '/__pilot/network')
  let ok = false
  for (let attempt = 0; attempt < 20 && !ok; attempt++) {
    ok = (await run('inspect',id,'a')).includes('Both cross-origin requests omitted private headers')
    if (!ok) await delay(100)
  }
  assert.ok(ok)
  assert.equal(await run('close',id),'closed')
  assert.equal((await owner.exit)[0],0)
  await assert.rejects(run('inspect',id,'b'))
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1500) }))
  await assert.rejects(run('open',variants[0].selector,variants[1].release,'--config',configPath), /expected origin, HTTP success, and revision/)
})
