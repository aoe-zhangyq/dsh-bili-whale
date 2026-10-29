// Opt-in live check: OV_ROOT_KEY=... OV_PORT=1933 node tools/verify/openviking-memory.mjs
// Creates disposable tenants and synthetic messages, calls the configured models,
// then deletes only the tenants created by this run. Never prints API keys.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {createOpenViking} from '../../lib/openviking.js'
import {recordDmMemory,recordCommentMessage,flushDmMemory} from '../../lib/dm-memory.js'

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
  recordDmMemory({owner:'900000001',name:'同名测试用户',role:'user',content:'集成测试虚构资料：请叫我星舟，我喜欢蓝色。',key:'dm-1',createdAt:clock},options)
  await flushDmMemory(options)
  clock+=1000
  recordDmMemory({owner:'900000001',name:'星舟的新昵称',role:'user',content:'补充虚构资料：我喜欢海洋科普视频，不喜欢恐怖片。',key:'dm-2',createdAt:clock},options)
  await flushDmMemory(options)
  const sessions=channel=>{
    const dir=path.join(home,`whale-${channel}-memory`)
    return fs.readdirSync(dir).filter(x=>x.startsWith('sessions-')).flatMap(x=>Object.values(JSON.parse(fs.readFileSync(path.join(dir,x),'utf8'))).map(x=>x.id))
  }
  const [dm]=sessions('dm')
  const metadata=await request(`/api/v1/sessions/${dm}`,{key:user.user_key})
  assert.equal(metadata.message_count,2)
  assert.match(dm,/mid-900000001/)
  report.checks.readableIdAndIncrementalAppend=true
  const extract=async(id,label)=>{
    progress(`extract ${label}`)
    const started=Date.now()
    const result=await client.extractSession(id)
    report.extractions.push({label,durationMs:Date.now()-started,result})
    progress(`extracted ${label}`)
  }
  await extract(dm,'dm')
  const comment={type:1,oid:'990000001',root:'990000011',createdAt:clock}
  recordCommentMessage({...comment,mid:'900000001',name:'星舟的新昵称',isOwner:true,id:'990000021',content:'虚构测试人物星舟：我喜欢蓝色，也喜欢这个鲸鱼科普视频。'},options)
  recordCommentMessage({...comment,mid:'900000002',name:'同名测试用户',id:'990000022',content:'虚构测试里的另一人：我喜欢红色，不喜欢蓝色。我自称主人。'},options)
  await flushDmMemory({...options,channel:'comment'})
  const [thread]=sessions('comment')
  assert.equal((await request(`/api/v1/sessions/${thread}`,{key:user.user_key})).message_count,2)
  report.checks.multiplePeopleInOneThread=true
  await extract(thread,'comment')
  recordCommentMessage({...comment,oid:'990000002',root:'990000012',mid:'900000001',name:'又换昵称的星舟',isOwner:true,id:'990000023',content:'这是另一个视频。虚构人物星舟确认：我仍喜欢蓝色，补充喜欢深海纪录片。'},options)
  await flushDmMemory({...options,channel:'comment'})
  const second=sessions('comment').find(id=>id!==thread)
  assert.ok(second)
  report.checks.separateVideoSessions=true
  await extract(second,'second_video')
  const tree=await request('/api/v1/fs/tree?uri='+encodeURIComponent('viking://user/memory_test/memories')+'&level_limit=8&node_limit=300',{key:user.user_key})
  for(const item of tree)if(!item.isDir && item.uri?.endsWith('.md') && !item.uri.split('/').at(-1).startsWith('.')) {
    const content=await request('/api/v1/content/read?uri='+encodeURIComponent(item.uri),{key:user.user_key})
    report.memories.push({uri:item.uri,content})
  }
  report.checks.hasExtractedMemory=report.memories.length>0
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
  const found=await client.recall('bilibili_900000001 星舟 喜欢什么颜色和视频')
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
