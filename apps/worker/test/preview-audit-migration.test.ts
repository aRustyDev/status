import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')

test('preview shared audit preserves history and works with legacy entity filters', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, action TEXT NOT NULL,
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL, details TEXT NOT NULL);`)
    for (const name of ['0021_preview_subscribers.sql', '0022_preview_audit_scope.sql', '0023_preview_audit_events.sql']) db.exec(migration(name))
    const scope = 'a'.repeat(64)
    const expiredScope = 'b'.repeat(64)
    db.prepare('INSERT INTO preview_subscriber_leases VALUES (?, 3, ?, ?, ?)').run(scope, 'a', 'release', 1)
    const insert = db.prepare('INSERT INTO preview_audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const add = (id: string, auditScope: string, type: string, entityId: string) =>
      insert.run(id, auditScope, 'actor@example.com', 'update', type, entityId, 100, '{"changed":true}')

    add('old-slot', scope, 'incident', 'incident-old')
    add('old-unknown', expiredScope, 'maintenance', 'maintenance-old')
    add('private-before', scope, 'subscriber', 'subscriber-1')
    db.exec("INSERT INTO audit_events VALUES ('baseline', 'admin@example.com', 'update', 'incident', 'baseline-incident', 99, '{}', NULL)")
    const before = db.prepare('SELECT * FROM audit_events ORDER BY id').all()
    db.exec(migration('0024_preview_shared_audit_filter.sql'))
    assert.deepEqual(db.prepare('SELECT * FROM audit_events ORDER BY id').all(), before)

    add('new-slot', scope, 'incident', 'incident-new')
    add('new-unknown', expiredScope, 'maintenance', 'maintenance-new')
    add('private-after', scope, 'subscription_settings', '1')

    const rows = db.prepare('SELECT id, entity_type, entity_id, preview_scope FROM audit_events ORDER BY id').all()
    assert.deepEqual(rows.map(row => ({ ...row })), [
      { id: 'baseline', entity_type: 'incident', entity_id: 'baseline-incident', preview_scope: null },
      { id: 'new-slot', entity_type: 'incident', entity_id: 'preview_slot_3:incident-new', preview_scope: scope },
      { id: 'new-unknown', entity_type: 'maintenance', entity_id: 'preview_unknown:maintenance-new', preview_scope: expiredScope },
      { id: 'old-slot', entity_type: 'preview_slot_3_incident', entity_id: 'incident-old', preview_scope: scope },
      { id: 'old-unknown', entity_type: 'preview_unknown_maintenance', entity_id: 'maintenance-old', preview_scope: expiredScope },
    ])
    const filtered = db.prepare('SELECT id FROM audit_events WHERE entity_type = ? ORDER BY id')
    assert.deepEqual(filtered.all('incident').map(row => row.id), ['baseline', 'new-slot'])
    assert.deepEqual(filtered.all('maintenance').map(row => row.id), ['new-unknown'])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM preview_audit_events').get()?.count, 6)
  } finally {
    db.close()
  }
})
