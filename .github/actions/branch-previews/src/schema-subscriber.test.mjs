import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installation } from './installation.mjs'
import { createSchemaFence, schemaSubscriberSettings } from './schema-subscriber.mjs'
import { createBranchConfigs } from './branch-workers.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const files = ['preview-subscriber-scheduler.ts', 'subscriber-delivery.ts', 'subscribers.ts', 'email-channel.ts', 'idempotency.ts', 'index.ts']
const branch = 'schema/subscribers', ref = `refs/heads/${branch}`, sha = 'a'.repeat(40), selector = 'branch-' + 'b'.repeat(24)

test('approval requires the exact schema branch, release, bounded expiry and reviewed source, bundles and migrations', t => {
  const dir = mkdtempSync(path.join(tmpdir(),'schema-subscriber-'))
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  mkdirSync(path.join(dir,'workers')); mkdirSync(path.join(dir,'migrations'))
  const sources = Object.fromEntries(files.map(name => [name,hash(name)]))
  writeFileSync(path.join(dir,'workers/subscriber-source.json'),JSON.stringify(sources))
  writeFileSync(path.join(dir,'workers/api.mjs'),'api'); writeFileSync(path.join(dir,'workers/subscriber.mjs'),'subscriber')
  writeFileSync(path.join(dir,'migrations/0001_test.sql'),'SELECT 1')
  const now = Date.now(), approval = {enabled:true,branch,release:sha,expiresAt:now+10000,sender:'sender@example.com',recipient:'recipient@example.com',publicUrl:'https://preview.example/',approvedSourceManifest:sources,approvedArtifactHashes:{api:hash('api'),subscriber:hash('subscriber')},approvedMigrationHashes:{'0001_test.sql':hash('SELECT 1')}}
  const input = {value:approval,environment:'schema',branch,sha,branchDir:dir,previewUrl:'https://preview.example/',now}
  assert.equal(schemaSubscriberSettings(input).recipient,'recipient@example.com')
  assert.equal(schemaSubscriberSettings({...input,environment:'stage'}),null)
  assert.equal(schemaSubscriberSettings({...input,branch:'schema/other'}),null)
  assert.throws(() => schemaSubscriberSettings({...input,sha:'c'.repeat(40)}),/restrictions/)
  assert.throws(() => schemaSubscriberSettings({...input,value:{...approval,expiresAt:now+49*3600_000}}),/restrictions/)
  assert.throws(() => schemaSubscriberSettings({...input,value:{...approval,publicUrl:'https://other.example/'}}),/URL/)
  writeFileSync(path.join(dir,'migrations/0002_extra.sql'),'SELECT 2')
  assert.throws(() => schemaSubscriberSettings(input),/migrations/)
})

test('fence only touches exact owned schema databases and revokes the old release before enabling the new one', async () => {
  const calls = [], config = {dev:{id:'dev'},stage:{id:'stage'},prod:{id:'prod'},inventoryDatabaseId:'inventory'}
  const release = (value,id) => ({sha:value,resources:{workers:{subscriber:'private'},subscriberExpiresAt:Date.now()+10000,database:{id,name:installation().schemaStem(ref,value)+'-upgrade',owned:true}}})
  const old = release('a'.repeat(40),'old'), next = release('c'.repeat(40),'new')
  let actual = { [old.resources.database.name]:'old', [next.resources.database.name]:'new' }
  const fence = createSchemaFence({config,findDatabase:async name => actual[name] ? {name,id:actual[name]} : null,query:async (db,sql,params) => calls.push({db:db.id,sql,params})})
  await fence.revoke({ref,selector,release:old}); await fence.activate({ref,selector,release:next})
  assert.deepEqual(calls.map(call => call.db),['old','new'])
  assert.match(calls[0].sql,/^DELETE/); assert.match(calls[1].sql,/^INSERT/)
  for (const id of ['dev','stage','prod','inventory']) await assert.rejects(fence.activate({ref,selector,release:release(sha,id)}),/database/)
  await assert.rejects(fence.activate({ref:'refs/heads/stage/other',selector,release:next}),/database/)
  actual[next.resources.database.name] = 'unexpected'
  await assert.rejects(fence.activate({ref,selector,release:next}),/identity changed/)
  delete actual[next.resources.database.name]
  await assert.rejects(fence.revoke({ref,selector,release:next}),/identity changed/)
})

test('only opted-in release receives a restricted sender, isolated database and scheduler', t => {
  const dir = mkdtempSync(path.join(tmpdir(),'schema-config-'))
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  const settings = {d1DatabaseId:'id',d1DatabaseName:'db',accessTeamDomain:'access',accessAud:'aud',endpoints:'[]'}
  const subscriber = {sender:'sender@example.com',recipient:'recipient@example.com',publicUrl:'https://preview.example/'}
  const {order} = createBranchConfigs({settings,selector,sha,branchDir:'/artifact',dir,subscriber,appId:'app'})
  assert.equal(order.at(-1),'subscriber')
  const api = JSON.parse(requireFile(path.join(dir,'api.json'))), cron = JSON.parse(requireFile(path.join(dir,'subscriber.json')))
  assert.equal(api.vars.SUBSCRIBERS_READY,'true')
  assert.deepEqual(api.send_email,[{name:'SUBSCRIBER_EMAIL',allowed_sender_addresses:[subscriber.sender],allowed_destination_addresses:[subscriber.recipient]}])
  assert.deepEqual(cron.send_email,api.send_email)
  assert.deepEqual(cron.triggers.crons,['* * * * *'])
  assert.equal(cron.d1_databases[0].database_id,'id')
})

import { readFileSync as requireFile } from 'node:fs'
