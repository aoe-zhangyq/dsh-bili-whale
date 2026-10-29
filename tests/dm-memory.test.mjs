import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { recordDmMemory, flushDmMemory, recordOwnerComment, recordCommentReply } from '../lib/dm-memory.js'

const settings = { url:'http://localhost:1933', account:'aoe', user:'whale', key:'test' }
function setup(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-dm-memory-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  let time=Date.parse('2026-10-29T10:00:00Z'), calls=[]
  const now=()=>time, client={appendMessage:async(id,m)=>calls.push({type:'append',id,m}),extractSession:async id=>calls.push({type:'extract',id})}
  const add=(role,content,key)=>recordDmMemory({owner:'123',role,content,key,createdAt:time},{home,settings,now})
  const flush=()=>flushDmMemory({home,settings,now,client})
  return {home, calls,add,flush,advance:ms=>{time+=ms},client}
}
test('私信逐条追加，同一会话在安静后整体提取，未新增时不重复提取',async t=>{
  const b=setup(t); assert.equal(b.add('user','我喜欢海','1'),true); assert.equal(b.add('user','我喜欢海','1'),false)
  await b.flush(); assert.equal(b.calls.length,1); assert.equal(b.calls[0].m.role,'user'); assert.match(b.calls[0].m.content,/2026-10-29T10:00:00.000Z/)
  b.advance(1000); b.add('assistant','我记住了','2'); await b.flush(); assert.equal(b.calls[0].id,b.calls[1].id)
  b.advance(300000); await b.flush(); assert.equal(b.calls[2].type,'extract'); await b.flush(); assert.equal(b.calls.length,3)
  b.add('user','也喜欢鱼','3'); await b.flush(); b.advance(300000); await b.flush(); assert.equal(b.calls.at(-1).id,b.calls[0].id)
})
test('七天和长度分别轮换会话，旧会话先提取',async t=>{
  const b=setup(t); b.add('user','x','1'); await b.flush(); b.advance(7*86400000); b.add('assistant','y','2'); await b.flush()
  assert.equal(b.calls[1].type,'extract'); assert.notEqual(b.calls[0].id,b.calls[2].id)
  b.add('user','a'.repeat(11900),'3'); await b.flush(); b.add('user','b'.repeat(200),'4'); await b.flush()
  const appends=b.calls.filter(x=>x.type==='append'); assert.notEqual(appends.at(-1).id,appends.at(-2).id)
})
test('追加结果不确定不盲目重发，切换租户不转移待处理内容',async t=>{
  const b=setup(t); b.add('user','hello','1'); let attempts=0
  b.client.appendMessage=async()=>{attempts++;throw Error('offline')}; await b.flush(); await b.flush(); assert.equal(attempts,1)
  b.add('user','other','2'); await flushDmMemory({home:b.home,settings:{...settings,account:'other'},client:b.client}); assert.equal(attempts,1)
})

test('主人评论和对应回复按楼层归组，不把其他回复混入',async t=>{
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
  assert.equal(one.id,reply.id);assert.notEqual(one.id,other.id)
})

test('活动经历在半小时安静后合并提取',async t=>{
  const b=setup(t);let clock=Date.parse('2026-10-29T10:00:00Z')
  const add=content=>recordDmMemory({owner:'activity',role:'assistant',content,key:content,createdAt:clock,channel:'activity'},{home:b.home,settings,now:()=>clock})
  const flush=()=>flushDmMemory({home:b.home,settings,channel:'activity',client:b.client,now:()=>clock})
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
