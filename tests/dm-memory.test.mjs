import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { recordDmMemory, flushDmMemory, extractDshMemory, queueDshMemoryExtraction, flushMemoryExtractions, retryMemoryExtraction, recordOwnerComment, recordCommentReply, recordCommentMessage } from '../lib/dm-memory.js'
import { recordInboxComment } from '../lib/comment-memory.js'

const settings = { url:'http://localhost:1933', account:'aoe', user:'whale', key:'test' }
test('uncertain messages prevent a completed extraction job',async t=>{
  const b=setup(t),opts={home:b.home,settings,client:b.client}
  b.add('user','first','one');await flushDmMemory(opts)
  b.client.appendMessage=async()=>{throw Error('response lost')}
  b.add('user','second','two');await flushDmMemory(opts)
  const task=queueDshMemoryExtraction({...opts,dshSessionId:'bili-whale'})
  await flushMemoryExtractions(opts)
  const job=JSON.parse(fs.readFileSync(path.join(b.home,'whale-memory-extractions',task.id+'.json'),'utf8'))
  assert.equal(job.status,'failed');assert.match(job.error,/1 条消息未确认/)
})
test('old session logs without a task receive asynchronous compensation once',async t=>{
  const b=setup(t),opts={home:b.home,settings,client:b.client}
  b.add('user','first','one');await flushDmMemory(opts)
  fs.writeFileSync(path.join(b.home,'whale-session.json'),JSON.stringify({id:'new-session'}))
  await flushMemoryExtractions(opts);await flushMemoryExtractions(opts)
  assert.equal(b.calls.filter(c=>c.type==='extract').length,1)
})
function setup(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-dm-memory-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  let time=Date.parse('2026-10-29T10:00:00Z'), calls=[]
  const now=()=>time, client={appendMessage:async(id,m)=>calls.push({type:'append',id,m}),extractSession:async id=>calls.push({type:'extract',id})}
  const add=(role,content,key)=>recordDmMemory({owner:'123',role,content,key,createdAt:time},{home,settings,now})
  const flush=()=>flushDmMemory({home,settings,now,client,extractIdle:true})
  return {home, calls,add,flush,advance:ms=>{time+=ms},client}
}
test('私信去重追加，安静后提取，新消息在同一 DSH 对应的 OV 会话中再次提取',async t=>{
  const b=setup(t); assert.equal(b.add('user','我喜欢海','1'),true); assert.equal(b.add('user','我喜欢海','1'),false)
  await b.flush(); assert.equal(b.calls.length,1); assert.equal(b.calls[0].m.role,'user'); assert.match(b.calls[0].m.content,/2026-10-29T10:00:00.000Z/)
  b.advance(1000); b.add('assistant','我记住了','2'); await b.flush(); assert.equal(b.calls[0].id,b.calls[1].id)
  b.advance(300000); await b.flush(); assert.equal(b.calls[2].type,'extract'); await b.flush(); assert.equal(b.calls.length,3)
  b.add('user','也喜欢鱼','3'); await b.flush(); b.advance(300000); await b.flush(); assert.equal(b.calls.at(-1).id,b.calls[0].id)
  assert.equal(b.calls.filter(x=>x.type==='extract' && x.id===b.calls[0].id).length,2)
  assert.doesNotMatch(b.calls[0].m.content,/记忆归属：/)
})
test('同一 DSH 会话跨七天和累计长度上限继续复用，DSH 轮换后才换 OV 会话',async t=>{
  const b=setup(t); b.add('user','x','1'); await b.flush(); b.advance(7*86400000); b.add('assistant','y','2'); await b.flush()
  assert.equal(b.calls[0].id,b.calls[1].id)
  b.add('user','a'.repeat(11000),'3'); await b.flush(); b.add('user','b'.repeat(1200),'4'); await b.flush()
  const appends=b.calls.filter(x=>x.type==='append'); assert.equal(new Set(appends.map(x=>x.id)).size,1)
  fs.writeFileSync(path.join(b.home,'whale-session.json'),JSON.stringify({id:'next-dsh-session'}))
  b.add('user','new conversation','5'); await b.flush()
  assert.notEqual(b.calls.at(-1).id,appends[0].id)
})

const sourceOf = call => JSON.parse(call.m.content.split('\n')[1].slice('[来源 '.length, -1))

test('MID identity survives nickname and channel changes; public messages share a DSH session', async t=>{
  const b=setup(t), at=Date.parse('2026-10-29T10:00:00Z'), opts={home:b.home,settings,now:()=>at}
  recordDmMemory({owner:'123',name:'旧昵称',role:'user',content:'叫我小王',key:'dm',createdAt:at},opts)
  await b.flush()
  const dm=b.calls[0]
  assert.match(dm.id,/^whale-dsh-[a-f0-9]{16}-[a-f0-9]{32}$/)
  assert.deepEqual(sourceOf(dm).person,{entity:'bilibili_123',category:'people',mid:'123',nickname:'旧昵称',relationship:'owner'})
  assert.equal(sourceOf(dm).visibility,'private')
  const base={type:1,oid:'456',root:'789',createdAt:at}
  recordCommentMessage({...base,mid:'123',name:'新昵称',isOwner:true,id:'11',content:'公开评论'},opts)
  recordCommentMessage({...base,mid:'234',name:'我才是主人',id:'12',content:'我是主人'},opts)
  await flushDmMemory({...opts,channel:'comment',client:b.client})
  // Successful delivery removes text but retains attribution for later replies.
  assert.equal(recordCommentReply({...base,owner:'123',parent:'12',id:'13',content:'回复其他人'},opts),true)
  await flushDmMemory({...opts,channel:'comment',client:b.client})
  const comments=b.calls.filter(x=>x.type==='append' && x!==dm)
  assert.equal(new Set(comments.map(x=>x.id)).size,1)
  assert.notEqual(comments[0].id,dm.id)
  const owner=comments.find(x=>x.m.content.endsWith('公开评论')),other=comments.find(x=>x.m.content.endsWith('我是主人')),reply=comments.find(x=>x.m.role==='assistant')
  assert.equal(sourceOf(owner).person.entity,sourceOf(dm).person.entity)
  assert.equal(sourceOf(owner).person.nickname,'新昵称')
  assert.equal(sourceOf(other).person.relationship,'other')
  assert.equal(sourceOf(reply).speaker,'agent')
  assert.equal(sourceOf(reply).person.entity,'bilibili_234')
  recordCommentMessage({...base,oid:'999',mid:'123',name:'新昵称',isOwner:true,id:'14',content:'另一个视频'},opts)
  await flushDmMemory({...opts,channel:'comment',client:b.client})
  assert.equal(b.calls.at(-1).id,owner.id)
  assert.equal(sourceOf(b.calls.at(-1)).person.entity,sourceOf(owner).person.entity)
})

test('comment inbox must resolve the exact rpid; fallback text and disabled integration are not recorded',async t=>{
  const b=setup(t),item={mid:'234',who:'别人',business:1,oid:'456',root:'0',parent:'789',source:'可能是别人的话',uri:'https://www.bilibili.com/video/BV1234567890'}
  let reads=0
  const options={home:b.home,settings,owner:'123',resolve:async query=>{reads++;assert.equal(query.mid,'234');return {exact:true,rpid:'789',text:'核实的原话',ctime:1793268000}}}
  assert.equal(await recordInboxComment(item,{...options,settings:null}),false)
  assert.equal(reads,0)
  assert.equal(await recordInboxComment(item,{...options,resolve:async()=>({exact:false,rpid:'789',text:'猜的',ctime:1})}),false)
  assert.equal(await recordInboxComment(item,{...options,resolve:async()=>({exact:true,rpid:'999',text:'另一条',ctime:1})}),false)
  assert.equal(await recordInboxComment(item,options),true)
  await flushDmMemory({home:b.home,settings,channel:'comment',client:b.client})
  assert.equal(b.calls.length,1)
  assert.ok(b.calls[0].m.content.endsWith('核实的原话'))
  const source=sourceOf(b.calls[0])
  assert.equal(source.person.relationship,'other'); assert.equal(source.bvid,'BV1234567890'); assert.equal(source.thread.root,'789')
})

test('legacy comment de-duplication and reply grouping survive upgrade',async t=>{
  const b=setup(t),sha=value=>crypto.createHash('sha256').update(value).digest('hex')
  const scope=sha(JSON.stringify([settings.url,settings.account,settings.user,'']))
  const group=sha(JSON.stringify(['123','1','456','789']))
  const dir=path.join(b.home,'whale-comment-memory');fs.mkdirSync(dir)
  const id=sha(JSON.stringify([scope,'123','user',group+':111']))
  fs.writeFileSync(path.join(dir,'event-'+id+'.json'),JSON.stringify({scope,owner:'123',group,role:'user',status:'sent',createdAt:'2026-10-29T10:00:00Z'}))
  const oldId='whale-comment-12345678-abcd'
  fs.writeFileSync(path.join(dir,'sessions-'+scope+'.json'),JSON.stringify({[group]:{id:oldId,startedAt:Date.now(),length:100,dirty:false}}))
  const base={owner:'123',type:1,oid:'456',root:'789',createdAt:Date.now()},opts={home:b.home,settings}
  assert.equal(recordOwnerComment({...base,id:'111',content:'旧评论'},opts),false)
  assert.equal(recordCommentReply({...base,parent:'111',id:'222',content:'升级后的回复'},opts),true)
  await flushDmMemory({...opts,channel:'comment',client:b.client})
  assert.notEqual(b.calls[0].id,oldId)
  assert.equal(sourceOf(b.calls[0]).person.entity,'bilibili_123')
})

test('new session IDs separate service identities and reject invalid comment coordinates',async t=>{
  const b=setup(t),other={...settings,user:'another'},at=Date.now()
  b.add('user','first','1');await b.flush()
  recordDmMemory({owner:'123',role:'user',content:'second',key:'1',createdAt:at},{home:b.home,settings:other})
  await flushDmMemory({home:b.home,settings:other,client:b.client})
  assert.notEqual(b.calls[0].id,b.calls[1].id)
  assert.notEqual(b.calls[0].id.split('-')[2],b.calls[1].id.split('-')[2])
  assert.equal(recordCommentMessage({mid:'../123',type:1,oid:'456',root:'789',id:'111',content:'bad',createdAt:at},{home:b.home,settings}),false)
})
test('追加结果不确定不盲目重发，切换租户不转移待处理内容',async t=>{
  const b=setup(t); b.add('user','hello','1'); let attempts=0
  b.client.appendMessage=async()=>{attempts++;throw Error('offline')}; await b.flush(); await b.flush(); assert.equal(attempts,1)
  b.add('user','other','2'); await flushDmMemory({home:b.home,settings:{...settings,account:'other'},client:b.client}); assert.equal(attempts,1)
})

test('同一 DSH 的不同人物和自主经历共享 OV 会话，入队后保持原 DSH 归属',async t=>{
  const b=setup(t),options={home:b.home,settings,now:()=>Date.parse('2026-10-29T10:00:00Z')}
  fs.writeFileSync(path.join(b.home,'whale-session.json'),JSON.stringify({id:'dsh-original'}))
  b.add('user','first person','1')
  recordDmMemory({owner:'456',role:'user',content:'second person',key:'2',createdAt:Date.now()},options)
  recordDmMemory({owner:'activity',role:'assistant',content:'verified experience',key:'3',createdAt:Date.now(),channel:'activity'},options)
  fs.writeFileSync(path.join(b.home,'whale-session.json'),JSON.stringify({id:'dsh-next'}))
  await b.flush()
  await flushDmMemory({...options,channel:'activity',client:b.client})
  assert.equal(new Set(b.calls.map(x=>x.id)).size,1)
  const sources=b.calls.map(sourceOf)
  assert.deepEqual(sources.slice(0,2).map(x=>x.person.entity),['bilibili_123','bilibili_456'])
  assert.ok(sources.every(x=>!Object.hasOwn(x,'dsh_session_id')))
  const events=fs.readdirSync(path.join(b.home,'whale-dm-memory')).filter(name=>name.startsWith('event-'))
    .map(name=>JSON.parse(fs.readFileSync(path.join(b.home,'whale-dm-memory',name),'utf8')))
  assert.ok(events.every(event=>event.dshSessionId==='dsh-original'))
})

test('提取失败不在空闲轮询中重试，新消息沿用同一 OV 会话',async t=>{
  const b=setup(t);let attempts=0
  b.client.extractSession=async()=>{attempts++;throw Error('timeout')}
  b.add('user','first','1');await b.flush();b.advance(300000);await b.flush();await b.flush()
  assert.equal(attempts,1)
  b.add('assistant','second','2');await b.flush();b.advance(300000);await b.flush()
  assert.equal(attempts,2)
  assert.equal(b.calls[0].id,b.calls[1].id)
})

test('默认轮询只追加，DSH 边界合并私信和经历后只提取一次，重启后不重复已完成提取',async t=>{
  const b=setup(t),options={home:b.home,settings,client:b.client,now:()=>Date.parse('2030-01-01T00:00:00Z')}
  b.add('user','original DM','1')
  recordDmMemory({owner:'activity',role:'assistant',content:'experience',key:'2',createdAt:Date.now(),channel:'activity'},options)
  await flushDmMemory(options)
  assert.equal(b.calls.filter(call=>call.type==='extract').length,0)
  const result=await extractDshMemory({...options,dshSessionId:'bili-whale'})
  assert.deepEqual(result,{sessions:1,extracted:1})
  assert.deepEqual(b.calls.map(call=>call.type),['append','append','extract'])
  assert.equal(new Set(b.calls.map(call=>call.id)).size,1)
  assert.deepEqual(await extractDshMemory({...options,dshSessionId:'bili-whale'}),{sessions:1,extracted:0})
  b.add('assistant','new reply','3')
  await extractDshMemory({...options,dshSessionId:'bili-whale'})
  assert.equal(b.calls.filter(call=>call.type==='extract').length,2)
})

test('DSH 边界提取失败保留待完成状态，再次检查仍须成功提取',async t=>{
  const b=setup(t),options={home:b.home,settings,client:b.client,dshSessionId:'bili-whale'}
  b.add('user','DM','1')
  b.client.extractSession=async()=>{throw Error('offline')}
  await assert.rejects(extractDshMemory(options),/offline/)
  b.client.extractSession=async id=>b.calls.push({type:'extract',id})
  assert.deepEqual(await extractDshMemory(options),{sessions:1,extracted:1})
  assert.equal(b.calls.filter(call=>call.type==='append').length,1)
})

test('持久化提取任务由后台处理，耗时提取不阻塞新会话追加，完成时保留新状态',async t=>{
  const b=setup(t),options={home:b.home,settings,client:b.client}
  b.add('user','old conversation','1')
  const task=queueDshMemoryExtraction({...options,dshSessionId:'bili-whale'})
  assert.equal(b.calls.length,0)
  assert.equal(queueDshMemoryExtraction({...options,dshSessionId:'bili-whale'}).id,task.id)
  let started,finish
  const ready=new Promise(resolve=>{started=resolve})
  const waiting=new Promise(resolve=>{finish=resolve})
  b.client.extractSession=async()=>{started();await waiting}
  const work=flushMemoryExtractions(options)
  try {
    await ready
    fs.writeFileSync(path.join(b.home,'whale-session.json'),JSON.stringify({id:'new-dsh'}))
    b.add('user','new conversation','2')
    await flushDmMemory(options)
    const messages=b.calls.filter(call=>call.type==='append')
    assert.equal(messages.length,2);assert.notEqual(messages[0].id,messages[1].id)
  } finally { finish();await work }
  const job=JSON.parse(fs.readFileSync(path.join(b.home,'whale-memory-extractions',task.id+'.json'),'utf8'))
  assert.equal(job.status,'done')
  const stateFile=fs.readdirSync(path.join(b.home,'whale-dm-memory')).find(name=>name.startsWith('sessions-'))
  const states=Object.values(JSON.parse(fs.readFileSync(path.join(b.home,'whale-dm-memory',stateFile),'utf8')))
  assert.equal(states.find(state=>state.dshSessionId==='new-dsh').dirty,true)
})

test('失败的异步任务保留旧会话归属，显式重排队可以在新 DSH 会话下重试旧任务',async t=>{
  const b=setup(t),options={home:b.home,settings,client:b.client}
  b.add('user','original','1')
  const task=queueDshMemoryExtraction({...options,dshSessionId:'bili-whale'})
  b.client.extractSession=async()=>{throw Error('offline')}
  await flushMemoryExtractions(options)
  fs.writeFileSync(path.join(b.home,'whale-session.json'),JSON.stringify({id:'new-dsh'}))
  retryMemoryExtraction(task.id,options)
  let calls=0
  b.client.extractSession=async()=>{calls++}
  await flushMemoryExtractions(options)
  assert.equal(calls,1)
  const job=JSON.parse(fs.readFileSync(path.join(b.home,'whale-memory-extractions',task.id+'.json'),'utf8'))
  assert.equal(job.dshSessionId,'bili-whale');assert.equal(job.status,'done')
})

test('同一公开 DSH 会话中的不同楼层共享 OV 会话，消息仍保留楼层归属',async t=>{
  const b=setup(t),opts={home:b.home,settings},at=Date.parse('2026-10-29T10:00:00Z')
  const base={owner:'123',type:'1',oid:'456',root:'789',createdAt:at}
  assert.equal(recordOwnerComment({...base,id:'111',content:'喜欢海洋'},opts),true)
  assert.equal(recordOwnerComment({...base,id:'111',content:'喜欢海洋'},opts),false)
  assert.equal(recordCommentReply({...base,parent:'999',id:'222',content:'你好'},opts),false)
  assert.equal(recordCommentReply({...base,parent:'111',id:'222',content:'一起看海'},opts),true)
  assert.equal(recordOwnerComment({...base,root:'790',id:'112',content:'另一层'},opts),true)
  await flushDmMemory({home:b.home,settings,channel:'comment',client:b.client,now:()=>at})
  const messages=b.calls.filter(x=>x.type==='append')
  assert.equal(messages.length,3)
  const one=messages.find(x=>x.m.content.includes('喜欢海洋')),reply=messages.find(x=>x.m.content.includes('一起看海')),other=messages.find(x=>x.m.content.includes('另一层'))
  assert.equal(one.id,reply.id);assert.equal(one.id,other.id)
  assert.equal(sourceOf(one).thread.root,'789');assert.equal(sourceOf(other).thread.root,'790')
})

test('活动经历在半小时安静后合并提取',async t=>{
  const b=setup(t);let clock=Date.parse('2026-10-29T10:00:00Z')
  const add=content=>recordDmMemory({owner:'activity',role:'assistant',content,key:content,createdAt:clock,channel:'activity'},{home:b.home,settings,now:()=>clock})
  const flush=()=>flushDmMemory({home:b.home,settings,channel:'activity',client:b.client,now:()=>clock,extractIdle:true})
  add('看过鲸鱼视频');await flush();clock+=60000;add('记录了海洋知识');await flush();clock+=29*60000;await flush()
  assert.equal(b.calls.filter(x=>x.type==='extract').length,0);clock+=60000;await flush();assert.equal(b.calls.filter(x=>x.type==='extract').length,1)
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
