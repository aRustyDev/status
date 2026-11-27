import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Cloudflare D1 adapter. recordDatabase must durably save resources in the release inventory. */
export function cloudflareDatabaseAdapter({ accountId, token, wrangler, seedSql, recordDatabase, recordIntent, recordProgress, fetcher = fetch, run = execFileSync }) {
  if (!accountId || !token || !wrangler || typeof recordDatabase !== 'function') throw new Error('Missing D1 adapter configuration')
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database`
  async function request(method, suffix = '', body) {
    const response = await fetcher(`${base}${suffix}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await response.json()
    if (!response.ok || result.success !== true) throw new Error(`Cloudflare D1 ${method} failed (${response.status})`)
    return result.result
  }
  const query = async (database, sql, params = []) => {
    const results = await request('POST', `/${encodeURIComponent(database.id)}/query`, { sql, params })
    if (!Array.isArray(results) || results.length !== 1 || results[0].success !== true || !Array.isArray(results[0].results)) {
      throw new Error('Cloudflare D1 query failed')
    }
    return results[0].results
  }
  return {
    recordDatabase,
    recordIntent,
    recordProgress,
    async migrationLedger(database) { return (await query(database, 'SELECT name FROM d1_migrations')).map(row => row.name) },
    async findDatabase(name) {
      const result = await request('GET', `?name=${encodeURIComponent(name)}&per_page=10000`)
      if (!Array.isArray(result)) throw new Error('Invalid D1 database list')
      const matches = result.filter(item => item.name === name)
      if (matches.length > 1 || matches.some(item => !item.uuid)) throw new Error('Ambiguous D1 database name')
      return matches.length ? { id: matches[0].uuid, name } : null
    },
    async createDatabase(name) {
      const result = await request('POST', '', { name })
      if (!result?.uuid || result.name !== name) throw new Error('Invalid D1 creation response')
      return { id: result.uuid, name: result.name }
    },
    async applyMigrations(database, directory) {
      const tmp = await mkdtemp(path.join(tmpdir(), 'status-preview-d1-'))
      try {
        const config = path.join(tmp, 'wrangler.json')
        await writeFile(config, JSON.stringify({ name: 'status-preview-d1-migrations', compatibility_date: '2026-11-23', d1_databases: [{ binding: 'DB', database_id: database.id, database_name: database.name, migrations_dir: path.resolve(directory) }] }), { mode: 0o600 })
        run(wrangler, ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', config], { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' })
      } finally { await rm(tmp, { recursive: true, force: true }) }
    },
    async seed(database) {
      if (typeof seedSql !== 'string' || !seedSql.trim()) throw new Error('Missing trusted schema seed')
      await query(database, seedSql)
    },
    async initializeFixture(database, sqlFile) {
      if (!database?.owned || typeof database.id !== 'string' || !database.id || typeof database.name !== 'string' || !database.name || !path.isAbsolute(sqlFile)) throw new Error('Fixture seed requires an owned database and trusted SQL file')
      const tmp = await mkdtemp(path.join(tmpdir(), 'status-preview-fixture-d1-'))
      try {
        const config = path.join(tmp, 'wrangler.json')
        await writeFile(config, JSON.stringify({ name: 'status-preview-fixture-seed', compatibility_date: '2026-11-23', d1_databases: [{ binding: 'DB', database_id: database.id, database_name: database.name }] }), { mode: 0o600 })
        run(wrangler, ['d1', 'execute', 'DB', '--remote', '--config', config, '--file', sqlFile], { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' })
      } finally { await rm(tmp, { recursive: true, force: true }) }
    },
    async initializeFixtureRegistry(database, statements) {
      if (!database?.owned || !Array.isArray(statements) || statements.length < 1 || statements.length > 4) throw new Error('Fixture registry requires an owned database')
      for (const statement of statements) {
        if (statement?.sql !== 'INSERT INTO endpoint_registry (endpoint_id, fingerprint) VALUES (?, ?) ON CONFLICT(endpoint_id) DO UPDATE SET fingerprint=excluded.fingerprint' ||
            !Array.isArray(statement.params) || statement.params.length !== 2 || !/^preview-[a-z-]+$/.test(statement.params[0]) || !/^[a-f0-9]{64}$/.test(statement.params[1])) throw new Error('Invalid fixture registry entry')
        await query(database, statement.sql, statement.params)
      }
    },
    async deleteDatabase(database) {
      const response = await fetcher(`${base}/${encodeURIComponent(database.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      if (response.status === 404) return
      const payload = await response.json()
      if (!response.ok || payload.success !== true) throw new Error(`Cloudflare D1 DELETE failed (${response.status})`)
    },
  }
}
