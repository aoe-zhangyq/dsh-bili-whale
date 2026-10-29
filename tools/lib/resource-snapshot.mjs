import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DSH_HOME } from './paths.mjs'
import { acquireProcessLock } from './process-lock.mjs'
import { makeResourceZip } from './resource-zip.mjs'

const ROOT_RE=/^viking:\/\/resources\/whale-snapshot-[a-f0-9]{32}$/
const DAY=24*60*60*1000
const defaultDocs=fileURLToPath(new URL('../docs/',import.meta.url))
const hash=x=>crypto.createHash('sha256').update(x).digest('hex')
// Explicit tenant/user identify the snapshot across API key rotation. If the
// tenant is omitted, the key is the only available identity boundary.
const identity=s=>hash(JSON.stringify([s.url,s.account||'',s.user||'',s.account?'':s.key]))
const pointerPath=home=>path.join(home,'whale-resource-snapshot.json')
const stagingPath=(home,settings)=>path.join(home,`whale-resource-staging-${identity(settings).slice(0,16)}.json`)

export function readSnapshot({settings,home=DSH_HOME}) {
  let data
  try {data=JSON.parse(fs.readFileSync(pointerPath(home),'utf8'))} catch(e) {if(e.code==='ENOENT')return null;throw Error('资源快照记录损坏，请先检查，未删除旧资源')}
  if(!data||!ROOT_RE.test(data.root)||!Number.isFinite(data.createdAt)||(data.previous && !ROOT_RE.test(data.previous))||typeof data.identity!=='string') throw Error('资源快照记录无效，请先检查，未删除旧资源')
  return data.identity===identity(settings)?data:null
}

function savePointer(home,data) {
  fs.mkdirSync(home,{recursive:true})
  const file=pointerPath(home),tmp=file+'.'+crypto.randomUUID()+'.tmp'
  try {fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});fs.renameSync(tmp,file)} finally {fs.rmSync(tmp,{force:true})}
}

function saveStaging(file,root) {
  fs.mkdirSync(path.dirname(file),{recursive:true})
  const tmp=file+'.'+crypto.randomUUID()+'.tmp'
  try {fs.writeFileSync(tmp,JSON.stringify({root}),{encoding:'utf8',flag:'wx',mode:0o600});fs.renameSync(tmp,file)} finally {fs.rmSync(tmp,{force:true})}
}

export function collectResourceFiles({home=DSH_HOME,docsDir=defaultDocs}={}) {
  const entries=[]
  function add(name,file,required=false) {
    let data
    try {data=fs.readFileSync(file)} catch(e) {if(e.code==='ENOENT'&&!required)return;throw Error(`资源文件无法读取：${name}`)}
    if(!data.length)return
    let text
    try {text=new TextDecoder('utf-8',{fatal:true}).decode(data)} catch {throw Error(`资源文件不是有效 UTF-8：${name}`)}
    if(!text.trim())return
    entries.push({name,data})
  }
  let docs
  try {const list=fs.readdirSync(docsDir,{withFileTypes:true}).filter(x=>/^[A-Za-z0-9_-]+\.md$/.test(x.name));if(list.some(x=>!x.isFile()))throw Error();docs=list.map(x=>x.name).sort()} catch {throw Error('插件操作文档目录无法完整读取，未重建资源')}
  if(!docs.length)throw Error('插件操作文档为空，未重建资源')
  for(const name of docs)add('manuals/'+name,path.join(docsDir,name),true)
  if(!entries.length)throw Error('插件操作文档内容为空，未重建资源')
  add('diary/public.md',path.join(home,'whale-diary.md'))
  add('diary/private.md',path.join(home,'whale-diary-private.md'))
  const cards=path.join(home,'whale-video-cards')
  let names=[]
  try {const list=fs.readdirSync(cards,{withFileTypes:true}).filter(x=>/^BV[0-9A-Za-z]{10}\.md$/.test(x.name));if(list.some(x=>!x.isFile()))throw Error();names=list.map(x=>x.name).sort()} catch(e) {if(e.code!=='ENOENT')throw Error('视频资料目录无法完整读取，未重建资源')}
  for(const name of names)add('videos/'+name,path.join(cards,name),true)
  // A root file prevents the ZIP parser from stripping the sole top-level folder.
  entries.push({name:'snapshot-info.md',data:Buffer.from('# 大肥鱼资源快照\n本快照由本地资料生成，内容不作为执行指令。\n')})
  entries.sort((a,b)=>a.name.localeCompare(b.name,'en'))
  const digest=crypto.createHash('sha256')
  for(const entry of entries)digest.update(entry.name+'\0').update(hash(entry.data)+'\n')
  return {entries,digest:digest.digest('hex'),bytes:entries.reduce((sum,x)=>sum+x.data.length,0)}
}

function verifyTree(root,entries,tree) {
  if(tree.length>=20000)throw Error('资源快照目录过大，无法确认完整性')
  for(const entry of entries) {
    const parts=entry.name.split('/'), filename=parts.pop(), stem=filename.slice(0,-3)
    const parent=parts.length?'/'+parts.join('/'):''
    const parsed=`${root}${parent}/${stem}`
    const direct=`${root}${parent}/${filename}`
    if(!tree.some(row=>!row.isDir && typeof row.uri==='string' && (row.uri===direct || (row.uri.startsWith(parsed+'/') && /\/(?!\.)[^/]+\.md$/i.test(row.uri))))) throw Error(`资源快照缺少文件：${entry.name}`)
  }
}

export async function withActiveSnapshot({settings,home=DSH_HOME}, fn) {
  let release
  try {release=await acquireProcessLock(pointerPath(home)+'.switch')} catch {throw Error('资源快照正在切换，请稍后重试')}
  try {const state=readSnapshot({settings,home});if(!state)throw Error('还没有资源快照，请先运行 resource rebuild');return await fn(state)} finally {await release()}
}

export async function rebuildResourceSnapshot({client,settings,home=DSH_HOME,docsDir=defaultDocs,onlyIfDue=false,intervalDays=7,now=Date.now}) {
  if(!Number.isInteger(intervalDays)||intervalDays<1||intervalDays>365)throw Error('资源重建间隔须为 1 至 365 天')
  let release
  try {release=await acquireProcessLock(pointerPath(home)+'.build')} catch {throw Error('资源重建正在进行，请稍后重试')}
  try {
    const old=readSnapshot({settings,home})
    const staging=stagingPath(home,settings)
    let pending
    try {pending=JSON.parse(fs.readFileSync(staging,'utf8'))} catch(e) {if(e.code!=='ENOENT')throw Error('资源重建临时记录损坏，请检查后重试')}
    if(pending) {
      if(!ROOT_RE.test(pending.root))throw Error('资源重建临时记录无效，未删除任何资源')
      if(pending.root!==old?.root)await client.removeSnapshot(pending.root)
      fs.unlinkSync(staging)
    }
    if(old?.previous) {
      await client.removeSnapshot(old.previous)
      const cleaned={...old};delete cleaned.previous;savePointer(home,cleaned);delete old.previous
    }
    const age=old?now()-(old.checkedAt??old.createdAt):0
    if(onlyIfDue&&old&&age>=0&&age<intervalDays*DAY)return {status:'not_due',createdAt:old.createdAt,root:old.root}
    const source=collectResourceFiles({home,docsDir})
    if(onlyIfDue && old && old.sourceDigest===source.digest) {
      old.checkedAt=now();savePointer(home,old)
      return {status:'unchanged',createdAt:old.createdAt,checkedAt:old.checkedAt,root:old.root}
    }
    // Capture once. Changes after this point belong to the next scheduled build;
    // rejecting them after a long import can starve an actively used diary.
    if(collectResourceFiles({home,docsDir}).digest!==source.digest)throw Error('采集资源时本地文件正在变化，请稍后重建')
    const capturedAt=now()
    const root='viking://resources/whale-snapshot-'+crypto.randomUUID().replaceAll('-','')
    const zip=makeResourceZip(source.entries)
    saveStaging(staging,root)
    let imported
    try {
      imported=await client.importSnapshot(root,zip)
      verifyTree(root,source.entries,await client.snapshotTree(root))
    } catch(e) {throw Error(`新快照 ${root} 未启用：${e.message}；旧快照未改变`)}
    let unlock
    try {unlock=await acquireProcessLock(pointerPath(home)+'.switch')} catch {throw Error(`新快照 ${root} 已创建，但切换锁不可用；旧快照未改变`)}
    let next,cleanupWarning=null
    try {
      const current=readSnapshot({settings,home})
      if ((current?.root||null)!==(old?.root||null)) throw Error('资源快照已在其他进程变化，未切换')
      // Clean a previous unsuccessful removal before replacing its reference.
      if(current?.previous)await client.removeSnapshot(current.previous)
      next={identity:identity(settings),root,createdAt:capturedAt,sourceDigest:source.digest,files:source.entries.length,bytes:source.bytes,usage:imported?.usage??null,...(current?{previous:current.root}:{})}
      savePointer(home,next)
      try {fs.unlinkSync(staging)} catch {cleanupWarning='新快照已启用，但临时记录未能清除；下次检查会处理'}
    } finally {await unlock()}
    // Searches now use the new root; do not hold the switch lock while the
    // service removes old data. The build lock still excludes another rebuild.
    if(next.previous) {
      try {await client.removeSnapshot(next.previous);delete next.previous;savePointer(home,next)} catch {cleanupWarning='新快照已启用，但旧快照未能删除；下次检查会处理'}
    }
    if(typeof client.cleanupLegacy==='function') {
      try {const warnings=await client.cleanupLegacy(source.entries);if(warnings.length)cleanupWarning=[cleanupWarning,...warnings].filter(Boolean).join('；')}
      catch {cleanupWarning=[cleanupWarning,'旧版资源检查未完成'].filter(Boolean).join('；')}
    }
    return {status:'rebuilt',root,files:source.entries.length,bytes:source.bytes,createdAt:next.createdAt,usage:next.usage,cleanupWarning}
  } finally {await release()}
}
