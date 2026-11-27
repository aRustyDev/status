import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { bootstrapPreviewUser } from '../src/issue14-preview-user.ts'

class Statement {
  private values: unknown[] = []
  constructor(private sql: string, private db: DatabaseSync) {}
  bind(...values: unknown[]) { this.values = values; return this }
  runSync() { return this.db.prepare(this.sql).run(...this.values as never[]) }
}
class DB {
  db = new DatabaseSync(':memory:')
  prepare(sql: string) { return new Statement(sql, this.db) }
  async batch(statements: Statement[]) {
    this.db.exec('BEGIN')
    try { const result = statements.map(statement => statement.runSync()); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}

test('the verified preview principal is promoted once, only in the isolated scope', async () => {
  const db = new DB()
  db.db.exec(readFileSync(new URL('../migrations/0001_board.sql', import.meta.url), 'utf8'))
  const user = { id: 'test-user', issuer: 'https://access.example.test', subject: 'synthetic-subject' }
  db.db.prepare('INSERT INTO users (id,issuer,subject,email) VALUES (?,?,?,?)').run(user.id,user.issuer,user.subject,'fixture@example.test')
  const expected = createHash('sha256').update(JSON.stringify([user.issuer,user.subject])).digest('hex')
  const env = { DB: db as unknown as D1Database, API_SCOPE: 'operations', PREVIEW_SUBSCRIBER_REQUIRED: 'true', PREVIEW_SUBSCRIBER_SCOPE: '737597c9ba1d3cc17826ea2f2b48a9d259e03dbf1acd241dc62d886da5c20511', PREVIEW_RELEASE: 'a'.repeat(40) }
  const role = () => db.db.prepare('SELECT role,version FROM users WHERE id=?').get(user.id)
  await bootstrapPreviewUser({...env,PREVIEW_SUBSCRIBER_SCOPE:'different'},user,expected)
  await bootstrapPreviewUser(env,{...user,subject:'other'},expected)
  assert.deepEqual({...role()},{role:'viewer',version:1})
  await bootstrapPreviewUser(env,user,expected)
  assert.deepEqual({...role()},{role:'admin',version:2})
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM audit_events WHERE id='issue14-preview-admin-bootstrap'").get() as {n:number}).n,1)
  db.db.prepare("UPDATE users SET role='viewer',version=3 WHERE id=?").run(user.id)
  await bootstrapPreviewUser(env,user,expected)
  assert.deepEqual({...role()},{role:'viewer',version:3})
})
