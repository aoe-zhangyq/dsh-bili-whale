// Opt-in live check: OV_ROOT_KEY=... OV_PORT=1933 node tools/verify/openviking-memory.mjs
// Creates disposable tenants and synthetic messages, calls the configured models,
// then deletes only the tenants created by this run. Never prints API keys.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {createOpenViking} from '../../lib/openviking.js'
import {recordDmHistory,syncDmHistory} from '../../lib/dm-history-sync.js'
import {guardedFetch as fetch} from '../lib/traffic.mjs'

let input={}
if(process.argv.includes('--stdin')) {
  let raw='';for await(const chunk of process.stdin)raw+=chunk
  input=JSON.parse(raw)
}
const base=input.url || `http://127.0.0.1:${process.env.OV_PORT || 1933}`
const rootKey=input.rootKey || process.env.OV_ROOT_KEY
if(!rootKey)throw Error('Set OV_ROOT_KEY before running the live check')
const report={startedAt:new Date().toISOString(),checks:{},extractions:[],memories:[],cleanup:[]}
const created=[]
let home
async function request(route,{key=rootKey,method='GET',body,timeout=30000}={}) {
  const response=await fetch(base+route,{method,headers:{'X-API-Key':key,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout)})
  const data=await response.json()
  if(!response.ok || data.status!=='ok') {
    const error=Error(`OpenViking HTTP ${response.status}: ${data.error?.code || 'request failed'}`)
    error.code=data.error?.code;throw error
  }
  return data.result
}
function progress(step){console.log(JSON.stringify({step}))}
async function createAccount() {
  const account='whale_verify_'+crypto.randomUUID().replaceAll('-','').slice(0,16)
  const result=await request('/api/v1/admin/accounts',{method:'POST',body:{account_id:account,admin_user_id:'admin'}})
  created.push(account)
  return {account,key:result.user_key}
}
try {
  const health=await fetch(base+'/health',{signal:AbortSignal.timeout(10000)}).then(r=>r.json())
  report.service={version:health.version,healthy:health.healthy,authMode:health.auth_mode}
  const {account}=await createAccount()
  report.account=account
  const user=await request(`/api/v1/admin/accounts/${account}/users`,{method:'POST',body:{user_id:'memory_test',role:'user'}})
  const settings={url:base,account,user:'memory_test',key:user.user_key},client=createOpenViking(settings)
  home=fs.mkdtempSync(path.join(input.tempRoot || os.tmpdir(),'whale-live-'))
  let clock=Date.now()
  const options={home,settings,now:()=>clock,client}
  const peer='900000001',selfMid='900000099'
  const record=(mid,sender,key,text)=>recordDmHistory(mid,[{sender,key,text,ts:clock/1000,type:1}],{home,selfMid,name:'星舟'})
  await record(peer,peer,'dm-1','集成测试虚构资料：请叫我星舟，我喜欢蓝色。')
  clock+=1000
  await record(peer,peer,'dm-2','补充虚构资料：我喜欢海洋科普视频，不喜欢恐怖片。')
  assert.equal((await syncDmHistory(options)).uploaded,2)
  const dir=path.join(home,'whale-dm-history')
  const stateFile=fs.readdirSync(dir).find(x=>x.startsWith('sync-'))
  const [dm]=Object.keys(JSON.parse(fs.readFileSync(path.join(dir,stateFile),'utf8')))
  const metadata=await request(`/api/v1/sessions/${dm}`,{key:user.user_key})
  assert.equal(metadata.message_count,2)
  assert.match(dm,/^whale-dm-900000001-[a-f0-9]{16}$/)
  report.checks.readableIdAndIncrementalAppend=true
  const extract=async(id,label)=>{
    progress(`extract ${label}`)
    const started=Date.now()
    const result=await client.extractSession(id)
    assert.equal(result.status,'completed')
    report.extractions.push({label,durationMs:Date.now()-started,result})
    progress(`extracted ${label}`)
  }
  await extract(dm,'dm')
  await record(peer,selfMid,'dm-3','这是新分段的虚构回复。')
  assert.equal((await syncDmHistory(options)).uploaded,1)
  assert.equal((await syncDmHistory(options)).uploaded,0)
  const dmMetadata=await request(`/api/v1/sessions/${dm}`,{key:user.user_key})
  assert.equal(dmMetadata.message_count,1)
  const firstArchive=await request(`/api/v1/sessions/${dm}/archives/archive_001`,{key:user.user_key})
  assert.equal(firstArchive.messages.length,2)
  report.checks.sealedBatchNotReplayed=true
  await record('900000002','900000002','dm-1','独立 MID 的虚构私信。')
  assert.equal((await syncDmHistory(options)).uploaded,1)
  const state=JSON.parse(fs.readFileSync(path.join(dir,stateFile),'utf8'))
  const second=Object.keys(state).find(id=>id.startsWith('whale-dm-900000002-'))
  assert.equal((await request(`/api/v1/sessions/${second}`,{key:user.user_key})).message_count,1)
  report.checks.separateMidSessions=true
  const tree=await request('/api/v1/fs/tree?uri='+encodeURIComponent('viking://user/memory_test/memories')+'&level_limit=8&node_limit=300',{key:user.user_key})
  for(const item of tree)if(!item.isDir && item.uri?.endsWith('.md') && !item.uri.split('/').at(-1).startsWith('.')) {
    const content=await request('/api/v1/content/read?uri='+encodeURIComponent(item.uri),{key:user.user_key})
    report.memories.push({uri:item.uri,content})
  }
  // New users already have identity.md and soul.md before any extraction.
  report.checks.hasExtractedMemory=report.memories.some(x=>/\/memories\/(?:entities|preferences|events)\//.test(x.uri))
  const entityFiles=report.memories.filter(x=>x.uri.includes('/entities/') && /\/bilibili_\d+\.md$/.test(x.uri))
  const groups=Map.groupBy(entityFiles,x=>x.uri.split('/').at(-1))
  report.analysis={
    duplicateEntityFiles:[...groups].filter(([,files])=>files.length>1).map(([entity,files])=>({entity,uris:files.map(x=>x.uri)})),
    nonCanonicalEntityFiles:entityFiles.filter(x=>!x.uri.includes('/entities/people/')).map(x=>x.uri),
    nonMidPreferenceFiles:report.memories.filter(x=>x.uri.includes('/preferences/') && !/\/preferences\/bilibili_\d+\//.test(x.uri)).map(x=>x.uri),
  }
  report.analysis.namingConsistent=!report.analysis.duplicateEntityFiles.length && !report.analysis.nonCanonicalEntityFiles.length && !report.analysis.nonMidPreferenceFiles.length
  report.analysis.semanticReviewRequired=true // Different topic aliases and incorrect facts require content review.
  const other=await createAccount()
  try {
    await request(`/api/v1/sessions/${dm}`,{key:other.key})
    report.checks.crossTenantSessionIsolation=false
  } catch(error) {
    if(error.code!=='NOT_FOUND')throw error
    report.checks.crossTenantSessionIsolation=true
  }
  const found=await client.recall('星舟 喜欢什么颜色和视频',{mid:'900000001'})
  assert.ok(found.length)
  assert.ok(found.every(item=>item.uri.includes('/bilibili_900000001')))
  const person=found.find(item=>item.match==='exact-person')
  assert.ok(person?.content)
  assert.equal((await client.readMemory(person.uri)).content,person.content)
  report.checks.midScopedRecallAndFullRead=true
  report.recall=found
  if(Object.values(report.checks).some(value=>value===false) || !report.analysis.namingConsistent)process.exitCode=1
  progress('inspect memory naming and provenance in report')
} catch(error) {
  report.error=String(error.message).split(rootKey).join('[redacted]')
  process.exitCode=1
} finally {
  for(const account of created.reverse())try {
    await request(`/api/v1/admin/accounts/${account}`,{method:'DELETE',timeout:60000})
    report.cleanup.push({account,deleted:true})
  } catch {report.cleanup.push({account,deleted:false});process.exitCode=1}
  if(home)fs.rmSync(home,{recursive:true,force:true})
  report.finishedAt=new Date().toISOString()
  if(input.reportFile)fs.writeFileSync(input.reportFile,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report))
}
