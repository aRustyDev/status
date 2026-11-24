/** Print reviewed SQL for an explicit D1 endpoint-registry synchronization. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { endpointFingerprint, parseEndpoints, type Endpoint } from '../../worker/src/endpoint-config'

type Config = { env?: Record<string, { vars?: { ENDPOINTS?: string }; d1_databases?: { binding: string; database_id: string }[]; vpc_services?: { binding: string; service_id: string }[] }> }

function sqlString(value: string): string { return `'${value.replaceAll("'", "''")}'` }

export async function buildSyncSql(board: Config, probe: Config, environment: string): Promise<string> {
  const boardEnv = board.env?.[environment]
  const probeEnv = probe.env?.[environment]
  if (!boardEnv || !probeEnv) throw new Error('Environment is missing from one or both configs')
  const database = (value: typeof boardEnv) => value.d1_databases?.find(binding => binding.binding === 'DB')?.database_id
  const id = database(boardEnv)
  if (!id || id.startsWith('REPLACE_') || id !== database(probeEnv)) throw new Error('Worker D1 database IDs must match and be configured')
  const boardConfig = boardEnv.vars?.ENDPOINTS
  const probeConfig = probeEnv.vars?.ENDPOINTS
  if (!boardConfig?.trim() || !probeConfig?.trim()) throw new Error('Both workers require explicit ENDPOINTS; use [] for an empty catalog')
  const boardEndpoints = parseEndpoints(boardConfig)
  const probeEndpoints = parseEndpoints(probeConfig)
  if (boardEndpoints.size !== probeEndpoints.size) throw new Error('Worker endpoint lists differ')
  const entries: { id: string; fingerprint: string }[] = []
  for (const endpoint of probeEndpoints.values()) {
    const boardEndpoint = boardEndpoints.get(endpoint.id)
    if (!boardEndpoint || JSON.stringify([boardEndpoint.name, boardEndpoint.url, boardEndpoint.binding, boardEndpoint.serviceId, boardEndpoint.revision]) !==
      JSON.stringify([endpoint.name, endpoint.url, endpoint.binding, endpoint.serviceId, endpoint.revision])) throw new Error('Worker endpoint lists differ')
    if (endpoint.binding) {
      const binding = probeEnv.vpc_services?.find(item => item.binding === endpoint.binding)
      if (!binding || binding.service_id !== endpoint.serviceId) throw new Error('Endpoint VPC service ID does not match its binding')
    }
    entries.push({ id: endpoint.id, fingerprint: await endpointFingerprint(endpoint as Endpoint) })
  }
  const lines = entries.map(entry => `INSERT INTO endpoint_registry(endpoint_id,fingerprint) VALUES (${sqlString(entry.id)},${sqlString(entry.fingerprint)}) ON CONFLICT(endpoint_id) DO UPDATE SET fingerprint=excluded.fingerprint WHERE fingerprint<>excluded.fingerprint;`)
  lines.push(entries.length ? `DELETE FROM endpoint_registry WHERE endpoint_id NOT IN (${entries.map(entry => sqlString(entry.id)).join(',')});` : 'DELETE FROM endpoint_registry;')
  return `-- Environment: ${environment}; database ID: ${id}\n-- Apply only after reviewing and confirming the deployment procedure.\n${lines.join('\n')}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.argv[2]
  if (!env || !['staging', 'production'].includes(env) || process.argv.length !== 3) throw new Error('Usage: node --import tsx apps/probe/scripts/sync-endpoints.ts staging|production')
  // Config files must contain valid JSON; remove JSONC comments before running.
  const board = JSON.parse(readFileSync('apps/worker/wrangler.jsonc', 'utf8')) as Config
  const probe = JSON.parse(readFileSync('apps/probe/wrangler.jsonc', 'utf8')) as Config
  const serviceConfigs = ['api', 'status-api', 'monitoring-api'].map(name => ({
    name,
    config: JSON.parse(readFileSync(`apps/gateway/${name}.wrangler.jsonc`, 'utf8')) as Config,
  }))
  const configured = serviceConfigs.filter(service => service.config.env?.[env])
  if (configured.length && configured.length !== serviceConfigs.length) {
    throw new Error('All gateway API services must configure the environment')
  }
  for (const service of configured) {
    try {
      await buildSyncSql(service.config, probe, env)
    } catch (error) {
      throw new Error(`Gateway API configuration ${service.name} does not match the probe`, { cause: error })
    }
  }
  process.stdout.write(await buildSyncSql(board, probe, env))
}
