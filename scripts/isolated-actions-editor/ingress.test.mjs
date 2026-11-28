import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose'
import {createIngress} from './ingress.mjs'

const origin='https://editor.example.com', issuer='https://test.cloudflareaccess.com'
const selector='branch-'+'a'.repeat(24), first='b'.repeat(40), second='c'.repeat(40)
const client='isolated-editor-client', audience='isolated-editor-audience'
let signingKey, keys
before(async()=>{const pair=await generateKeyPair('RS256',{extractable:true});signingKey=pair.privateKey;const jwk=await exportJWK(pair.publicKey);Object.assign(jwk,{kid:'test',alg:'RS256',use:'sig'});keys=createLocalJWKSet({keys:[jwk]})})
const worker=createIngress(()=>keys)
async function token(claims={}) {return new SignJWT({type:'app',common_name:client,...claims}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(signingKey)}
async function request(path,{method='GET',release=first,jwt,headers={},body}={}) {
  return new Request(origin+path,{method,headers:{'X-Status-Preview':selector,'X-Status-Editor-Expected-Release':release,'Cf-Access-Jwt-Assertion':jwt??await token(),...headers},...(body?{body}:{})})
}
function setup(release=first) {
  let live=release, calls=0, writes=0, forwarded, afterPrecheck
  const env={PREVIEW_EDITOR_ORIGIN:origin,PREVIEW_EDITOR_ISSUER:issuer,PREVIEW_EDITOR_AUD:audience,PREVIEW_EDITOR_CLIENT_ID:client,PREVIEW_SELECTOR:selector,PREVIEW_FLAG_PREFIX:'status-preview-',
    FLAGS:{getBooleanDetails:async()=>({value:true}),getObjectDetails:async()=>({value:{selector,release:live}})},
    PREVIEW_DISPATCHER:{fetch:async req=>{calls++;forwarded=req;if(afterPrecheck)afterPrecheck();const routed=live;const allowed=req.headers.get('X-Status-Editor-Expected-Release')===routed;if(req.method!=='GET'&&allowed)writes++;return new Response(null,{status:allowed?204:403,headers:{'X-Status-Preview-Commit':routed}})}}}
  return {env,setRelease(value){live=value},onDispatch(f){afterPrecheck=f},get calls(){return calls},get writes(){return writes},get forwarded(){return forwarded}}
}

test('editor forwards only authenticated exact-current-release requests, stripping credentials and spoofed internal headers',async()=>{
  const h=setup(),req=await request('/api/v1/bsp/admin/actions',{method:'POST',body:'{}',headers:{Origin:origin,'Content-Type':'application/json','CF-Access-Client-Id':'x','CF-Access-Client-Secret':'x',Cookie:'private=x',Authorization:'Bearer x','X-Status-Preview-Release':second,'X-Status-Identity-Method':'GET'}})
  const res=await worker.fetch(req,h.env)
  assert.equal(res.status,204);assert.equal(h.calls,1);assert.equal(h.writes,1)
  assert.equal(res.headers.get('X-Status-Preview-Commit'),first)
  assert.equal(h.forwarded.headers.get('X-Status-Editor-Expected-Release'),first)
  for(const name of ['CF-Access-Client-Id','CF-Access-Client-Secret','Cookie','Authorization','X-Status-Preview-Release','X-Status-Identity-Method']) assert.equal(h.forwarded.headers.get(name),null)
  assert.equal(h.forwarded.headers.get('X-Status-Preview'),selector)
})

test('a redeploy accepts only a newly requested exact release and rejects stale or missing revision',async()=>{
  const h=setup();h.setRelease(second)
  assert.equal((await worker.fetch(await request('/api/v1/auth/me'),h.env)).status,503)
  assert.equal((await worker.fetch(await request('/api/v1/auth/me',{release:''}),h.env)).status,503)
  assert.equal((await worker.fetch(await request('/api/v1/auth/me',{release:second}),h.env)).status,204)
  assert.equal(h.calls,1)
})

test('a release switch between ingress and dispatcher cannot write the replacement database',async()=>{
  const h=setup();h.onDispatch(()=>h.setRelease(second))
  const res=await worker.fetch(await request('/api/v1/bsp/admin/actions',{method:'POST',body:'{}',headers:{Origin:origin,'Content-Type':'application/json'}}),h.env)
  assert.equal(res.status,503);assert.equal(h.calls,1);assert.equal(h.writes,0)
})

test('missing or wrong dispatcher revision is never returned as success',async()=>{
  const h=setup();h.env.PREVIEW_DISPATCHER={fetch:async()=>new Response(null,{status:204})}
  assert.equal((await worker.fetch(await request('/api/v1/auth/me'),h.env)).status,503)
  h.env.PREVIEW_DISPATCHER={fetch:async()=>new Response(null,{status:204,headers:{'X-Status-Preview-Commit':second}})}
  assert.equal((await worker.fetch(await request('/api/v1/auth/me'),h.env)).status,503)
})

test('wrong origin, client, token type, route, selector and method fail closed',async()=>{
  const h=setup()
  assert.equal((await worker.fetch(await request('/api/v1/auth/me',{jwt:await token({common_name:'other'})}),h.env)).status,401)
  assert.equal((await worker.fetch(await request('/api/v1/auth/me',{jwt:await token({type:'human'})}),h.env)).status,401)
  const wrongAudience=await new SignJWT({type:'app',common_name:client}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience('other').setExpirationTime('5m').sign(signingKey)
  const wrongIssuer=await new SignJWT({type:'app',common_name:client}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://other.cloudflareaccess.com').setAudience(audience).setExpirationTime('5m').sign(signingKey)
  const expired=await new SignJWT({type:'app',common_name:client}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience(audience).setExpirationTime('1s ago').sign(signingKey)
  for(const jwt of [wrongAudience,wrongIssuer,expired,'invalid.jwt.value']) assert.equal((await worker.fetch(await request('/api/v1/auth/me',{jwt}),h.env)).status,401)
  assert.equal((await worker.fetch(await request('/api/v1/auth/me',{headers:{'X-Status-Preview':'branch-'+'f'.repeat(24)}}),h.env)).status,503)
  assert.equal((await worker.fetch(await request('/api/v1/bsp/admin/users'),h.env)).status,404)
  assert.equal((await worker.fetch(await request('/api/v1/bsp/admin/vaults',{method:'POST',body:'{}',headers:{Origin:origin,'Content-Type':'application/json'}}),h.env)).status,404)
  assert.equal((await worker.fetch(await request('/api/v1/bsp/admin/actions',{method:'POST',body:'{}',headers:{Origin:'https://other.example','Content-Type':'application/json'}}),h.env)).status,403)
  assert.equal((await worker.fetch(await request('/api/v1/auth/me'),{...h.env,PREVIEW_EDITOR_ORIGIN:'https://status.sow.foo'})).status,503)
  assert.equal(h.calls,0)
})

test('disabled, malformed, or failing flags do not route',async()=>{
  const h=setup()
  for(const FLAGS of [
    {getBooleanDetails:async()=>({value:false}),getObjectDetails:async()=>({value:{selector,release:first}})},
    {getBooleanDetails:async()=>({value:true}),getObjectDetails:async()=>({value:{selector:'other',release:first}})},
    {getBooleanDetails:async()=>({value:true}),getObjectDetails:async()=>({value:{selector,release:'bad'}})},
    {getBooleanDetails:async()=>({value:true}),getObjectDetails:async()=>({errorCode:'error',value:{selector,release:first}})},
    {getBooleanDetails:async()=>{throw Error('unavailable')},getObjectDetails:async()=>({value:{selector,release:first}})},
  ]) assert.equal((await worker.fetch(await request('/api/v1/auth/me'),{...h.env,FLAGS})).status,503)
  assert.equal(h.calls,0)
})
