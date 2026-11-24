import assert from 'node:assert/strict'
import { test } from 'node:test'
import { abandonMutationIntent, beginMutationIntent, finishMutationIntent, PendingMutationError, setMutationActor } from '../src/mutationIntent.js'

test('an ambiguous mutation keeps its key through reauthentication and rotates after edits or success', () => {
  const entries = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return entries.size },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  } })
  setMutationActor('first-user')
  const make = (body: string) => beginMutationIntent('POST', '/admin/incidents', body, 'bsp')!
  const first = make('{"title":"private text"}')
  assert.doesNotMatch(JSON.stringify([...entries]), /private text/)
  assert.equal(JSON.parse(entries.get(first.slot)!).ambiguous, true)
  finishMutationIntent(first, 401)
  const retry = make('{"title":"private text"}'); assert.equal(retry.key, first.key)
  finishMutationIntent(retry, 504)
  const secondRetry = make('{"title":"private text"}'); assert.equal(secondRetry.key, first.key)
  finishMutationIntent(secondRetry, 409)
  assert.throws(() => make('{"title":"changed"}'), PendingMutationError)
  abandonMutationIntent(first)
  const changed = make('{"title":"changed"}')
  assert.notEqual(changed.key, first.key)
  finishMutationIntent(first, 201)
  const duplicate = make('{"title":"changed"}'); assert.equal(duplicate.key, changed.key)
  finishMutationIntent(duplicate, 201)
  finishMutationIntent(changed, 201)
  const next = make('{"title":"changed"}'); assert.notEqual(next.key, changed.key)
  finishMutationIntent(next, 201)
  assert.equal(beginMutationIntent('GET', '/admin/incidents', '', 'bsp'), null)
  const legacy = beginMutationIntent('POST', '/admin/incidents', '{"title":"changed"}', 'legacy')!
  assert.notEqual(legacy.key, changed.key); finishMutationIntent(legacy, 201)
  const firstActorIntent = make('{"title":"account switch"}')
  finishMutationIntent(firstActorIntent, 504)
  setMutationActor('second-user')
  const secondActorIntent = make('{"title":"account switch"}')
  assert.notEqual(secondActorIntent.key, firstActorIntent.key)
  finishMutationIntent(secondActorIntent, 504)
  setMutationActor('first-user')
  const original = make('{"title":"account switch"}'); assert.equal(original.key, firstActorIntent.key)
  finishMutationIntent(original, 504)
  abandonMutationIntent(firstActorIntent)
  const restarted = make('{"title":"account switch"}'); assert.notEqual(restarted.key, firstActorIntent.key)
  finishMutationIntent(restarted, 201)
})

test('concurrent attempts retain their key until all settle, including a late ambiguous failure', () => {
  setMutationActor('concurrent-user')
  const make = () => beginMutationIntent('POST', '/admin/components', '{"name":"same"}', 'bsp')!
  const first = make(), second = make()
  assert.equal(first.key, second.key)
  assert.throws(() => beginMutationIntent('POST', '/admin/components', '{"name":"changed"}', 'bsp'), (error: unknown) => error instanceof PendingMutationError && error.inFlight)
  finishMutationIntent(first, 201)
  finishMutationIntent(second, 504)
  const retry = make(); assert.equal(retry.key, first.key)
  finishMutationIntent(retry, 201)
  const next = make(); assert.notEqual(next.key, first.key)
  finishMutationIntent(next, 201)
})

test('a definitive rejection cannot erase a concurrent ambiguous outcome in either order', () => {
  for (const [actor, firstStatus, secondStatus] of [['mixed-one', 500, 403], ['mixed-two', 403, 500]] as const) {
    setMutationActor(actor)
    const make = () => beginMutationIntent('POST', '/admin/components', '{"name":"mixed"}', 'bsp')!
    const first = make(), second = make()
    finishMutationIntent(first, firstStatus); finishMutationIntent(second, secondStatus)
    const retry = make(); assert.equal(retry.key, first.key)
    finishMutationIntent(retry, 201)
  }
})

test('new keys use server time even when the local clock is ahead', () => {
  const now = Date.now, server = now()
  try {
    Date.now = () => server + 3_600_000
    setMutationActor('clock-user', server)
    const key = beginMutationIntent('PATCH', '/admin/users/target', '{"role":"viewer"}', 'bsp')!.key
    assert.equal(Number(key.split('.')[0]), server)
  } finally { Date.now = now }
})

test('saving fails closed when a pending intent cannot be persisted', () => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => { throw new Error('storage full') },
    removeItem: () => {},
  } })
  setMutationActor('storage-fallback-user')
  assert.throws(() => beginMutationIntent('POST', '/admin/components', '{"name":"x"}', 'bsp'), /session storage is required/)
})
