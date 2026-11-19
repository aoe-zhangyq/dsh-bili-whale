import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {DSH_HOME,credentialsPath} from '../tools/lib/paths.mjs'
import {acquireProcessLock} from '../tools/lib/process-lock.mjs'
import {nextHistoryCursor,oldestHistoryRow,readHistoryIdentity,readHistoryPage} from '../tools/lib/dm-history.mjs'
import {makeHeaders} from '../tools/lib/msgfeed.mjs'
import {createOpenViking,openVikingSettings} from './openviking.js'
import {formatMemoryMessage,memoryExtractionCheckpoint,memoryPerson,memoryScope,validMid} from './memory-format.js'

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const cacheDir = home => path.join(home,'whale-dm-history')
const cacheFile = (home,mid) => path.join(cacheDir(home),`${mid}.json`)
const emptyCache = {messages:[],withdrawn:[]}

export function parseDmHistoryStart(date) {
  if (date===undefined || date==='') return undefined
  if (typeof date!=='string' || !/^\d{4}-\d\d-\d\d$/.test(date)) throw Error('请选择有效的私信起始日期')
  const local = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0,10)!==date) throw Error('请选择有效的私信起始日期')
  const since = local/1000 - 8*3600
  if (since>Date.now()/1000) throw Error('私信起始日期不能晚于今天')
  return since
}

function read(file,fallback) {
  try { return JSON.parse(fs.readFileSync(file,'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}

function save(file,value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600})
    fs.renameSync(temp,file)
  } finally { fs.rmSync(temp,{force:true}) }
}

function cachedMids(home) {
  const dir = cacheDir(home)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(file=>/^[1-9]\d{0,29}\.json$/.test(file)).map(file=>path.basename(file,'.json')).sort()
}

export async function recordDmHistory(mid,rows,{home=DSH_HOME,selfMid,name,progress}={}) {
  mid = String(mid)
  if (!validMid(mid)) throw Error('无效的私信对方 MID')
  if (!rows.length && progress===undefined) return
  selfMid = validMid(selfMid) ? String(selfMid) : null
  const file = cacheFile(home,mid)
  let release
  for (let attempt=0; !release; attempt++) {
    try { release = await acquireProcessLock(file) }
    catch (error) { if (attempt===9 || !error.message.includes('EADDRINUSE')) throw error; await delay(50) }
  }
  try {
    const {messages,withdrawn,backfill} = read(file,emptyCache)
    const known = new Map(messages.map(row=>[row.key,row]))
    const tombstones = new Set(withdrawn)
    let changed = false
    for (const row of rows) {
      if (row.sender!==mid && row.sender!==selfMid) continue
      if (row.type===5) {
        if (!row.withdrawn || tombstones.has(row.withdrawn)) continue
        tombstones.add(row.withdrawn)
        known.delete(row.withdrawn)
        changed = true
        continue
      }
      if (!row.key || tombstones.has(row.key) || known.has(row.key) || !row.text.trim()) continue
      known.set(row.key,{
        key:row.key, sender:row.sender, role:row.sender===mid?'user':'assistant',
        at:new Date(row.ts*1000).toISOString(), type:row.type, text:row.text,
        ...(row.seq ? {seq:row.seq} : {}), ...(name ? {name} : {}),
      })
      changed = true
    }
    if (changed || (progress!==undefined && (progress || backfill))) {
      fs.mkdirSync(cacheDir(home),{recursive:true})
      const pending = progress===undefined ? backfill : progress
      save(file,{messages:[...known.values()],withdrawn:[...tombstones],...(pending ? {backfill:pending} : {})})
    }
  } finally { await release() }
}

export async function backfillDmHistory({home=DSH_HOME,owner,since,signal,log=()=>{}}) {
  const mids = new Set(cachedMids(home))
  if (validMid(owner?.mid)) mids.add(String(owner.mid))
  if (!mids.size) throw Error('请先设置主人 MID，或保留至少一个本地私信缓存')
  const credentials = read(credentialsPath,null)
  if (!credentials?.sessdata) throw Error('请先登录 B 站再补拉历史私信')
  const headers = makeHeaders(credentials)
  const identity = await readHistoryIdentity(headers)
  if (!validMid(identity.selfMid)) throw Error('无法确认 B 站登录账号，请重新登录后补拉历史私信')
  const selfMid = String(identity.selfMid)
  const result = {completed:0,failed:0,endedEarly:0}
  for (const mid of mids) {
    signal?.throwIfAborted()
    if (mid===selfMid) continue
    const name = String(owner?.mid)===mid ? owner.name : undefined
    const saved = read(cacheFile(home,mid),emptyCache).backfill
    let resume = saved?.since===since && saved.selfMid===selfMid ? saved : null
    let progress = resume || undefined, cursor = '0', pages = 0, rowsToSave = [], reachedDate = false
    const saveBatch = async checkpoint => {
      await recordDmHistory(mid,rowsToSave,{home,selfMid,name,progress:checkpoint})
      rowsToSave = []
    }
    try {
      for (;;) {
        signal?.throwIfAborted()
        const {rows,exhausted} = await readHistoryPage(mid,headers,identity.wbi,cursor,signal)
        rowsToSave.push(...rows.filter(row=>row.ts>=since))
        // Dated backfills confirm the end with an empty page. A nonempty page
        // can advertise has_more=0 even though an older cursor still works.
        if (!rows.length && exhausted) break
        const oldest = oldestHistoryRow(rows)
        if (oldest?.ts>0 && (oldest.sender===mid || oldest.sender===selfMid)) {
          if (oldest.ts<=since) reachedDate = true
          if (oldest.ts<since) break
        }
        let next = nextHistoryCursor(rows,cursor)
        if (resume && BigInt(next)<=BigInt(resume.anchor)) {
          // Read newly arrived pages before jumping over the range already saved.
          if (BigInt(next)>BigInt(resume.cursor)) next = resume.cursor
          resume = null
        }
        if (!resume) progress = {since,selfMid,cursor:next,anchor:progress?.anchor ?? next}
        cursor = next
        if (++pages%10===0) await saveBatch(progress)
      }
      await saveBatch(null)
      result.completed++
      if (!reachedDate) result.endedEarly++
    } catch (error) {
      await saveBatch(progress)
      signal?.throwIfAborted()
      result.failed++
      log(`B 站私信 MID ${mid} 历史补拉未完成：${error.message}`)
    }
  }
  return result
}

function remoteEventId(content) {
  const source = content.split('\n',2)[1]?.match(/^\[来源 (.+)\]$/)
  return source ? JSON.parse(source[1])?.event_id : null
}

function chronological(a,b) {
  const left = a.seq ?? '', right = b.seq ?? ''
  return a.at.localeCompare(b.at) || left.length-right.length || left.localeCompare(right) || a.key.localeCompare(b.key)
}

export async function syncDmHistory({home=DSH_HOME,
  settings=openVikingSettings(process.env,path.join(home,'whale-openviking.json')),
  client,now=Date.now,extract=false,log=()=>{}}={}) {
  if (!settings) throw Error('OpenViking 未启用')
  const dir = cacheDir(home)
  const result = {sessions:0,entries:0,uploaded:0,extracted:0,failed:0}
  if (!fs.existsSync(dir)) return result
  const scope = memoryScope(settings)
  const stateFile = path.join(dir,`sync-${scope}.json`)
  const release = await acquireProcessLock(stateFile)
  try {
    const states = read(stateFile,{})
    const api = client || createOpenViking(settings)
    if (extract) {
      const checkpoint = memoryExtractionCheckpoint(now())
      for (const [id,pendingSince] of Object.entries(states)) {
        if (pendingSince>checkpoint) continue
        try {
          await api.extractSession(id)
          delete states[id]
          save(stateFile,states)
          result.extracted++
        } catch (error) { result.failed++; log(`私信会话 ${id} 提取未完成：${error.message}`) }
      }
      return result
    }

    const suffix = hash([scope,path.resolve(home)]).slice(0,16)
    for (const mid of cachedMids(home)) {
      const id = `whale-dm-${mid}-${suffix}`
      try {
        const {messages} = read(cacheFile(home,mid),emptyCache)
        if (!messages.length) continue
        result.sessions++
        result.entries += messages.length
        const known = new Set((await api.sessionMessages(id)).map(remoteEventId))
        for (const row of messages.sort(chronological)) {
          // Bound each OV message while preserving the entire cached payload.
          const parts = row.text.match(/[\s\S]{1,5500}/gu)
          let uploaded = false
          for (const [index,part] of parts.entries()) {
            const eventId = hash([row.sender,row.key,index])
            if (known.has(eventId)) continue
            const source = {channel:'dm',visibility:'private',verification:'platform',person:memoryPerson(mid,row.name,true),
              message_key:row.key,message_type:row.type,sender_mid:row.sender,
              ...(parts.length>1 ? {part:index+1,parts:parts.length} : {})}
            const content = formatMemoryMessage({role:row.role,content:part,created_at:row.at,source,event_id:eventId})
            if (!Object.hasOwn(states,id)) {
              states[id] = now()
              save(stateFile,states)
            }
            await api.appendMessage(id,{role:row.role,content,created_at:row.at})
            known.add(eventId)
            uploaded = true
          }
          if (uploaded) result.uploaded++
        }
      } catch (error) { result.failed++; log(`B 站私信 MID ${mid} 同步未完成：${error.message}`) }
    }
    return result
  } finally { await release() }
}
