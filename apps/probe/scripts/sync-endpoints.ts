/** Print reviewed SQL for an explicit D1 endpoint-registry synchronization. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { endpointFingerprint, parseEndpoints, type Endpoint } from '../../worker/src/endpoint-config'

type Config = { env?: Record<string, { vars?: { ENDPOINTS?: string }; d1_databases?: { binding: string; database_id: string }[]; vpc_services?: { binding: string; service_id: string }[]; services?: { binding: string; service: string; environment?: string; entrypoint?: string }[] }> }

function sqlString(value: string): string { return `'${value.replaceAll("'", "''")}'` }

export async function buildSyncSql(board: Config, probe: Config, environment: string, casWorker?: Config): Promise<string> {
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
  const usesCas = [...probeEndpoints.values()].some(endpoint => endpoint.authProviders?.cas)
  const casEnv = usesCas ? casWorker?.env?.[environment] : undefined
  if (usesCas && (!casEnv || database(casEnv) !== id || !casEnv.vars?.ENDPOINTS?.trim())) throw new Error('CAS Worker database and endpoint settings must match the probe')
  const casEndpoints = casEnv ? parseEndpoints(casEnv.vars!.ENDPOINTS!) : undefined
  if (casEndpoints && casEndpoints.size !== probeEndpoints.size) throw new Error('CAS Worker endpoint list differs')
  const checkBinding = (target: { binding?: string; serviceId?: string }, workerEnv: NonNullable<typeof boardEnv>, message: string) => {
    if (!target.binding) return
    const vpc = (workerEnv.vpc_services ?? []).filter(item => item.binding === target.binding)
    const service = (workerEnv.services ?? []).filter(item => item.binding === target.binding)
    if (vpc.length + service.length !== 1 || (vpc[0] ? vpc[0].service_id !== target.serviceId : service[0]?.service !== target.serviceId || service[0]?.environment !== undefined || service[0]?.entrypoint !== undefined)) throw new Error(message)
  }
  const entries: { id: string; fingerprint: string }[] = []
  for (const endpoint of probeEndpoints.values()) {
    const boardEndpoint = boardEndpoints.get(endpoint.id)
    if (!boardEndpoint || JSON.stringify([boardEndpoint.name, boardEndpoint.url, boardEndpoint.binding, boardEndpoint.serviceId, boardEndpoint.revision, boardEndpoint.requestPolicy, boardEndpoint.authProviders]) !==
      JSON.stringify([endpoint.name, endpoint.url, endpoint.binding, endpoint.serviceId, endpoint.revision, endpoint.requestPolicy, endpoint.authProviders])) throw new Error('Worker endpoint lists differ')
    checkBinding(endpoint, probeEnv, 'Endpoint VPC service ID or Worker service does not match its binding')
    if (endpoint.authProviders?.oauth2) checkBinding(endpoint.authProviders.oauth2, probeEnv, 'Authentication provider service does not match its binding')
    if (casEnv) {
      const casEndpoint = casEndpoints?.get(endpoint.id)
      if (!casEndpoint || JSON.stringify([casEndpoint.id, casEndpoint.name, casEndpoint.url, casEndpoint.binding, casEndpoint.serviceId, casEndpoint.revision, casEndpoint.requestPolicy, casEndpoint.authProviders]) !==
        JSON.stringify([endpoint.id, endpoint.name, endpoint.url, endpoint.binding, endpoint.serviceId, endpoint.revision, endpoint.requestPolicy, endpoint.authProviders])) throw new Error('CAS Worker endpoint list differs')
      if (endpoint.authProviders?.cas) {
        checkBinding(endpoint, casEnv, 'CAS target service does not match its binding')
        checkBinding(endpoint.authProviders.cas, casEnv, 'CAS provider service does not match its binding')
      }
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
  const casWorker = JSON.parse(readFileSync('apps/probe/cas.wrangler.jsonc', 'utf8')) as Config
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
      await buildSyncSql(service.config, probe, env, casWorker)
    } catch (error) {
      throw new Error(`Gateway API configuration ${service.name} does not match the probe`, { cause: error })
    }
  }
  process.stdout.write(await buildSyncSql(board, probe, env, casWorker))
}
