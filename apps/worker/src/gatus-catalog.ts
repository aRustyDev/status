import { gatusSourceId, validateGatusCatalog, type GatusCatalogEntry } from './gatus'

/**
 * Reconcile a reviewed, sanitized source inventory in one D1 transaction.
 * Only a dedicated provisioning command should invoke this function. It is not an HTTP endpoint.
 * Removed sources are deactivated, not deleted: old aliases and incident links stay valid.
 */
export async function syncGatusCatalog(db: D1Database, catalog: readonly GatusCatalogEntry[], now = Date.now()): Promise<void> {
  validateGatusCatalog(catalog)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid catalog timestamp')
  const operations = [db.prepare('UPDATE gatus_sources SET active=0 WHERE active=1')]
  for (const [position, entry] of catalog.entries()) {
    const sourceId = gatusSourceId(entry)
    const componentId = crypto.randomUUID()
    operations.push(db.prepare(`INSERT INTO components (id,name,position,updated_at)
      SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM gatus_sources WHERE source_id=?)`)
      .bind(componentId, entry.name, position, now, sourceId))
    operations.push(db.prepare(`INSERT INTO gatus_sources
      (source_id,component_id,kind,source_key,source_name,source_group,stale_after_seconds,advisory,active)
      VALUES (?,?,?,?,?,?,?,?,1)
      ON CONFLICT(source_id) DO UPDATE SET source_key=excluded.source_key,
        stale_after_seconds=excluded.stale_after_seconds, advisory=excluded.advisory, active=1`)
      .bind(sourceId, componentId, entry.kind, entry.key, entry.name, entry.group, entry.staleAfterSeconds, entry.advisory ? 1 : 0))
  }
  await db.batch(operations)
}
