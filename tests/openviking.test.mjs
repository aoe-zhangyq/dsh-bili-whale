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
  assert.equal(JSON.parse(calls[0].options.body).target_uri, 'viking://~/memories')
  const stored = await client.store('主人喜欢猫')
  assert.equal(stored.taskId, 'task-1')
  assert.equal(JSON.parse(calls[1].options.body).content, '主人喜欢猫')
  assert.match(calls[2].url, /\/commit$/)
  assert.equal(calls[0].options.headers['X-API-Key'], 'test')
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
  } finally {
    globalThis.fetch=original
    if(previous===undefined) delete process.env.WHALE_OPENVIKING_API_KEY; else process.env.WHALE_OPENVIKING_API_KEY=previous
    if(previousUrl===undefined) delete process.env.WHALE_OPENVIKING_URL; else process.env.WHALE_OPENVIKING_URL=previousUrl
    fs.rmSync(dir,{recursive:true,force:true})
  }
})
