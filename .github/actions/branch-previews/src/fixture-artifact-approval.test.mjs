import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { describeFixtureArtifact, validateFixtureArtifactApproval } from './fixture-artifact-approval.mjs'

function harness(t) {
  const branchDir=mkdtempSync(path.join(tmpdir(),'fixture-approval-'))
  t.after(()=>rmSync(branchDir,{recursive:true,force:true}))
  for (const dir of ['workers','assets/api','migrations']) mkdirSync(path.join(branchDir,dir),{recursive:true})
  const put=(name,content)=>writeFileSync(path.join(branchDir,name),content)
  for (const id of ['api','api-feature','probe','cas','subscriber-feature']) put(`workers/${id}.mjs`,`export const name=${JSON.stringify(id)}`)
  put('assets/api/index.html','<div>fixture</div>')
  put('migrations/0001.sql','SELECT 1;'); put('migrations/0002.sql','SELECT 2;')
  const manifest={components:{api:{assets:'apps/board/dist'},probe:{}}}, sha='a'.repeat(40), now=1_800_000_000_000
  const artifacts=describeFixtureArtifact({branchDir,manifest,cas:true,subscriber:true})
  const approval={enabled:true,sha,cas:true,subscriber:true,probe:true,expiresAt:now+60_000,artifacts}
  return {branchDir,manifest,sha,now,approval,put}
}

test('approves the exact feature artifacts for a bounded release', t => {
  const h=harness(t)
  assert.deepEqual(validateFixtureArtifactApproval(h),{expiresAt:h.approval.expiresAt})
  for (const change of [{sha:'b'.repeat(40)}, {expiresAt:h.now}, {expiresAt:h.now+48*3600_000+1}, {cas:false}]) {
    assert.throws(()=>validateFixtureArtifactApproval({...h,approval:{...h.approval,...change}}))
  }
})

test('any changed, missing, or extra approved worker, asset or migration fails closed', t => {
  const h=harness(t)
  for (const key of ['workers','assets','migrations']) {
    const entries=Object.entries(h.approval.artifacts[key]), [first]=entries
    const bad={...h.approval.artifacts,[key]:{...h.approval.artifacts[key],[first[0]]:'f'.repeat(64)}}
    assert.throws(()=>validateFixtureArtifactApproval({...h,approval:{...h.approval,artifacts:bad}}),/does not match/)
    const missing={...h.approval.artifacts,[key]:Object.fromEntries(entries.slice(1))}
    assert.throws(()=>validateFixtureArtifactApproval({...h,approval:{...h.approval,artifacts:missing}}),/does not match/)
  }
  h.put('migrations/0003.sql','SELECT 3;')
  assert.throws(()=>validateFixtureArtifactApproval(h),/does not match/)
})

test('subscriber approval checks the raw API artifact that the fixture executes', t => {
  const h=harness(t)
  h.put('workers/api-feature.mjs','export default {fetch(){return new Response("changed")}}')
  assert.throws(()=>validateFixtureArtifactApproval(h),/workers approval does not match/)
})

test('rejects symlinks in assets, worker files and artifact directories', t => {
  const h=harness(t)
  symlinkSync('/etc/passwd',path.join(h.branchDir,'assets/api/link'))
  assert.throws(()=>validateFixtureArtifactApproval(h),/symlink/)
})
