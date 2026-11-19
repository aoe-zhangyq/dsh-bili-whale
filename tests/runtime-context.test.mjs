import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {runtimeContext} from '../lib/runtime-context.js'
import {createSessionDelivery} from '../lib/session-delivery.js'
import {collectResourceFiles} from '../tools/lib/resource-snapshot.mjs'

test('runtime entry binds absolute executable, CLI and data home without leaking unrelated environment values',()=>{
  const text=runtimeContext({dshHome:"D:\\Fish Home\\O'Brien",cwd:'D:\\Work',biliMjs:'D:\\Plugin\\bili.mjs',nodeExe:'D:\\Node\\node.exe',
    runtimeEnv:{ELECTRON_RUN_AS_NODE:'1',OV_ROOT_KEY:'test-secret'},platform:'win32'})
  assert.match(text,/\$env:DSH_HOME='D:\\Fish Home\\O''Brien'/)
  assert.match(text,/\$env:ELECTRON_RUN_AS_NODE='1'/)
  assert.match(text,/& 'D:\\Node\\node.exe'/)
  assert.match(text,/不要假定工作目录里有 bili.mjs/)
  assert.doesNotMatch(text,/test-secret|OV_ROOT_KEY|WHALE_DSH_SESSION_ID/)
})

test('default resource collection includes the runtime guide and excludes human setup and experiment reports',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-docs-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const names=collectResourceFiles({home}).entries.map(item=>item.name)
  assert.ok(names.includes('manuals/memory-runtime.md'))
  assert.ok(names.every(name=>!/(?:OPENVIKING|README|VALIDATION|\.yaml)/.test(name)))
})

test('private delivery uses local instructions without querying or prompting for OpenViking',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-context-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  fs.writeFileSync(path.join(home,'whale-openviking.json'),JSON.stringify({url:'http://localhost:1933',key:'test'}))
  const prompts=[]
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected request')})
  const options={controller:{create:async()=>{},prompt:async request=>prompts.push(request.content[0].text)},
    dshHome:home,cwd:home,sessionId:'test',config:()=>({personaOncePerSession:true}),persona:()=>'本地人设'}
  const delivery=createSessionDelivery(options)
  await delivery.send({content:[{type:'text',text:'first task'}]})
  await delivery.send({content:[{type:'text',text:'next task'}]})
  await createSessionDelivery(options).send({content:[{type:'text',text:'restarted task'}]})
  assert.equal(network.mock.callCount(),0)
  assert.match(prompts[0],/本地人设[\s\S]*whale-diary-private\.md[\s\S]*first task/)
  assert.doesNotMatch(prompts[1],/whale-diary-private\.md/)
  assert.match(prompts[2],/本地人设[\s\S]*whale-diary-private\.md[\s\S]*restarted task/)
  for(const text of prompts) {
    assert.match(text,/【运行入口】/)
    assert.ok(text.includes(process.execPath))
    assert.doesNotMatch(text,/WHALE_DSH_SESSION_ID|OpenViking|memory (recall|read|experience)|memory-runtime/)
  }
})
