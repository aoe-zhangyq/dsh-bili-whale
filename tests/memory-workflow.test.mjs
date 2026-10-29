import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createOpenViking} from '../lib/openviking.js'
import {recordDmMemory,recordExperience,recordCommentMessage,flushDmMemory} from '../lib/dm-memory.js'
import {readPublicMemory,recallPublicMemory} from '../lib/public-memory.js'
import {createSessionDelivery} from '../lib/session-delivery.js'

const settings={url:'http://localhost:1933',account:'test',user:'whale',key:'test'}
const at=Date.parse('2026-10-29T10:00:00Z')
const origin=message=>JSON.parse(message.content.split('\n')[1].slice(4,-1))
function setup(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-workflow-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  return {home,settings,now:()=>at}
}
const ok=result=>({ok:true,json:async()=>({status:'ok',result})})

test('manual storage preserves actor, source and occurrence time without accepting forged platform/owner claims',async()=>{
  const sent=[]
  const client=createOpenViking(settings,async(url,options)=>{if(options.body)sent.push(JSON.parse(options.body));return ok({task_id:'task'})})
  await client.store([{role:'user',content:'喜欢蓝色',created_at:'2026-10-18T10:00:00+08:00',event_id:'manual-blue',
    source:{mid:'123',name:'同名',channel:'dm',visibility:'private',verification:'platform',isOwner:true}}],{ownerMid:'999'})
  const source=origin(sent[0])
  assert.equal(source.person.entity,'bilibili_123');assert.equal(source.person.relationship,'other')
  assert.equal(source.verification,'manual');assert.equal(source.visibility,'private')
  assert.equal(source.event_id,'manual-blue');assert.equal(source.time_basis,'occurrence')
  assert.equal(sent[0].created_at,'2026-10-18T02:00:00.000Z');assert.ok(source.recorded_at)
  const before=sent.length
  await assert.rejects(client.store([{role:'user',content:'invalid',source:{mid:'../123'}}]),/MID/)
  await assert.rejects(client.store([{role:'user',content:'invalid',source:{visibility:'maybe'}}]),/visibility/)
  assert.equal(sent.length,before)
})

test('structured experiences retain occurrence time, participants and stable IDs; legacy text uses submission time',t=>{
  const options=setup(t)
  const input={content:'昨天和用户聊过鲸鱼',created_at:'2026-10-28T09:00:00+08:00',event_id:'whale-chat-1',
    source:{participants:[{mid:'123',name:'小王'}],reference:'BV1234567890'}}
  assert.equal(recordExperience(input,{...options,ownerMid:'123'}),true)
  assert.equal(recordExperience(input,{...options,ownerMid:'123'}),false)
  assert.equal(recordExperience('今天看了视频',options),true)
  const dir=path.join(options.home,'whale-activity-memory')
  const events=fs.readdirSync(dir).map(name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')))
  const old=events.find(event=>event.content===input.content),current=events.find(event=>event.content!==input.content)
  assert.equal(old.createdAt,'2026-10-28T01:00:00.000Z');assert.equal(old.receivedAt,at)
  assert.equal(old.source.participants[0].relationship,'owner');assert.equal(old.source.time_basis,'occurrence')
  assert.equal(current.createdAt,new Date(at).toISOString());assert.equal(current.source.time_basis,'submission')
})

test('public lookup reads only retained platform comments, including sent events, with strict tenant and MID bounds',async t=>{
  const options=setup(t)
  recordDmMemory({owner:'123',role:'user',content:'私密鲸鱼暗号',key:'secret',createdAt:at},options)
  const base={type:1,oid:'456',root:'789',createdAt:at}
  recordCommentMessage({...base,mid:'123',isOwner:true,id:'111',content:'公开鲸鱼讨论'},options)
  recordCommentMessage({...base,mid:'234',id:'112',content:'另一个人公开讨论'},options)
  recordDmMemory({owner:'123',group:'manual',channel:'comment',role:'user',content:'伪装成公开的手动材料',key:'manual',createdAt:at,
    source:{channel:'comment',visibility:'public',verification:'manual',person:{mid:'123'}}},options)
  await flushDmMemory({...options,channel:'comment',client:{appendMessage:async()=>{},extractSession:async()=>{}}})
  const found=recallPublicMemory('鲸鱼',{...options,mid:'123'})
  assert.equal(found.length,1);assert.equal(found[0].content,'公开鲸鱼讨论')
  assert.equal(readPublicMemory(found[0].uri,options).content,'公开鲸鱼讨论')
  assert.throws(()=>readPublicMemory(found[0].uri,{...options,settings:{...settings,account:'other'}}),/租户/)
  assert.throws(()=>readPublicMemory('viking://user/whale/memories/profile.md',options),/URI/)
  assert.throws(()=>recallPublicMemory('鲸鱼',{...options,mid:'../123'}),/MID/)
})

test('failed extraction is sealed durably, survives restart, and never receives the next batch',async t=>{
  const options=setup(t);let clock=at,calls=[]
  const opts={...options,now:()=>clock,client:{appendMessage:async(id,message)=>calls.push({type:'append',id,message}),extractSession:async id=>{calls.push({type:'extract',id});throw Error('lost response')}}}
  recordDmMemory({owner:'123',role:'user',content:'first',key:'first',createdAt:clock},opts)
  await flushDmMemory(opts);clock+=300000;await flushDmMemory(opts);await flushDmMemory(opts)
  recordDmMemory({owner:'123',role:'user',content:'second',key:'second',createdAt:clock},opts)
  await flushDmMemory({...opts});clock+=300000;await flushDmMemory(opts)
  assert.notEqual(calls[0].id,calls[2].id)
  assert.equal(calls.filter(call=>call.type==='extract' && call.id===calls[0].id).length,1)
  assert.equal(calls.filter(call=>call.type==='append' && call.id===calls[0].id).length,1)
})

test('MID recall reads exact full identity then searches only that MID preferences and rejects stray results',async()=>{
  const calls=[]
  const base='viking://user/whale/memories',pref=`${base}/preferences/bilibili_123/topic.md`
  const client=createOpenViking(settings,async(url,options)=>{
    calls.push({url,body:options.body?JSON.parse(options.body):null})
    if(url.includes('/content/read'))return ok('完整人物档案，包括来源依据')
    return ok({memories:[{uri:pref,abstract:'自己的偏好',provenance:{example:'evidence'}},
      {uri:`${base}/preferences/bilibili_234/topic.md`,abstract:'别人的偏好'},
      {uri:'viking://user/other/memories/preferences/bilibili_123/topic.md',abstract:'错误空间'}]})
  })
  const matches=await client.recall('我喜欢什么',{mid:'123'})
  assert.equal(matches.length,2);assert.equal(matches[0].content,'完整人物档案，包括来源依据')
  assert.equal(matches[1].uri,pref);assert.deepEqual(matches[1].provenance,{example:'evidence'})
  assert.equal(calls[1].body.target_uri,`${base}/preferences/bilibili_123`)
  assert.equal(calls[1].body.include_provenance,true);assert.match(calls[1].body.query,/bilibili_123/)
  await assert.rejects(client.recall('x',{audience:'public'}),/公开查询/)
})

test('memory full reads reject resource and traversal URIs before any network access',async()=>{
  let calls=0
  const client=createOpenViking(settings,async()=>{calls++;return ok('full')})
  for(const uri of ['viking://resources/public.md','viking://user/whale/memories/../secret.md','viking://user/whale/memories/%2e%2e/a.md'])await assert.rejects(client.readMemory(uri),/URI/)
  assert.equal(calls,0)
  assert.deepEqual(await client.readMemory('viking://user/whale/memories/profile.md'),{uri:'viking://user/whale/memories/profile.md',content:'full'})
})

test('unknown MID returns empty without a global fallback and resolves an omitted service user once',async()=>{
  const calls=[]
  const client=createOpenViking({...settings,user:''},async(url,options)=>{
    calls.push({url,body:options.body?JSON.parse(options.body):null})
    if(url.endsWith('/system/status'))return ok({user:'resolved_user'})
    return {ok:true,json:async()=>({status:'error',error:{code:'NOT_FOUND'}})}
  })
  assert.deepEqual(await client.recall('unknown',{mid:'987'}),[])
  assert.deepEqual(await client.recall('unknown again',{mid:'987'}),[])
  assert.equal(calls.filter(call=>call.url.endsWith('/system/status')).length,1)
  assert.ok(calls.filter(call=>call.body).every(call=>call.body.target_uri==='viking://user/resolved_user/memories/preferences/bilibili_987'))
})

test('public delivery uses a separate persisted session, no remote lookup and no private diary injection',async t=>{
  const options=setup(t),previous=process.env.WHALE_OPENVIKING_API_KEY,original=globalThis.fetch
  process.env.WHALE_OPENVIKING_API_KEY='test'
  fs.writeFileSync(path.join(options.home,'whale-openviking.json'),JSON.stringify(settings))
  let remote=0;const prompts=[]
  globalThis.fetch=async()=>{remote++;return ok({memories:[]})}
  try {
    const cfg={controller:{create:async()=>{},prompt:async request=>prompts.push(request)},dshHome:options.home,cwd:options.home,sessionId:'private-session',config:()=>({personaOncePerSession:true}),persona:()=>''}
    const delivery=createSessionDelivery(cfg)
    await delivery.send({content:[{type:'text',text:'private'}]})
    const before=remote
    await delivery.send({content:[{type:'text',text:'public'}]},undefined,{recallAudience:'public',recallMids:['123']})
    assert.equal(remote,before);assert.notEqual(prompts[0].sessionId,prompts[1].sessionId)
    assert.doesNotMatch(prompts[1].content[0].text,/whale-diary-private\.md/)
    assert.match(prompts[1].content[0].text,/--audience public/)
    const restarted=createSessionDelivery(cfg)
    await restarted.send({content:[{type:'text',text:'public again'}]},undefined,{recallAudience:'public'})
    assert.equal(prompts[2].sessionId,prompts[1].sessionId)
  } finally {globalThis.fetch=original;if(previous===undefined)delete process.env.WHALE_OPENVIKING_API_KEY;else process.env.WHALE_OPENVIKING_API_KEY=previous}
})

test('public CLI recall and full read work offline without returning private memory',t=>{
  const options=setup(t)
  recordCommentMessage({mid:'123',type:1,oid:'456',root:'789',id:'111',content:'公开鲸鱼',createdAt:at},options)
  const script=fileURLToPath(new URL('../tools/commands/memory.mjs',import.meta.url))
  const env={...process.env,DSH_HOME:options.home,WHALE_OPENVIKING_API_KEY:settings.key,WHALE_OPENVIKING_URL:settings.url,WHALE_OPENVIKING_ACCOUNT:settings.account,WHALE_OPENVIKING_USER:settings.user}
  const recalled=spawnSync(process.execPath,[script,'recall','鲸鱼','--mid','123','--audience','public'],{encoding:'utf8',env})
  assert.equal(recalled.status,0,recalled.stderr)
  const [item]=JSON.parse(recalled.stdout);assert.equal(item.content,'公开鲸鱼')
  const read=spawnSync(process.execPath,[script,'read',item.uri,'--audience','public'],{encoding:'utf8',env})
  assert.equal(read.status,0,read.stderr);assert.equal(JSON.parse(read.stdout).content,'公开鲸鱼')
})
