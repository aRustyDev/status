import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose'
import {createIngress} from './ingress.mjs'
import {createDispatcher} from '../../.github/actions/branch-previews/runtime/dispatcher.ts'

const origin='https://editor.example.com', issuer='https://test.cloudflareaccess.com'
const selector='branch-'+'a'.repeat(24), first='b'.repeat(40), second='c'.repeat(40)
const client='isolated-editor-client', audience='isolated-editor-audience'
let signingKey, keys
before(async()=>{const pair=await generateKeyPair('RS256',{extractable:true});signingKey=pair.privateKey;const jwk=await exportJWK(pair.publicKey);Object.assign(jwk,{kid:'test',alg:'RS256',use:'sig'});keys=createLocalJWKSet({keys:[jwk]})})
async function request() {
  const jwt=await new SignJWT({type:'app',common_name:client}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience(audience).setExpirationTime('5m').sign(signingKey)
  return new Request(origin+'/api/v1/bsp/admin/actions',{method:'POST',body:'{}',headers:{'X-Status-Preview':selector,'X-Status-Editor-Expected-Release':first,'Cf-Access-Jwt-Assertion':jwt,Origin:origin,'Content-Type':'application/json'}})
}

test('real dispatcher switching releases between checks preserves the expected-release fence',async()=>{
  let live=first,flagReads=0,writes=0,selected
  const FLAGS={getBooleanDetails:async()=>({value:true}),getObjectDetails:async()=>{flagReads++;if(flagReads===2)live=second;return {value:{selector,release:live}}}}
  const operation=(release)=>({fetch:async req=>{selected=release;if(req.headers.get('X-Status-Editor-Expected-Release')!==release)return new Response(null,{status:403});writes++;return new Response(null,{status:204})}})
  const dispatcher=createDispatcher()
  const denv={PREVIEW_HEADER:'X-Status-Preview',FLAG_PREFIX:'status-preview-',FLAGS,[`PREVIEW_BRANCH_${selector.slice(7).toUpperCase()}_${first.toUpperCase()}`]:operation(first),[`PREVIEW_BRANCH_${selector.slice(7).toUpperCase()}_${second.toUpperCase()}`]:operation(second)}
  const env={PREVIEW_EDITOR_ORIGIN:origin,PREVIEW_EDITOR_ISSUER:issuer,PREVIEW_EDITOR_AUD:audience,PREVIEW_EDITOR_CLIENT_ID:client,PREVIEW_SELECTOR:selector,PREVIEW_FLAG_PREFIX:'status-preview-',FLAGS,PREVIEW_DISPATCHER:{fetch:req=>dispatcher.fetch(req,denv)}}
  const res=await createIngress(()=>keys).fetch(await request(),env)
  assert.equal(res.status,503)
  assert.equal(selected,second)
  assert.equal(writes,0)
})

test('real dispatcher forwards a current release and strips reusable credentials',async()=>{
  let forwarded,writes=0
  const FLAGS={getBooleanDetails:async()=>({value:true}),getObjectDetails:async()=>({value:{selector,release:first}})}
  const dispatcher=createDispatcher()
  const op={fetch:async req=>{forwarded=req;if(req.headers.get('X-Status-Editor-Expected-Release')!==first)return new Response(null,{status:403});writes++;return new Response(null,{status:204})}}
  const denv={PREVIEW_HEADER:'X-Status-Preview',FLAG_PREFIX:'status-preview-',FLAGS,[`PREVIEW_BRANCH_${selector.slice(7).toUpperCase()}_${first.toUpperCase()}`]:op}
  const env={PREVIEW_EDITOR_ORIGIN:origin,PREVIEW_EDITOR_ISSUER:issuer,PREVIEW_EDITOR_AUD:audience,PREVIEW_EDITOR_CLIENT_ID:client,PREVIEW_SELECTOR:selector,PREVIEW_FLAG_PREFIX:'status-preview-',FLAGS,PREVIEW_DISPATCHER:{fetch:req=>dispatcher.fetch(req,denv)}}
  const res=await createIngress(()=>keys).fetch(await request(),env)
  assert.equal(res.status,204);assert.equal(res.headers.get('X-Status-Preview-Commit'),first);assert.equal(writes,1)
  assert.equal(forwarded.headers.get('X-Status-Editor-Expected-Release'),first)
  assert.equal(forwarded.headers.get('X-Status-Preview-Release'),first)
  assert.equal(forwarded.headers.get('CF-Access-Client-Secret'),null)
})
