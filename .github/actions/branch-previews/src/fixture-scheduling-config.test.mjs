import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {installation} from './installation.mjs'
import {createFixtureSchedulingConfigs} from './fixture-scheduling-config.mjs'

test('schedules only the trusted private scheduler and binds the control DB only to the release fence', t => {
  const dir=mkdtempSync(path.join(tmpdir(),'fixture-scheduling-'))
  t.after(()=>rmSync(dir,{force:true,recursive:true}))
  const app=installation(), ref='refs/heads/feat/example', sha='a'.repeat(40), selector=`branch-${app.branchKey(ref)}`, stem=app.workerStem(selector,sha)
  const input={ref,selector,sha,database:{id:'owned',name:app.schemaStem(ref,sha)+'-upgrade',owned:true},inventoryDatabase:{id:'control',name:'control'},sharedDatabaseIds:['dev','stage','prod'],flagshipAppId:'flagship',runtimeDir:'/trusted/runtime',probeName:`${stem}-probe`,dir}
  const {names, configs, order}=createFixtureSchedulingConfigs(input)
  assert.deepEqual(order,['fence','probeScheduler'])
  assert.deepEqual(configs.fence.d1_databases,[{binding:'INVENTORY',database_id:'control',database_name:'control'}])
  assert.deepEqual(configs.fence.triggers.crons,[])
  assert.equal(configs.fence.vars.PREVIEW_SELECTOR,selector)
  assert.equal(configs.fence.vars.PREVIEW_RELEASE,sha)
  assert.equal(configs.fence.vars.PREVIEW_FLAG_PREFIX,app.flagPrefix)
  assert.deepEqual(configs.probeScheduler.triggers.crons,['* * * * *'])
  assert.equal(configs.probeScheduler.d1_databases,undefined)
  assert.deepEqual(configs.probeScheduler.services,[{binding:'PREVIEW_FENCE',service:names.fence},{binding:'PROBE',service:input.probeName}])
  assert.equal(configs.probeScheduler.workers_dev,false)
  assert.equal(configs.probeScheduler.preview_urls,false)
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir,'fence.json'),'utf8')),configs.fence)
  for (const bad of [
    {...input,database:{...input.database,owned:false}},
    {...input,database:{...input.database,id:'stage'}},
    {...input,database:{...input.database,id:'control'}},
    {...input,database:{...input.database,name:'other'}},
    {...input,probeName:'status-probe-staging'},
    {...input,selector:'branch-'+'f'.repeat(24)},
    {...input,inventoryDatabase:{id:'stage',name:'stage'}},
  ]) assert.throws(()=>createFixtureSchedulingConfigs(bad))
})
