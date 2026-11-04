import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {runtimeContext,memoryInstructions,memoryRuntimeGuide} from '../lib/runtime-context.js'
import {createSessionDelivery} from '../lib/session-delivery.js'
import {collectResourceFiles} from '../tools/lib/resource-snapshot.mjs'

test('runtime entry binds absolute executable, CLI and data home without leaking unrelated environment values',()=>{
  const text=runtimeContext({dshHome:"D:\\Fish Home\\O'Brien",cwd:'D:\\Work',biliMjs:'D:\\Plugin\\bili.mjs',nodeExe:'D:\\Node\\node.exe',
    runtimeEnv:{ELECTRON_RUN_AS_NODE:'1',OV_ROOT_KEY:'test-secret'},platform:'win32'})
  assert.match(text,/\$env:DSH_HOME='D:\\Fish Home\\O''Brien'/)
  assert.match(text,/\$env:ELECTRON_RUN_AS_NODE='1'/)
  assert.match(text,/& 'D:\\Node\\node.exe'/)
  assert.match(text,/不要假定工作目录里有 bili.mjs/)
  assert.doesNotMatch(text,/test-secret|OV_ROOT_KEY/)
})

test('routine memory instructions distinguish public and private work and exclude deployment details',()=>{
  const privateText=memoryInstructions('private'),publicText=memoryInstructions('public')
  assert.match(privateText,/memory experience/);assert.match(privateText,/content_truncated/)
  assert.match(publicText,/--audience public/);assert.doesNotMatch(publicText,/resource rebuild|diary read private/)
  for(const text of [privateText,publicText])assert.doesNotMatch(text,/custom_templates_dir|OV_ROOT_KEY|api\/v1\/admin|token|同租户授权/)
  const guide=fs.readFileSync(memoryRuntimeGuide,'utf8')
  assert.match(guide,/created_at/);assert.match(guide,/participants/)
  assert.doesNotMatch(guide,/custom_templates_dir|OV_ROOT_KEY|curl -|api\/v1\/admin/)
})

test('default resource collection includes the runtime guide and excludes human setup and experiment reports',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-docs-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const names=collectResourceFiles({home}).entries.map(item=>item.name)
  assert.ok(names.includes('manuals/memory-runtime.md'))
  assert.ok(names.every(name=>!/(?:OPENVIKING|README|VALIDATION|\.yaml)/.test(name)))
})

test('delivery teaches the runtime guide once per boot, retains a usable entry each time, and omits human deployment context',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-context-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const previousFetch=globalThis.fetch;let prompts=[]
  let searches=0
  const root='viking://user/whale/memories/events'
  globalThis.fetch=async()=>{
    const memories=[
      {uri:`${root}/.overview.md`,abstract:'directory metadata',score:0.9},
      ...(searches++===0?[{uri:`${root}/weak.md`,abstract:'weak match',score:0.201}]:
        [0.4,0.6,0.7,0.8].map(score=>({uri:`${root}/${score}.md`,abstract:'event',score}))),
    ]
    return {ok:true,json:async()=>({status:'ok',result:{memories}})}
  }
  fs.writeFileSync(path.join(home,'whale-openviking.json'),JSON.stringify({url:'http://localhost:1933',key:'test'}))
  const options={controller:{create:async()=>{},prompt:async request=>prompts.push(request.content[0].text)},
    dshHome:home,cwd:home,sessionId:'test',config:()=>({personaOncePerSession:true}),persona:()=>'',nodeExe:process.execPath}
  try {
    const delivery=createSessionDelivery(options)
    await delivery.send({content:[{type:'text',text:'first task'}]})
    await delivery.send({content:[{type:'text',text:'next task'}]})
    assert.match(prompts[0],/先读运行手册/);assert.ok(prompts[0].includes(memoryRuntimeGuide))
    assert.doesNotMatch(prompts[0],/OpenViking 回忆|directory metadata|weak match/)
    const matches=JSON.parse(prompts[1].split('\n').find(line=>line.startsWith('[{"uri"')))
    assert.deepEqual(matches.map(item=>item.score),[0.8,0.7,0.6])
    assert.doesNotMatch(prompts[1],/先读运行手册/)
    for(const text of prompts) {
      assert.match(text,/【运行入口】/);assert.ok(text.includes(process.execPath))
      assert.doesNotMatch(text,/OPENVIKING\.md|VALIDATION|custom_templates_dir|同租户授权|默认 7 天/)
    }
    await createSessionDelivery(options).send({content:[{type:'text',text:'restarted task'}]})
    assert.match(prompts[2],/先读运行手册/)
    await delivery.send({content:[{type:'text',text:'diary only'}]},undefined,{recallQuery:null})
    assert.equal(searches,3)
    assert.doesNotMatch(prompts[3],/OpenViking 回忆/)
  } finally {globalThis.fetch=previousFetch}
})
