import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {DSH_HOME} from '../tools/lib/paths.mjs'
import {acquireProcessLock} from '../tools/lib/process-lock.mjs'
import {formatMemoryMessage, isoTime, memoryScope} from './memory-format.js'
import {createOpenViking, openVikingSettings} from './openviking.js'
import {readLegacyDiaries} from './diary-import.js'

const LOCAL_OFFSET = 8 * 3600000
const MONTH_CUTOFF = 5 * 3600000
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const diaryDir = home => path.join(home,'whale-diary-entries')

function diaryMonth(at) {
  const local = new Date(Date.parse(at) + LOCAL_OFFSET - MONTH_CUTOFF)
  const year = local.getUTCFullYear(),month = local.getUTCMonth()
  const start = new Date(Date.UTC(year,month,1))
  return {
    date:start.toISOString().slice(0,10).replaceAll('-',''),
    midpoint:Date.UTC(year,month,15) + MONTH_CUTOFF - LOCAL_OFFSET,
    end:Date.UTC(year,month+1,1) + MONTH_CUTOFF - LOCAL_OFFSET,
  }
}

export function archiveDiary({book,at,content},{home = DSH_HOME} = {}) {
  if (!['public','private'].includes(book)) throw Error('日记本须为 public 或 private')
  at = isoTime(at)
  if (typeof content !== 'string' || !content.trim() || content.length > 11000) throw Error('日记正文须为 1 至 11000 字符')
  content = content.replace(/\r\n/g,'\n').trim()
  const id = hash(JSON.stringify([book,at,content]))
  const dir = diaryDir(home)
  fs.mkdirSync(dir,{recursive:true})
  const file = path.join(dir,id+'.json'),temp = file+'.'+crypto.randomUUID()+'.tmp'
  try {
    fs.writeFileSync(temp,JSON.stringify({id,book,at,content}),{flag:'wx',mode:0o600})
    try { fs.linkSync(temp,file) } catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally { fs.rmSync(temp,{force:true}) }
  return {id,book,at}
}

export async function syncDiaryMemory({home = DSH_HOME, manual = false,
  settings = openVikingSettings(process.env,path.join(home,'whale-openviking.json')),
  client,now = Date.now,log = () => {}} = {}) {
  const dir = diaryDir(home)
  const result = {sessions:0,entries:0,uploaded:0,extracted:0,failed:0}
  if (!settings) return {...result,reason:'disabled'}
  const emptyResult = () => ({...result,reason:'no_archives',legacyDiaries:['whale-diary.md','whale-diary-private.md'].filter(name=>fs.existsSync(path.join(home,name)))})
  if (!manual && !fs.existsSync(dir)) return emptyResult()
  const release = await acquireProcessLock(path.join(dir,'worker'))
  try {
    if(manual) {
      const legacy=readLegacyDiaries(home)
      result.importWarnings=legacy.warnings
      result.imported=0
      for(const entry of legacy.entries) {
        const id=hash(JSON.stringify([entry.book,isoTime(entry.at),entry.content]))
        const exists=fs.existsSync(path.join(dir,id+'.json'))
        archiveDiary(entry,{home})
        if(!exists)result.imported++
      }
      fs.mkdirSync(dir,{recursive:true})
      const report=path.join(dir,'legacy-import.json'),temp=report+'.'+crypto.randomUUID()+'.tmp'
      try {
        fs.writeFileSync(temp,JSON.stringify({at:new Date(now()).toISOString(),parsed:legacy.entries.length,imported:result.imported,warnings:legacy.warnings}),{flag:'wx',mode:0o600})
        fs.renameSync(temp,report)
      } finally {fs.rmSync(temp,{force:true})}
      if(legacy.warnings.length)log(`日记导入有 ${legacy.warnings.length} 条记录需要人工检查`)
    }
    if (!fs.existsSync(dir)) return emptyResult()
    const api = client || createOpenViking(settings)
    const suffix = hash(JSON.stringify([memoryScope(settings),path.resolve(home)])).slice(0,16)
    const groups = new Map()
    for (const name of fs.readdirSync(dir).filter(name=>/^[a-f0-9]{64}\.json$/.test(name))) {
      const entry = JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))
      const {date,end,midpoint} = diaryMonth(entry.at)
      const id = `${date}-whale-diary-${entry.book}-${suffix}`
      if (!groups.has(id)) groups.set(id,{end,midpoint,entries:[]})
      groups.get(id).entries.push(entry)
    }
    const records = new Map()
    if (!groups.size) return emptyResult()
    for (const id of groups.keys()) {
      try { records.set(id,JSON.parse(fs.readFileSync(path.join(dir,id+'.sync.json'),'utf8'))) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    for (const [id,{end,midpoint,entries}] of groups) {
      const previous = records.get(id)
      const phase = now() >= end ? 'closed' : now() >= midpoint ? 'midmonth' : null
      const known = new Set(previous?.entryIds || [])
      const newEntries = entries.filter(entry=>!known.has(entry.id))
      if (manual && previous?.status === 'done' && !newEntries.length) continue
      if (!manual && previous?.status !== undefined && previous.status !== 'done' && !previous.extractionPending) {
        result.failed++
        continue
      }
      const extractionDue = phase && (manual || previous?.attemptedPhase !== phase || (!previous?.extractionPending && phase === 'closed' && newEntries.length)) && (previous?.extractionPending || previous?.extractedPhase !== phase || (phase === 'closed' && newEntries.length))
      if (!manual && !newEntries.length && !extractionDue) continue
      result.sessions++
      result.entries += entries.length
      const file = path.join(dir,id+'.sync.json')
      const record = {...previous,status:'running',attemptedAt:new Date(now()).toISOString(),entryIds:[...known]}
      const persist = () => {
        const temp = file+'.'+crypto.randomUUID()+'.tmp'
        try { fs.writeFileSync(temp,JSON.stringify(record),{flag:'wx',mode:0o600});fs.renameSync(temp,file) }
        finally { fs.rmSync(temp,{force:true}) }
      }
      persist()
      try {
        const remote = await api.sessionMessages(id)
        const uploaded = new Set(remote.map(content=>{
          const source = content.split('\n',2)[1]?.match(/^\[来源 (.+)\]$/)
          if (!source) throw Error('OV 日记条目缺少来源标注')
          const metadata = JSON.parse(source[1])
          if (metadata.channel !== 'diary' || !/^[a-f0-9]{64}$/.test(metadata.event_id)) throw Error('OV 日记条目标识无效')
          return metadata.event_id
        }))
        const missing = entries.filter(entry=>!uploaded.has(entry.id))
        if (!manual && missing.some(entry=>known.has(entry.id))) throw Error('OV 缺少已同步日记，请从设置页补传')
        for (const entry of missing.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id))) {
          const content = formatMemoryMessage({role:'assistant',content:entry.content,created_at:entry.at,
            source:{channel:'diary',book:entry.book,visibility:'private'},event_id:entry.id})
          await api.appendMessage(id,{role:'assistant',content,created_at:entry.at})
          uploaded.add(entry.id)
          result.uploaded++
        }
        record.entryIds = entries.map(entry=>entry.id)
        if (phase && (extractionDue || (manual && missing.length))) {
          record.extractionPending = true
          record.attemptedPhase = phase
          persist()
          await api.extractSession(id)
          delete record.extractionPending
          record.extractedPhase = phase
          record.extractions = {...record.extractions,[phase]:new Date(now()).toISOString()}
          result.extracted++
        }
        record.status = record.extractionPending ? 'failed' : 'done'
        record.completedAt = new Date(now()).toISOString()
        delete record.error
      } catch (error) {
        record.status = 'failed'
        record.error = error.message
        result.failed++
        log(`日记会话 ${id} 同步未完成，可在设置页补传：${error.message}`)
      }
      persist()
    }
    return result
  } finally { await release() }
}
