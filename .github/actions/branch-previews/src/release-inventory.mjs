import { branchKey, validateInventory } from './release-contract.mjs'

// The control database must be independent of the application databases.
// Each update is one D1 statement, with a revision predicate to prevent lost updates.
export function createInventoryStore({ accountId, databaseId, token, fetchImpl = globalThis.fetch }) {
  if (!accountId || !databaseId || !token || typeof fetchImpl !== 'function') throw new Error('Missing inventory database credentials')
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`
  async function query(sql, params) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    })
    const payload = await response.json()
    if (!response.ok || !payload.success || !Array.isArray(payload.result) || payload.result.length !== 1 || !payload.result[0].success || !Array.isArray(payload.result[0].results)) throw new Error('Inventory database query failed')
    return payload.result[0].results
  }
  return {
    async read(ref) {
      const rows = await query('SELECT revision, document FROM preview_releases WHERE branch_key = ? AND ref = ?', [branchKey(ref), ref])
      if (!rows.length) return null
      const record = validateInventory(JSON.parse(rows[0].document))
      if (record.ref !== ref || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 1) throw new Error('Invalid inventory database row')
      return { revision: rows[0].revision, record }
    },
    async list() {
      const all = []
      let cursor = ''
      for (;;) {
        const rows = await query('SELECT branch_key, ref, revision, document FROM preview_releases WHERE branch_key > ? ORDER BY branch_key LIMIT 100', [cursor])
        for (const row of rows) {
          const record = validateInventory(JSON.parse(row.document))
          if (record.ref !== row.ref || record.key !== row.branch_key || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid inventory database row')
          all.push({ revision: row.revision, record })
        }
        if (rows.length < 100) return all
        cursor = rows.at(-1).branch_key
      }
    },
    async create(record) {
      validateInventory(record)
      const rows = await query('INSERT INTO preview_releases (branch_key, ref, revision, document) VALUES (?, ?, 1, ?) ON CONFLICT DO NOTHING RETURNING revision', [record.key, record.ref, JSON.stringify(record)])
      return rows.length === 1
    },
    async compareAndSwap(ref, revision, record) {
      validateInventory(record)
      if (record.ref !== ref || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid inventory compare-and-swap')
      const rows = await query('UPDATE preview_releases SET revision = revision + 1, document = ? WHERE branch_key = ? AND ref = ? AND revision = ? RETURNING revision', [JSON.stringify(record), branchKey(ref), ref, revision])
      return rows.length === 1
    },
  }
}
