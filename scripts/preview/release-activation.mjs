import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { branchKey, validateInventory } from './release-contract.mjs'
import { candidateVerificationHeader } from './verify-candidate.mjs'

// The caller must serialize all dispatcher and Flagship writers. Candidate
// verification must reach the private candidate before the Flagship switch.
export function createActivationAdapter({ store, appId, accountId, token, dispatcherName, dispatcherSource, directory, run, verificationSecret, previewUrl, accessTeamDomain, accessAud, serviceTokenId, accessHeaders = {}, fetchImpl = globalThis.fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!store || !appId || !accountId || !token || !dispatcherName || !dispatcherSource || !directory || typeof run !== 'function' || typeof verificationSecret !== 'string' || verificationSecret.length < 32 || !previewUrl || !accessTeamDomain || !accessAud || !serviceTokenId) throw new Error('Missing activation configuration or private candidate verifier')
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/flagship/apps/${encodeURIComponent(appId)}/flags`
  async function request(url, options = {}) {
    const response = await fetchImpl(url, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } })
    if (response.status === 404 && !options.method) return null
    const body = await response.json()
    if (!response.ok || body.success !== true || !body.result) throw new Error('Flagship request failed or is ambiguous')
    return body.result
  }
  return async function activate({ ref, sha, generation, selector, resources, active }) {
    const key = branchKey(ref)
    if (selector !== `branch-${key}` || !/^[a-f0-9]{40}$/.test(sha) || !resources?.gateway) throw new Error('Invalid activation candidate')
    const snapshots = await store.list()
    const current = snapshots.find(({ record }) => record.ref === ref)?.record
    if (!current || current.generation !== generation || current.desiredSha !== sha || current.candidate?.phase !== 'activating' || current.candidate.sha !== sha || current.candidate.resources.gateway !== resources.gateway) throw new Error('Inventory candidate is no longer current')
    const services = new Map()
    for (const { record } of snapshots) {
      validateInventory(record)
      for (const release of [record.active, record.previous, ...(record.retained || []), ...(['ready', 'activating'].includes(record.candidate?.phase) ? [record.candidate] : [])]) {
        if (!release) continue
        const gateway = release.resources?.gateway
        const expectedGateway = `status-p-${createHash('sha256').update(`${record.selector}:${release.sha}`).digest('hex').slice(0, 24)}-gateway`
        if (!/^[a-f0-9]{40}$/.test(release.sha) || gateway !== expectedGateway) throw new Error('Invalid retained Worker binding')
        const binding = `PREVIEW_BRANCH_${record.key.toUpperCase()}_${release.sha.toUpperCase()}`
        if (services.has(binding) && services.get(binding) !== gateway) throw new Error('Conflicting Worker binding')
        services.set(binding, gateway)
      }
    }
    const expectedBinding = `PREVIEW_BRANCH_${key.toUpperCase()}_${sha.toUpperCase()}`
    if (services.get(expectedBinding) !== resources.gateway) throw new Error('Candidate binding missing from dispatcher')
    const config = { name: dispatcherName, main: path.resolve(dispatcherSource), compatibility_date: '2026-11-23', workers_dev: false, preview_urls: false, vars: { ACCESS_TEAM_DOMAIN: accessTeamDomain, ACCESS_AUD: accessAud, PREVIEW_SERVICE_TOKEN_ID: serviceTokenId }, flagship: [{ binding: 'FLAGS', app_id: appId }], services: [...services].map(([binding, service]) => ({ binding, service })) }
    const configPath = path.join(directory, 'preview-dispatcher.json')
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    await run(['deploy', '--dry-run', '--config', configPath])
    await run(['deploy', '--config', configPath])
    const probeUrl = new URL('/__preview/verify', previewUrl).toString()
    const probe = await fetchImpl(probeUrl, { headers: { ...accessHeaders, 'X-Status-Preview': selector, 'X-Status-Preview-Verify': candidateVerificationHeader({ selector, sha, secret: verificationSecret }) }, redirect: 'manual', cache: 'no-store' })
    if (!probe.ok || probe.headers.get('X-Status-Preview-Commit') !== sha) throw new Error('Private candidate verification failed')
    const flagKey = `status-preview-branch-${key}`
    const flagUrl = `${apiBase}/${flagKey}`
    const flag = await request(flagUrl)
    if (flag && (flag.default_variation !== 'current' || flag.enabled !== true || flag.rules?.length || flag.variations?.current?.selector !== selector || (flag.variations.current.release !== sha && (!active || flag.variations.current.release !== active.sha)))) throw new Error('Unexpected existing Flagship state')
    if (!flag && active) throw new Error('Active inventory has no Flagship flag')
    const payload = { key: flagKey, enabled: true, default_variation: 'current', rules: [], variations: { current: { selector, release: sha } } }
    if (flag?.variations?.current?.release !== sha) await request(flag ? flagUrl : apiBase, { method: flag ? 'PUT' : 'POST', body: JSON.stringify(payload) })
    const result = await request(flagUrl)
    if (result?.variations?.current?.selector !== selector || result.variations.current.release !== sha) throw new Error('Flagship write was not observed')
    // A management API read is not evidence of edge propagation. The caller
    // supplies Access credentials for a request through the normal entry point.
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetchImpl(probeUrl, { headers: { ...accessHeaders, 'X-Status-Preview': selector, 'X-Status-Preview-Verify': candidateVerificationHeader({ selector, sha, secret: verificationSecret, mode: 'active' }) }, redirect: 'manual', cache: 'no-store' })
        if (response.ok && response.headers.get('X-Status-Preview-Commit') === sha) return
      } catch { /* Propagation may temporarily make the route unavailable. */ }
      if (attempt < 29) await wait(1000)
    }
    throw new Error('Preview route did not confirm the deployed commit')
  }
}
