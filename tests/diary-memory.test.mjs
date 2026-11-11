import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {archiveDiary,syncDiaryMemory} from '../lib/diary-memory.js'

test('failed midpoint extraction allows new uploads and next-month extraction',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-diary-failure-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const settings={url:'http://localhost:1933',account:'test',user:'whale',key:'test'}
  const messages=[];let attempts=0
  const client={sessionMessages:async()=>messages,appendMessage:async(id,m)=>messages.push(m.content),extractSession:async()=>{if(++attempts===1)throw Error('offline')}}
  const sync=at=>syncDiaryMemory({home,settings,client,now:()=>Date.parse(at)})
  archiveDiary({book:'private',at:'2026-11-14T12:00:00+08:00',content:'first'},{home})
  assert.equal((await sync('2026-11-15T05:00:00+08:00')).failed,1)
  archiveDiary({book:'private',at:'2026-11-16T12:00:00+08:00',content:'second'},{home})
  await sync('2026-11-16T13:00:00+08:00')
  assert.equal(messages.length,2);assert.equal(attempts,1)
  assert.equal((await sync('2026-12-01T05:00:00+08:00')).extracted,1)
})

test('diary reconciles by monthly session and changes sessions at 05:00 Beijing time',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-diary-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true,maxRetries:3}))
  const settings={url:'http://localhost:1933',account:'test',user:'whale',key:'test'}
  const entries=new Map(),extracted=[]
  let failAppend=true
  const client={
    async sessionMessages(id){return entries.get(id) || []},
    async appendMessage(id,message){
      entries.set(id,[...(entries.get(id)||[]),message.content])
      if (failAppend) {failAppend=false;throw Error('response lost')}
    },
    async extractSession(id){extracted.push(id)},
  }
  const at='2026-11-14T04:59:59+08:00'
  const input={book:'private',at,content:'本次日记'}
  assert.deepEqual(archiveDiary(input,{home}),archiveDiary(input,{home}))
  const sync=(now,manual=false)=>syncDiaryMemory({home,settings,client,manual,now:()=>Date.parse(now)})
  assert.equal((await sync(at)).failed,1)
  await sync(at)
  assert.equal((await sync(at,true)).entries,1)
  const [id]=entries.keys()
  assert.match(id,/^20261101-whale-diary-private-[a-f0-9]{16}$/)
  assert.equal(entries.get(id).length,1)
  assert.deepEqual(extracted,[])
  const midpoint='2026-11-15T05:00:00+08:00'
  await sync(midpoint)
  await sync(midpoint)
  assert.deepEqual(extracted,[id])
  archiveDiary({...input,at:'2026-12-01T04:59:59+08:00',content:'月初交界前'},{home})
  const after='2026-12-01T05:00:00+08:00'
  await sync(after)
  await sync(after)
  assert.deepEqual(extracted,[id,id])
  archiveDiary({...input,content:'补记'},{home})
  archiveDiary({...input,at:after,content:'新一期'},{home})
  await sync(after)
  assert.deepEqual(extracted,[id,id,id])
  assert.equal(entries.get(id).length,3)
  assert.equal(entries.size,2)
  assert.ok([...entries.keys()].some(key=>key.startsWith('20261201-whale-diary-private-')))
  entries.delete(id)
  assert.equal((await sync(after,true)).entries,0)
  const dir=path.join(home,'whale-diary-entries')
  for(const name of fs.readdirSync(dir).filter(name=>name.endsWith('.sync.json'))) fs.unlinkSync(path.join(dir,name))
  failAppend=true
  assert.equal((await sync(after,true)).entries,4)
  assert.equal((await sync(after,true)).entries,3)
  assert.equal(entries.get(id).length,3)
  assert.deepEqual(extracted,[id,id,id,id])
})
