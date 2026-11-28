import { branchPreviewEmailProxy } from './preview-mailer.mjs'

const encoder = new TextEncoder()

async function boundedJson(request) {
  const length=request.headers.get('content-length')
  if ((length !== null && (!/^\d+$/.test(length) || Number(length)>512)) || !request.body) return null
  const reader=request.body.getReader(), chunks=[]
  let size=0
  for (;;) {
    const {value,done}=await reader.read()
    if (done) break
    size+=value.byteLength
    if (size>512) { void reader.cancel().catch(()=>{}); return null }
    chunks.push(value)
  }
  const bytes=new Uint8Array(size)
  let offset=0
  for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength}
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) } catch { return null }
}

// Runs in a private feature-dispatch Worker. It receives only the preview-owned
// application D1 and the restricted mailer service, never the central fence.
export async function dispatchBranchSubscribers(request, env, dispatch, contract, contextContract) {
  const {PREVIEW_SELECTOR:selector,PREVIEW_RELEASE:release,PREVIEW_SUBSCRIBER_SCOPE:scope,PREVIEW_SCHEDULE_SECRET:secret,PREVIEW_MAILER:mailer,DB}=env
  if (request.method!=='POST' || new URL(request.url).pathname!=='/__preview/scheduled' || contract!==2 || contextContract!==1 || env.PREVIEW_BRANCH_DELIVERY_CONTEXT!=='true' || typeof dispatch!=='function' ||
      !/^branch-[a-f0-9]{24}$/.test(selector||'') || !/^[a-f0-9]{40}$/.test(release||'') || !/^[a-f0-9]{64}$/.test(scope||'') ||
      env.PREVIEW_DATABASE_ISOLATED!=='true' || typeof secret!=='string' || secret.length<32 || !DB || !mailer || env.PREVIEW_FENCE || env.INVENTORY || env.FLAGS || env.EMAIL) return new Response(null,{status:403})
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(selector))
  if ([...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')!==scope) return new Response(null,{status:403})
  try {
    const signature=request.headers.get('x-preview-schedule-signature')||''
    const body=await boundedJson(request)
    if (!/^[a-f0-9]{64}$/.test(signature) || !Number.isSafeInteger(body?.scheduledTime) || Math.abs(Date.now()-body.scheduledTime)>120000) return new Response(null,{status:403})
    const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify'])
    const bytes=Uint8Array.from(signature.match(/../g),x=>parseInt(x,16))
    if (!await crypto.subtle.verify('HMAC',key,bytes,encoder.encode(String(body.scheduledTime)))) return new Response(null,{status:403})
    // Contract 2 requires its local scope lease. This row is safe only because
    // the controller verifies and binds a D1 owned by this release.
    const result=await DB.prepare(`INSERT INTO preview_subscriber_leases (scope,slot,target,release,expires_at)
      VALUES (?,1,'a',?,?) ON CONFLICT(slot) DO UPDATE SET expires_at=excluded.expires_at
      WHERE preview_subscriber_leases.scope=excluded.scope AND preview_subscriber_leases.release=excluded.release
      AND preview_subscriber_leases.target=excluded.target`).bind(scope,release,Date.now()+90000).run()
    if (result?.meta?.changes!==1) return new Response(null,{status:409})
    // No lease token or central control service crosses into branch code. The
    // restricted mailer independently acquires an authoritative fence lease.
    const {PREVIEW_SCHEDULE_SECRET:_secret,PREVIEW_MAILER:_mailer, ...safe}=env
    void [_secret, _mailer] // Omit the signing secret and direct mailer from feature code.
    await dispatch({...safe,PREVIEW_SLOT:'1',PREVIEW_TARGET:'a',SUBSCRIBER_EMAIL:branchPreviewEmailProxy(mailer)},async()=>true)
    return new Response(null,{status:204})
  } catch { return new Response(null,{status:503}) }
}
