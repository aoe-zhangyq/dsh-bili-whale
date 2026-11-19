import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import {recordOwnerComment,recordCommentReply} from '../lib/dm-memory.js'
import {recordInboxComment} from '../lib/comment-memory.js'
import {recallPublicMemory} from '../lib/public-memory.js'
import {recordDmHistory,syncDmHistory} from '../lib/dm-history-sync.js'

const settings = { url:'http://localhost:1933', account:'aoe', user:'whale', key:'test' }
function setup(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-dm-memory-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  return {home}
}

test('comment inbox must resolve the exact rpid; fallback text and disabled integration are not recorded',async t=>{
  const b=setup(t),item={mid:'234',who:'别人',business:1,oid:'456',root:'0',parent:'789',source:'可能是别人的话',uri:'https://www.bilibili.com/video/BV1234567890'}
  let reads=0
  const options={home:b.home,settings,owner:'123',resolve:async query=>{reads++;assert.equal(query.mid,'234');return {exact:true,rpid:'789',text:'核实的原话',ctime:1793268000}}}
  assert.equal(await recordInboxComment(item,{...options,settings:null}),false)
  assert.equal(reads,0)
  assert.equal(await recordInboxComment(item,{...options,resolve:async()=>({exact:false,rpid:'789',text:'猜的',ctime:1})}),false)
  assert.equal(await recordInboxComment(item,{...options,resolve:async()=>({exact:true,rpid:'999',text:'另一条',ctime:1})}),false)
  assert.equal(await recordInboxComment(item,options),true)
  const [evidence]=recallPublicMemory('核实的原话',options)
  assert.equal(evidence.content,'核实的原话')
  const {source}=evidence
  assert.equal(source.person.relationship,'other'); assert.equal(source.bvid,'BV1234567890'); assert.equal(source.thread.root,'789')
})


test('legacy comment de-duplication and reply grouping survive upgrade',t=>{
  const b=setup(t),sha=value=>crypto.createHash('sha256').update(value).digest('hex')
  const scope=sha(JSON.stringify([settings.url,settings.account,settings.user,'']))
  const group=sha(JSON.stringify(['123','1','456','789']))
  const dir=path.join(b.home,'whale-comment-memory');fs.mkdirSync(dir)
  const id=sha(JSON.stringify([scope,'123','user',group+':111']))
  fs.writeFileSync(path.join(dir,'event-'+id+'.json'),JSON.stringify({scope,owner:'123',group,role:'user',status:'sent',createdAt:'2026-10-29T10:00:00Z'}))
  const base={owner:'123',type:1,oid:'456',root:'789',createdAt:Date.now()},opts={home:b.home,settings}
  assert.equal(recordOwnerComment({...base,id:'111',content:'旧评论'},opts),false)
  assert.equal(recordCommentReply({...base,parent:'111',id:'222',content:'升级后的回复'},opts),true)
  const [reply]=recallPublicMemory('升级后的回复',opts)
  assert.equal(reply.role,'assistant')
  assert.equal(reply.source.person.entity,'bilibili_123')
})

test('MID files merge both directions and sync all cached months into one stable session per MID',async t=>{
  const {home}=setup(t),remote=new Map(),appends=[]
  const client={
    async sessionMessages(id){return (remote.get(id)||[]).map(message=>message.content)},
    async appendMessage(id,message){appends.push(id);remote.set(id,[...(remote.get(id)||[]),message])},
  }
  const record=(mid,rows)=>recordDmHistory(mid,rows,{home,selfMid:'100',name:'联系人'})
  const oct={key:'1',sender:'200',ts:Date.parse('2026-10-01T08:00:00Z')/1000,type:1,text:'十月'}
  const nov={...oct,key:'2',sender:'100',ts:Date.parse('2026-11-01T08:00:00Z')/1000,text:'十一月回复'}
  await Promise.all([record('200',[oct]),record('200',[nov,oct]),record('300',[{...oct,sender:'300'}])])
  assert.deepEqual(fs.readdirSync(path.join(home,'whale-dm-history')).sort(),['200.json','300.json'])
  const file=path.join(home,'whale-dm-history','200.json')
  const cache=JSON.parse(fs.readFileSync(file,'utf8'))
  assert.deepEqual(cache.messages.map(row=>row.key),['1','2'])
  fs.writeFileSync(file,JSON.stringify({...cache,messages:[...cache.messages].reverse()}))
  await record('200',[nov,oct])
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),cache)
  const sync=()=>syncDmHistory({home,settings,client})
  assert.deepEqual(await sync(),{sessions:2,entries:3,uploaded:3,extracted:0,failed:0})
  const id=appends[0]
  assert.match(id,/^whale-dm-200-[a-f0-9]{16}$/)
  assert.match(appends[2],/^whale-dm-300-/)
  assert.deepEqual(remote.get(id).map(message=>[message.role,message.content.split('\n').at(-1)]),[['user','十月'],['assistant','十一月回复']])
  assert.equal((await sync()).uploaded,0)
  remote.delete(id)
  assert.equal((await sync()).uploaded,2)
  assert.equal(remote.size,2)
})

test('scheduled extraction uploads missing cache entries first and uses the same MID session',async t=>{
  const {home}=setup(t),remote=[],extracted=[],operations=[]
  let clock=Date.parse('2026-11-15T04:59:59+08:00'),loseResponse=true
  const client={sessionMessages:async()=>remote.map(row=>row.message.content),
    async appendMessage(id,message){
      operations.push('append')
      remote.push({id,message})
      if (loseResponse) {loseResponse=false;throw Error('response lost')}
    },
    async extractSession(id){operations.push('extract');extracted.push(id)},
  }
  const sync=extract=>syncDmHistory({home,settings,client,now:()=>clock,extract})
  const record=key=>recordDmHistory('200',[{key,sender:'200',ts:clock/1000,type:1,text:key}],{home})
  await record('first')
  assert.equal((await sync()).failed,1)
  assert.equal((await sync()).uploaded,0)
  assert.equal((await sync(true)).extracted,0)
  clock+=1000
  assert.equal((await sync(true)).extracted,1)
  assert.equal((await sync(true)).extracted,0)
  clock=Date.parse('2026-12-01T04:59:59+08:00')
  await record('second')
  assert.equal((await sync(true)).uploaded,0)
  assert.equal(remote.length,1)
  clock+=1000
  const scheduled=await sync(true)
  assert.deepEqual([scheduled.uploaded,scheduled.extracted],[1,1])
  assert.deepEqual(operations,['append','extract','append','extract'])
  assert.deepEqual(extracted,[remote[0].id,remote[0].id])
  assert.equal(remote[1].id,remote[0].id)
  await record('third')
  assert.equal((await sync(true)).uploaded,0)
  assert.equal(remote.length,2)
})

test('a failed scheduled append is reconciled before extracting that MID',async t=>{
  const {home}=setup(t),messages=[]
  let extracted=0
  const clock=Date.parse('2026-11-15T05:00:00+08:00')
  await recordDmHistory('200',[{key:'first',sender:'200',ts:clock/1000,type:1,text:'test'}],{home})
  const client={
    async sessionMessages(){return messages},
    async appendMessage(id,message){messages.push(message.content);throw Error('response lost')},
    async extractSession(){extracted++},
  }
  const run=()=>syncDmHistory({home,settings,client,now:()=>clock,extract:true})
  assert.equal((await run()).failed,1)
  assert.equal(extracted,0)
  assert.equal((await run()).extracted,1)
  assert.equal(messages.length,1)
  assert.equal((await run()).extracted,0)
})


test('活动经历命令在启用服务时持久化真实文本',t=>{
  const b=setup(t),file=path.join(b.home,'experience.txt')
  fs.writeFileSync(file,'今天看了海洋科普视频。')
  const script=fileURLToPath(new URL('../tools/commands/memory.mjs',import.meta.url))
  const r=spawnSync(process.execPath,[script,'experience',file],{encoding:'utf8',env:{...process.env,DSH_HOME:b.home,WHALE_OPENVIKING_API_KEY:'test',WHALE_OPENVIKING_ACCOUNT:'aoe',WHALE_OPENVIKING_USER:'whale'}})
  assert.equal(r.status,0,r.stderr)
  const dir=path.join(b.home,'whale-activity-memory'),name=fs.readdirSync(dir).find(x=>x.startsWith('event-'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')).content,'今天看了海洋科普视频。')
})
