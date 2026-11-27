import { spawn } from 'node:child_process'
import { constants, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { validateGatusCatalog, type GatusCatalogEntry } from '../../apps/worker/src/gatus'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const wrangler = join(root, 'node_modules/.bin/wrangler')
const worker = join(root, 'scripts/gatus-catalog/local-worker.ts')
const migrations = join(root, 'apps/worker/migrations')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACCOUNT = /^[0-9a-f]{32}$/i
const DB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const MAX_BYTES = 262_144

export interface TargetConfig {
  environment: 'staging' | 'production'
  accountId: string
  databaseId: string
  databaseName: string
  /** Independently identified live/staging/production IDs which this tool must not touch. */
  protectedDatabaseIds: string[]
}
export interface Options {
  target: 'staging' | 'production'
  mode: 'local' | 'remote'
  targetConfig: string
  catalog: string
  expectedAccount: string
  expectedDatabase: string
  allowProduction: boolean
}

export function parseArgs(args: string[]): Options {
  const values = new Map<string, string>()
  let allowProduction = false
  const allowed = new Set(['--target', '--mode', '--target-config', '--catalog', '--expected-account', '--expected-database'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--allow-production') { if (allowProduction) throw new Error('Duplicate flag'); allowProduction = true; continue }
    if (!allowed.has(arg) || values.has(arg) || i + 1 >= args.length || args[i + 1]!.startsWith('--')) throw new Error('Invalid arguments')
    values.set(arg, args[++i]!)
  }
  if ([...allowed].some(arg => !values.has(arg))) throw new Error('Required arguments are missing')
  const target = values.get('--target')
  const mode = values.get('--mode')
  if ((target !== 'staging' && target !== 'production') || (mode !== 'local' && mode !== 'remote')) throw new Error('Invalid target or mode')
  if (target === 'production' && !allowProduction) throw new Error('Production requires an explicit flag')
  if (target === 'staging' && allowProduction) throw new Error('Production flag conflicts with staging')
  if (mode === 'local' && target !== 'staging') throw new Error('Local testing must use staging mode')
  return { target, mode, targetConfig: values.get('--target-config')!, catalog: values.get('--catalog')!, expectedAccount: values.get('--expected-account')!, expectedDatabase: values.get('--expected-database')!, allowProduction }
}

export function validateTarget(value: unknown, options: Options): TargetConfig {
  if ((options.target !== 'staging' && options.target !== 'production') ||
      (options.mode !== 'local' && options.mode !== 'remote') ||
      (options.target === 'production' && (!options.allowProduction || options.mode !== 'remote')) ||
      (options.target === 'staging' && options.allowProduction)) throw new Error('Invalid target options')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid target configuration')
  const config = value as Record<string, unknown>
  if (Object.keys(config).some(key => !['environment', 'accountId', 'databaseId', 'databaseName', 'protectedDatabaseIds'].includes(key)) ||
      config.environment !== options.target || typeof config.accountId !== 'string' || !ACCOUNT.test(config.accountId) ||
      typeof config.databaseId !== 'string' || !UUID.test(config.databaseId) || typeof config.databaseName !== 'string' || !DB_NAME.test(config.databaseName) ||
      !Array.isArray(config.protectedDatabaseIds) || config.protectedDatabaseIds.length < 2 || config.protectedDatabaseIds.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('Invalid target configuration')
  if (config.accountId.toLowerCase() !== options.expectedAccount.toLowerCase() || config.databaseId.toLowerCase() !== options.expectedDatabase.toLowerCase()) throw new Error('Target identity mismatch')
  if (config.protectedDatabaseIds.some(id => id.toLowerCase() === (config.databaseId as string).toLowerCase())) throw new Error('Protected database target')
  if (new Set(config.protectedDatabaseIds.map(id => id.toLowerCase())).size !== config.protectedDatabaseIds.length) throw new Error('Invalid protected database list')
  if (options.target === 'staging' && !config.databaseName.startsWith('status-gatus-validation-')) throw new Error('Staging target is not an isolated validation database')
  if (options.target === 'production' && config.databaseName !== 'status-board-production') throw new Error('Unexpected production database')
  return config as unknown as TargetConfig
}

function readPrivateJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || info.size > MAX_BYTES) throw new Error('Input file must be owner-only and bounded')
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown
  } finally { closeSync(fd) }
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not reserve local port')); return }
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

async function runWrangler(args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number): Promise<string> {
  if (signal.aborted) throw new Error('Provisioning interrupted')
  const child = spawn(wrangler, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const killGroup = (kind: NodeJS.Signals) => { try { process.kill(-child.pid!, kind) } catch { /* already stopped */ } }
  return await new Promise<string>((resolveOutput, reject) => {
    let output = ''
    let failure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (reason: string) => {
      if (failure) return
      failure = new Error(reason)
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), 2000)
      killTimer.unref()
    }
    const onAbort = () => stop('Provisioning interrupted')
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => stop('Wrangler command timed out'), timeoutMs)
    child.stdout!.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > MAX_BYTES) stop('Wrangler output exceeded limit')
      else output += chunk.toString()
    })
    child.stderr!.on('data', () => { /* Never surface Wrangler output, which may contain private configuration. */ })
    child.once('error', () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', onAbort); reject(new Error('Wrangler command failed')) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      signal.removeEventListener('abort', onAbort)
      // Any orphaned descendants are confined to this process group.
      killGroup('SIGTERM')
      if (failure || code !== 0) reject(failure ?? new Error('Wrangler command failed'))
      else resolveOutput(output)
    })
    if (signal.aborted) onAbort()
  })
}

export async function provision(options: Options): Promise<number> {
  const target = validateTarget(readPrivateJson(options.targetConfig), options)
  const catalog = readPrivateJson(options.catalog)
  if (!Array.isArray(catalog)) throw new Error('Invalid catalog')
  validateGatusCatalog(catalog as GatusCatalogEntry[])
  const directory = mkdtempSync(join(tmpdir(), 'gatus-catalog-'))
  const logDirectory = join(directory, 'logs')
  const configPath = join(directory, 'wrangler.json')
  const statePath = join(directory, 'state')
  const token = randomBytes(32).toString('hex')
  const abort = new AbortController()
  const interrupted = () => abort.abort()
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  let child: ReturnType<typeof spawn> | undefined
  try {
    mkdirSync(logDirectory, { mode: 0o700 })
    const configuration = {
      name: 'gatus-catalog-local-only', main: worker, account_id: target.accountId, compatibility_date: '2026-11-23',
      workers_dev: false, preview_urls: false,
      d1_databases: [{ binding: 'DB', database_name: target.databaseName, database_id: target.databaseId, migrations_dir: migrations, ...(options.mode === 'remote' ? { remote: true } : {}) }],
    }
    writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 })
    writeFileSync(join(directory, '.dev.vars'), `PROVISION_TOKEN=${token}\n`, { mode: 0o600 })
    const childEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId, TMPDIR: directory, WRANGLER_LOG_PATH: logDirectory, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }
    if (options.mode === 'remote') {
      const result = await runWrangler(['d1', 'info', 'DB', '--config', configPath, '--json'], childEnv, abort.signal, 30_000)
      const info: unknown = JSON.parse(result)
      if (!info || typeof info !== 'object' || !('uuid' in info) || !('name' in info) || info.uuid !== target.databaseId || info.name !== target.databaseName) throw new Error('Remote database identity verification failed')
    } else {
      await runWrangler(['d1', 'migrations', 'apply', 'DB', '--config', configPath, '--local', '--persist-to', statePath], childEnv, abort.signal, 40_000)
    }
    const port = await freePort()
    if (abort.signal.aborted) throw new Error('Provisioning interrupted')
    const args = ['dev', '--config', configPath, '--ip', '127.0.0.1', '--port', String(port), '--inspector-ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', statePath, '--log-level', 'log', '--show-interactive-dev-session=false']
    if (options.mode === 'local') args.push('--local')
    child = spawn(wrangler, args, { cwd: root, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolveReady, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error('Local worker startup timed out')), 40_000)
      const onAbort = () => { clearTimeout(timeout); reject(new Error('Provisioning interrupted')) }
      abort.signal.addEventListener('abort', onAbort, { once: true })
      child!.once('error', () => { clearTimeout(timeout); reject(new Error('Local worker failed to start')) })
      child!.once('exit', () => { clearTimeout(timeout); reject(new Error('Local worker exited before ready')) })
      const inspect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192)
        if (output.includes(`Ready on http://127.0.0.1:${port}`)) { clearTimeout(timeout); abort.signal.removeEventListener('abort', onAbort); resolveReady() }
      }
      child!.stdout!.on('data', inspect)
      child!.stderr!.on('data', inspect)
    })
    const response = await fetch(`http://127.0.0.1:${port}/apply`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(catalog), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(40_000)]), redirect: 'error',
    })
    if (!response.ok) throw new Error('Catalog application failed')
    const result: unknown = await response.json()
    if (!result || typeof result !== 'object' || !('applied' in result) || result.applied !== catalog.length) throw new Error('Unexpected provisioner result')
    return catalog.length
  } finally {
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
    if (child && child.exitCode === null && child.signalCode === null) {
      const killGroup = (signal: NodeJS.Signals) => { try { process.kill(-child!.pid!, signal) } catch { /* already stopped */ } }
      killGroup('SIGTERM')
      await new Promise<void>(resolveExit => { child!.once('exit', () => resolveExit()); setTimeout(resolveExit, 2000).unref() })
      if (child.exitCode === null && child.signalCode === null) killGroup('SIGKILL')
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const count = await provision(options)
    process.stdout.write(JSON.stringify({ result: 'applied', count, target: options.target, mode: options.mode }) + '\n')
  } catch {
    // Neither private input nor Wrangler's captured logs are printed on failure.
    process.stderr.write('Catalog provisioning failed or its outcome is unknown; inspect the target before retrying.\n')
    process.exitCode = 1
  }
}
