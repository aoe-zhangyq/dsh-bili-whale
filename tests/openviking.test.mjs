import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenViking, openVikingSettings, saveOpenVikingFile, readOpenVikingFile } from '../lib/openviking.js'
import { createSessionDelivery } from '../lib/session-delivery.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('OpenViking recall is scoped and commit returns a background task', async () => {
  const calls = []
  const client = createOpenViking({url:'http://localhost:1933',key:'test'}, async (url, options) => {
    calls.push({url, options})
    const result = url.endsWith('/find') ? {memories:[{uri:'viking://x',abstract:'喜欢猫'}]} : url.endsWith('/commit') ? {task_id:'task-1'} : {}
    return {ok:true, json:async()=>({status:'ok',result})}
  })
  assert.equal((await client.recall('喜好'))[0].abstract, '喜欢猫')
  assert.equal(JSON.parse(calls[0].options.body).target_uri, undefined)
  const stored = await client.store('主人喜欢猫')
  assert.equal(stored.taskId, 'task-1')
  assert.ok(JSON.parse(calls[1].options.body).content.endsWith('主人喜欢猫'))
  assert.match(calls[2].url, /\/commit$/)
  assert.equal(calls[0].options.headers['X-API-Key'], 'test')
})

test('store preserves original roles and timestamps, and validates before writing', async () => {
  const calls=[]
  const client=createOpenViking({url:'http://localhost',key:'test'},async (url,options)=>{
    calls.push({url,body:options.body === undefined ? undefined : JSON.parse(options.body)})
    return {ok:true,json:async()=>({status:'ok',result:url.endsWith('commit')?{task_id:'x'}:{}})}
  })
  const messages=[{role:'user',content:'我喜欢猫',created_at:'2026-10-18T10:00:00+08:00'},{role:'assistant',content:'记住了'}]
  const result=await client.store(messages)
  assert.equal(result.taskId,'x')
  assert.equal(calls[0].body.role,'user');assert.ok(calls[0].body.content.endsWith(messages[0].content))
  assert.equal(Date.parse(calls[0].body.created_at),Date.parse(messages[0].created_at))
  assert.equal(calls[1].body.role,'assistant');assert.ok(calls[1].body.content.endsWith(messages[1].content))
  assert.match(calls[2].url,/commit$/)
  const count=calls.length
  await assert.rejects(client.store([{role:'user',content:'x',created_at:'yesterday'}]),/消息时间/)
  assert.equal(calls.length,count)
})

test('private chat appends and extracts without committing the session', async () => {
  const calls=[]
  const client=createOpenViking({url:'http://localhost',key:'test'},async (url,options)=>{
    calls.push({url,options}); return {ok:true,json:async()=>({status:'ok',result:[]})}
  })
  const id='whale-dm-12345678-abcd'
  await client.appendMessage(id,{role:'user',content:'hello',created_at:'2026-10-29T10:00:00Z'})
  await client.extractSession(id)
  assert.match(calls[0].url,/\/messages$/); assert.match(calls[1].url,/\/extract$/)
  assert.equal(JSON.parse(calls[0].options.body).role,'user')
  assert.equal(calls.some(x=>x.url.endsWith('/commit')),false)
})

test('explicit readable session IDs are accepted and unsafe path strings are rejected before requests',async()=>{
  const urls=[]
  const client=createOpenViking({url:'http://localhost',key:'test'},async url=>{
    urls.push(url);return {ok:true,json:async()=>({status:'ok',result:[]})}
  })
  await client.appendMessage('bili_dm_123456',{role:'user',content:'hello'})
  await client.extractSession('bili_dm_123456')
  assert.equal(urls[0],'http://localhost/api/v1/sessions/bili_dm_123456/messages')
  for(const id of ['', '../escape', 'x/y', 'x?foo=1', 'x#fragment', 'x'.repeat(201),null]) {
    await assert.rejects(client.appendMessage(id,{role:'user',content:'hello'}),/会话 ID/)
    await assert.rejects(client.extractSession(id),/会话 ID/)
  }
  assert.equal(urls.length,2)
})

test('missing credentials disable integration and errors are visible', async () => {
  assert.equal(openVikingSettings({}, path.join(os.tmpdir(), 'whale-nonexistent-settings-test.json')), null)
  const client = createOpenViking({url:'http://localhost',key:'test'}, async()=>({ok:false,status:401}))
  await assert.rejects(client.recall('x'), /401/)
})

test('settings preserve and redact key, support disable and use configured identity headers', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-ov-settings-'))
  const file=path.join(dir,'settings.json')
  const protect = file => fs.chmodSync(file, 0o600)
  try {
    const initial={enabled:true,url:'http://127.0.0.1:1933',account:'aoe',user:'whale',key:'private-key'}
    const saved=saveOpenVikingFile(initial,file,protect)
    assert.equal(saved.hasKey,true)
    assert.equal(JSON.stringify(saved).includes('private-key'),false)
    saveOpenVikingFile({...initial,url:'http://127.0.0.1:1234',key:''},file,protect)
    const settings=openVikingSettings({},file)
    assert.equal(settings.key,'private-key')
    let headers
    await createOpenViking(settings,async (_url, options)=>{headers=options.headers;return {ok:true,json:async()=>({status:'ok',result:{memories:[]}})}}).recall('测试')
    assert.equal(headers['X-OpenViking-Account'],'aoe')
    assert.equal(headers['X-OpenViking-User'],'whale')
    assert.throws(()=>saveOpenVikingFile({...initial,url:'https://user:pass@example.com'},file,protect))
    assert.equal(readOpenVikingFile(file).key,'private-key')
    saveOpenVikingFile({...initial,enabled:false,clearKey:true},file,protect)
    assert.equal(openVikingSettings({WHALE_OPENVIKING_API_KEY:'env-key'},file),null)
    assert.equal(readOpenVikingFile(file).key,'')
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})

test('memory outage does not prevent delivery or remove diary instruction', async () => {
  const previous = process.env.WHALE_OPENVIKING_API_KEY
  const previousUrl = process.env.WHALE_OPENVIKING_URL
  const original = globalThis.fetch
  process.env.WHALE_OPENVIKING_API_KEY='test'
  process.env.WHALE_OPENVIKING_URL='http://localhost'
  globalThis.fetch=async()=>{throw Error('offline')}
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-memory-'))
  try {
    let sent
    const delivery=createSessionDelivery({controller:{create:async()=>{},prompt:async x=>{sent=x}},dshHome:dir,cwd:dir,sessionId:'test',config:()=>({}),persona:()=>''})
    await delivery.send({content:[{type:'text',text:'hello'}]})
    assert.match(sent.content[0].text,/OpenViking 暂不可用/)
    assert.match(sent.content[0].text,/whale-diary/)
    assert.match(sent.content[0].text,/video-card save/)
  } finally {
    globalThis.fetch=original
    if(previous===undefined) delete process.env.WHALE_OPENVIKING_API_KEY; else process.env.WHALE_OPENVIKING_API_KEY=previous
    if(previousUrl===undefined) delete process.env.WHALE_OPENVIKING_URL; else process.env.WHALE_OPENVIKING_URL=previousUrl
    fs.rmSync(dir,{recursive:true,force:true})
  }
})

test('delivery searches the supplied conversation instead of the instruction prompt', async () => {
  const previous=process.env.WHALE_OPENVIKING_API_KEY, original=globalThis.fetch
  process.env.WHALE_OPENVIKING_API_KEY='test'
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-query-'));let query
  globalThis.fetch=async (_url,options)=>{query=JSON.parse(options.body).query;return {ok:true,json:async()=>({status:'ok',result:{memories:[]}})}}
  try {
    const delivery=createSessionDelivery({controller:{create:async()=>{},prompt:async()=>{}},dshHome:dir,cwd:dir,sessionId:'test',config:()=>({}),persona:()=>''})
    await delivery.send({content:[{type:'text',text:'漫长的操作说明'}]},undefined,{recallQuery:'我喜欢鲸鱼'})
    assert.equal(query,'我喜欢鲸鱼')
  } finally {
    globalThis.fetch=original
    if(previous===undefined)delete process.env.WHALE_OPENVIKING_API_KEY;else process.env.WHALE_OPENVIKING_API_KEY=previous
    fs.rmSync(dir,{recursive:true,force:true})
  }
})
