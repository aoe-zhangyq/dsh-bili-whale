import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { collectResourceFiles, rebuildResourceSnapshot, readSnapshot, withActiveSnapshot } from '../tools/lib/resource-snapshot.mjs'
import { makeResourceZip } from '../tools/lib/resource-zip.mjs'
import { createOpenViking } from '../lib/openviking.js'
import { saveLocalVideoCard } from '../tools/lib/video-card.mjs'

function setup() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-snapshot-')),docsDir=path.join(home,'docs')
  fs.mkdirSync(docsDir);fs.writeFileSync(path.join(docsDir,'manual.md'),'# 手册\n内容')
  fs.writeFileSync(path.join(home,'whale-diary-private.md'),'# 私人日记\n内容')
  return {home,docsDir,settings:{url:'http://localhost',account:'tester',user:'cs_1',key:'key'}}
}
const remove=x=>fs.rmSync(x.home,{recursive:true,force:true})

test('ZIP contains valid compressed bytes and refuses unsafe names',()=>{
  const zip=makeResourceZip([{name:'diary/private.md',data:'你好'}])
  assert.equal(zip.readUInt32LE(0),0x04034b50)
  const nameLen=zip.readUInt16LE(26),size=zip.readUInt32LE(18)
  assert.equal(inflateRawSync(zip.subarray(30+nameLen,30+nameLen+size)).toString(),'你好')
  assert.throws(()=>makeResourceZip([{name:'../private',data:'x'}]),/文件名/)
})

test('video cards are stored locally without requiring the OpenViking service',async()=>{
  const x=setup()
  try {
    const input=path.join(x.home,'card.json')
    fs.writeFileSync(input,JSON.stringify({bvid:'BV1abC2De3F4',title:'珊瑚',summary:'本地观察'}))
    const env={...process.env,DSH_HOME:x.home,WHALE_OPENVIKING_API_KEY:'',WHALE_OPENVIKING_URL:''}
    const script=fileURLToPath(new URL('../tools/commands/video-card.mjs',import.meta.url))
    const out=await promisify(execFile)(process.execPath,[script,'save',input],{env})
    assert.match(out.stdout,/本地资料卡已保存/)
    assert.match(fs.readFileSync(path.join(x.home,'whale-video-cards','BV1abC2De3F4.md'),'utf8'),/本地观察/)
    assert.throws(()=>saveLocalVideoCard({bvid:'../bad',title:'标题',summary:'摘要'},path.join(x.home,'whale-video-cards')),/BV/)
  } finally {remove(x)}
})

test('rebuild swaps after validation and removes only the old generation',async()=>{
  const x=setup(),calls=[];let lastRoot
  const client={async importSnapshot(root){calls.push(['import',root]);lastRoot=root;return {usage:{llmInputTokens:100,llmOutputTokens:20,embeddingTokens:50,durationMs:1000}}},async snapshotTree(root){return collectResourceFiles(x).entries.map(e=>({uri:root+'/'+e.name,isDir:false}))},async removeSnapshot(root){assert.equal(readSnapshot(x).root,lastRoot);calls.push(['remove',root])}}
  try {
    saveLocalVideoCard({bvid:'BV1abC2De3F4',title:'标题',summary:'摘要'},path.join(x.home,'whale-video-cards'))
    const first=await rebuildResourceSnapshot({...x,client});assert.equal(first.status,'rebuilt');assert.equal(readSnapshot(x).usage.llmInputTokens,100)
    fs.writeFileSync(path.join(x.home,'whale-diary-private.md'),'# 新日记')
    const second=await rebuildResourceSnapshot({...x,client})
    assert.notEqual(first.root,second.root);assert.deepEqual(calls.at(-1),['remove',first.root]);assert.equal(readSnapshot(x).root,second.root)
    assert.equal((await rebuildResourceSnapshot({...x,client,onlyIfDue:true})).status,'not_due')
    assert.equal(await withActiveSnapshot(x,s=>s.root),second.root)
    assert.equal(readSnapshot({...x,settings:{...x.settings,account:'other'}}),null)
    assert.equal(readSnapshot({...x,settings:{...x.settings,key:'rotated'}}).root,second.root)
  } finally {remove(x)}
})

test('configured interval limits model work and still rebuilds the complete snapshot',async()=>{
  const x=setup(),DAY=86400000;let clock=1800000000000,imports=0
  const client={async importSnapshot(){imports++},async snapshotTree(root){return collectResourceFiles(x).entries.map(e=>({uri:root+'/'+e.name}))},async removeSnapshot(){}}
  try {
    const first=await rebuildResourceSnapshot({...x,client,now:()=>clock});assert.equal(imports,1)
    fs.writeFileSync(path.join(x.home,'whale-diary-private.md'),'日记已更新')
    clock+=DAY;const skipped=await rebuildResourceSnapshot({...x,client,onlyIfDue:true,now:()=>clock})
    assert.equal(skipped.status,'not_due');assert.equal(skipped.root,first.root);assert.equal(imports,1)
    assert.equal((await rebuildResourceSnapshot({...x,client,onlyIfDue:true,now:()=>clock})).status,'not_due')
    clock+=6*DAY;const weekly=await rebuildResourceSnapshot({...x,client,onlyIfDue:true,now:()=>clock})
    assert.equal(weekly.status,'rebuilt');assert.equal(imports,2)
    clock+=DAY
    assert.equal((await rebuildResourceSnapshot({...x,client,onlyIfDue:true,intervalDays:1,now:()=>clock})).status,'rebuilt');assert.equal(imports,3)
    await assert.rejects(rebuildResourceSnapshot({...x,client,intervalDays:0,now:()=>clock}),/1 至 365/)
  } finally {remove(x)}
})

test('failed import and incomplete tree never replace an active snapshot',async()=>{
  const x=setup();let mode='ok',active
  const client={async importSnapshot(){if(mode==='fail')throw Error('offline');if(mode==='change')fs.writeFileSync(path.join(x.home,'whale-diary-private.md'),'修改中')},async snapshotTree(root){return mode==='incomplete'?[]:collectResourceFiles(x).entries.map(e=>({uri:root+'/'+e.name}))},async removeSnapshot(root){assert.notEqual(root,active)}}
  try {
    const first=await rebuildResourceSnapshot({...x,client});active=first.root
    for(const next of ['fail','incomplete']) {mode=next;await assert.rejects(rebuildResourceSnapshot({...x,client}),/未启用/);assert.equal(readSnapshot(x).root,first.root)}
  } finally {remove(x)}
})

test('edits made after capture do not starve a long rebuild',async()=>{
  const x=setup(),before=collectResourceFiles(x).digest
  const client={async importSnapshot(){fs.writeFileSync(path.join(x.home,'whale-diary-private.md'),'导入期间的修改')},async snapshotTree(root){return collectResourceFiles(x).entries.map(e=>({uri:root+'/'+e.name}))},async removeSnapshot(){}}
  try {await rebuildResourceSnapshot({...x,client});assert.equal(readSnapshot(x).sourceDigest,before);assert.notEqual(collectResourceFiles(x).digest,before)} finally {remove(x)}
})

test('failed cleanup keeps the new snapshot active and records the old one',async()=>{
  const x=setup();let fail=false
  const client={async importSnapshot(){},async snapshotTree(root){return collectResourceFiles(x).entries.map(e=>({uri:root+'/'+e.name}))},async removeSnapshot(){if(fail)throw Error('busy')}}
  try {const first=await rebuildResourceSnapshot({...x,client});fail=true;const second=await rebuildResourceSnapshot({...x,client});assert.ok(second.cleanupWarning);assert.equal(readSnapshot(x).root,second.root);assert.equal(readSnapshot(x).previous,first.root)} finally {remove(x)}
})

test('an interrupted build is cleaned on the next check without deleting the active snapshot',async()=>{
  const x=setup(),removed=[];let fail=false,orphan
  const client={async importSnapshot(root){if(fail){orphan=root;throw Error('timeout')}},async snapshotTree(root){return collectResourceFiles(x).entries.map(e=>({uri:root+'/'+e.name}))},async removeSnapshot(root){removed.push(root)}}
  try {
    const active=await rebuildResourceSnapshot({...x,client})
    fail=true;await assert.rejects(rebuildResourceSnapshot({...x,client}),/未启用/)
    assert.equal(readSnapshot(x).root,active.root)
    assert.equal((await rebuildResourceSnapshot({...x,client,onlyIfDue:true})).status,'not_due')
    assert.deepEqual(removed,[orphan]);assert.equal(readSnapshot(x).root,active.root)
  } finally {remove(x)}
})

test('a reader of the old snapshot prevents a concurrent switch and deletion',async()=>{
  const x=setup(),removed=[]
  const client={async importSnapshot(){},async snapshotTree(root){return collectResourceFiles(x).entries.map(e=>({uri:root+'/'+e.name}))},async removeSnapshot(root){removed.push(root)}}
  let finish,entered
  try {
    const first=await rebuildResourceSnapshot({...x,client})
    const started=new Promise(r=>entered=r)
    const reader=withActiveSnapshot(x,async()=>{entered();await new Promise(r=>finish=r)})
    await started
    await assert.rejects(rebuildResourceSnapshot({...x,client}),/切换锁不可用/)
    assert.equal(readSnapshot(x).root,first.root);assert.equal(removed.length,0)
    finish();await reader
    await rebuildResourceSnapshot({...x,client})
    assert.ok(removed.includes(first.root))
  } finally {if(finish)finish();remove(x)}
})

test('HTTP snapshot operations scope searches and prohibit unsafe deletion',async()=>{
  const calls=[]
  const client=createOpenViking({url:'http://localhost',key:'key'},async(url,opts)=>{
    calls.push({url,opts})
    if(url.endsWith('temp_upload'))return {ok:true,json:async()=>({status:'ok',result:{temp_file_id:'x.zip'}})}
    if(url.endsWith('/resources'))return {ok:true,json:async()=>({status:'ok',result:{status:'success',root_uri:'viking://resources/whale-snapshot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',errors:[],queue_status:{Semantic:{error_count:0,requeue_count:0}}},telemetry:{summary:{duration_ms:1200,tokens:{llm:{input:100,output:20},embedding:{total:50}}}}})}
    return {ok:true,json:async()=>({status:'ok',result:{resources:[]}})}
  })
  const root='viking://resources/whale-snapshot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const imported=await client.importSnapshot(root,Buffer.from('zip'))
  assert.deepEqual(imported.usage,{durationMs:1200,llmInputTokens:100,llmOutputTokens:20,embeddingTokens:50})
  assert.equal(JSON.parse(calls[1].opts.body).reason,'')
  await assert.rejects(client.removeSnapshot('viking://resources'),/无效/)
})

test('legacy cleanup only deletes known roots when local originals exist',async()=>{
  const deleted=[]
  const client=createOpenViking({url:'http://localhost',key:'key'},async(url,opts)=>{
    const u=new URL(url),target=u.searchParams.get('uri')
    if(opts.method==='DELETE'){deleted.push(target);return {ok:true,json:async()=>({status:'ok',result:{}})}}
    if(target==='viking://resources/whale/videos')return {ok:true,json:async()=>({status:'ok',result:[{uri:target+'/BV1abC2De3F4',isDir:true},{uri:target+'/BV1abC2De3F4/BV1abC2De3F4.md',isDir:false}]})}
    return {ok:false,status:404,json:async()=>({})}
  })
  const missing=await client.cleanupLegacy([])
  assert.equal(deleted.length,0);assert.match(missing.join(''),/本地缺失/)
  assert.deepEqual(await client.cleanupLegacy([{name:'videos/BV1abC2De3F4.md'}]),[])
  assert.deepEqual(deleted,['viking://resources/whale/videos'])
})

test('legacy diary cleanup preserves unrelated remote files',async()=>{
  const deleted=[]
  const client=createOpenViking({url:'http://localhost',key:'key'},async(url,opts)=>{
    const u=new URL(url),target=u.searchParams.get('uri')
    if(opts.method==='DELETE'){deleted.push(target);return {ok:true,json:async()=>({status:'ok',result:{}})}}
    if(target==='viking://resources/whale-diary-private')return {ok:true,json:async()=>({status:'ok',result:[{uri:target+'/private.md'},{uri:target+'/other.md'}]})}
    return {ok:false,status:404,json:async()=>({})}
  })
  assert.match((await client.cleanupLegacy([{name:'diary/private.md'}])).join(''),/已保留/)
  assert.deepEqual(deleted,[])
})

test('resource CLI rebuilds and searches only the active snapshot',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-snapshot-cli-'))
  const serverRoot=fileURLToPath(new URL('../tools/docs/',import.meta.url)),manuals=fs.readdirSync(serverRoot).filter(x=>/^[A-Za-z0-9_-]+\.md$/.test(x))
  let root='',deleted=[]
  const server=http.createServer((req,res)=>{
    const chunks=[];req.on('data',x=>chunks.push(x));req.on('end',()=>{
      const u=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json')
      const reply=result=>res.end(JSON.stringify({status:'ok',result}))
      if(u.pathname==='/api/v1/resources/temp_upload')return reply({temp_file_id:'upload.zip'})
      if(u.pathname==='/api/v1/resources'){root=JSON.parse(Buffer.concat(chunks).toString()).to;return reply({status:'success',root_uri:root,errors:[],queue_status:{Semantic:{error_count:0}}})}
      if(u.pathname==='/api/v1/fs/tree'){
        if(u.searchParams.get('uri')!==root){res.statusCode=404;return res.end(JSON.stringify({status:'error'}))}
        const files=[...manuals.map(x=>`manuals/${x}`),'snapshot-info.md',...(fs.existsSync(path.join(home,'whale-diary.md'))?['diary/public.md']:[])]
        return reply(files.map(x=>({uri:root+'/'+x,isDir:false})))
      }
      if(u.pathname==='/api/v1/fs'&&req.method==='DELETE'){deleted.push(u.searchParams.get('uri'));return reply({})}
      if(u.pathname==='/api/v1/search/find'){
        const target=JSON.parse(Buffer.concat(chunks).toString()).target_uri
        return reply({resources:target.endsWith('/diary')?[{uri:root+'/diary/public/public.md',abstract:'模拟日记',score:0.8}]:[{uri:root+'/manuals/manual.md',abstract:'模拟结果',score:0.8}]})
      }
      res.statusCode=404;res.end('{}')
    })
  })
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).on('error',reject))
  try {
    fs.writeFileSync(path.join(home,'whale-diary.md'),'# 临时日记')
    const env={...process.env,DSH_HOME:home,WHALE_OPENVIKING_URL:`http://127.0.0.1:${server.address().port}`,WHALE_OPENVIKING_API_KEY:'key',WHALE_OPENVIKING_ACCOUNT:'',WHALE_OPENVIKING_USER:''}
    const script=fileURLToPath(new URL('../tools/commands/resource.mjs',import.meta.url)),diary=fileURLToPath(new URL('../tools/commands/diary.mjs',import.meta.url)),run=(...args)=>promisify(execFile)(process.execPath,[script,...args],{env}),runDiary=(...args)=>promisify(execFile)(process.execPath,[diary,...args],{env})
    const first=JSON.parse((await run('rebuild')).stdout);assert.equal(first.status,'rebuilt')
    assert.match((await runDiary('find','记录')).stdout,/diary\/public/)
    fs.unlinkSync(path.join(home,'whale-diary.md'))
    assert.doesNotMatch((await runDiary('find','记录')).stdout,/diary\/public/)
    const second=JSON.parse((await run('rebuild')).stdout);assert.notEqual(first.root,second.root);assert.ok(deleted.includes(first.root))
    assert.match((await run('find','直播')).stdout,new RegExp(second.root))
  } finally {await new Promise(r=>server.close(r));fs.rmSync(home,{recursive:true,force:true})}
})
