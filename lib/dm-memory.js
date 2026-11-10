import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createOpenViking, openVikingSettings } from './openviking.js'
import { acquireProcessLock } from '../tools/lib/process-lock.mjs'
import { DSH_HOME } from '../tools/lib/paths.mjs'
import {memoryScope, memoryPerson, validMid, formatMemoryMessage, normalizeMemorySource, isoTime} from './memory-format.js'

const LIMIT = 12000, IDLE = 5 * 60000
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const identity = memoryScope
const dirFor = (home, channel = 'dm') => path.join(home, `whale-${channel}-memory`)
const commentGroup = (owner, type, oid, root) => hash(JSON.stringify([String(owner),String(type),String(oid),String(root)]))
const commentKey = (group, id) => group + ':' + String(id)
const threadGroup = (type, oid, root) => hash(JSON.stringify(['thread', String(type), String(oid), String(root)]))
const eventId = (scope, owner, role, key, channel, group) => channel === 'comment'
  ? hash(JSON.stringify([scope, 'comment', group, role, String(key)]))
  : hash(JSON.stringify([scope, String(owner), role, String(key)]))
const numeric = validMid
const person = memoryPerson

function messageContent(event, channel) {
  // Legacy queued events also get a stable identity, without inventing a nickname.
  const source = event.source || (['dm', 'comment'].includes(channel) && numeric(event.owner)
    ? {channel, visibility: channel === 'dm' ? 'private' : 'public', person: person(event.owner, '', true)} : {channel})
  return formatMemoryMessage({role:event.role,content:event.content,created_at:event.createdAt,source,
    event_id:event.eventId || path.basename(event.file).slice(6,-5),recorded_at:new Date(event.receivedAt).toISOString()})
}

function currentDshSession(home, channel) {
  if (process.env.WHALE_DSH_SESSION_ID) return process.env.WHALE_DSH_SESSION_ID
  const file = path.join(home, channel === 'comment' ? 'whale-public-session.json' : 'whale-session.json')
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof state.id !== 'string' || !state.id.trim()) throw Error('invalid session')
    return state.id
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('DSH 会话状态无法读取，停止记忆入队')
    return channel === 'comment' ? 'bili-whale-public' : 'bili-whale'
  }
}

function sessionId(scope, home, dshSessionId, channel) {
  // Private activities and DMs share the DSH conversation. Public work uses
  // its own namespace even if a caller supplies the same DSH ID.
  const audience = channel === 'comment' ? 'public' : 'private'
  return `whale-dsh-${scope.slice(0, 16)}-${hash(JSON.stringify([path.resolve(home), audience, dshSessionId])).slice(0,32)}`
}
function save(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp'
  try { fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file) }
  finally { fs.rmSync(temp, { force: true }) }
}

export function recordOwnerComment({owner, ...input}, options = {}) {
  return recordCommentMessage({...input, mid: owner, isOwner: true}, options)
}

export function recordCommentMessage({mid, name, isOwner = false, type, oid, root, id, bvid, content, createdAt}, options = {}) {
  if (![mid, type, oid, root, id].every(numeric) || !String(content || '').trim()) return false
  const group = threadGroup(type, oid, root)
  const source = {channel: 'comment', visibility: 'public', verification: 'platform', person: person(mid, name, isOwner),
    thread: {type: String(type), oid: String(oid), root: String(root)}, rpid: String(id),
    ...(/^BV[0-9A-Za-z]{10}$/.test(bvid || '') ? {bvid} : {})}
  // Preserve de-duplication for owner comments recorded by older versions.
  const home = options.home || DSH_HOME
  const settings = options.settings === undefined ? openVikingSettings(process.env, path.join(home, 'whale-openviking.json')) : options.settings
  if (!settings) return false
  const legacyGroup = commentGroup(mid, type, oid, root)
  const legacyId = hash(JSON.stringify([identity(settings), String(mid), 'user', commentKey(legacyGroup, id)]))
  if (fs.existsSync(path.join(dirFor(home, 'comment'), 'event-' + legacyId + '.json'))) return false
  return recordDmMemory({owner: mid, group, channel: 'comment', role: 'user', key: commentKey(group, id), source, createdAt, content}, {...options, home, settings})
}

export function recordCommentReply({owner,type,oid,root,parent,id,content,createdAt}, options = {}) {
  const home=options.home || DSH_HOME, settings=options.settings === undefined ? openVikingSettings(process.env,path.join(home,'whale-openviking.json')) : options.settings
  if (!settings || ![type,oid,root,parent,id].every(numeric)) return false
  const scope=identity(settings), dir=dirFor(home,'comment')
  let group=threadGroup(type,oid,root)
  let parentId=eventId(scope, '', 'user', commentKey(group,parent), 'comment', group)
  let file=path.join(dir,'event-'+parentId+'.json')
  if (!fs.existsSync(file)) {
    group=commentGroup(owner,type,oid,root)
    parentId=hash(JSON.stringify([scope,String(owner),'user',commentKey(group,parent)]))
    file=path.join(dir,'event-'+parentId+'.json')
    if (!fs.existsSync(file)) return false
  }
  const original=JSON.parse(fs.readFileSync(file,'utf8'))
  const legacyReplyId=hash(JSON.stringify([scope,String(owner),'assistant',commentKey(group,id)]))
  if (fs.existsSync(path.join(dir,'event-'+legacyReplyId+'.json'))) return false
  const source={...(original.source || {channel:'comment',visibility:'public',person:person(original.owner,'',true),thread:{type:String(type),oid:String(oid),root:String(root)}}),rpid:String(id),parent:String(parent)}
  source.verification='platform'
  source.person={...source.person,relationship:String(original.owner) === String(owner || '') ? 'owner' : 'other'}
  return recordDmMemory({owner:original.owner,group,channel:'comment',role:'assistant',key:commentKey(group,id),source,createdAt,content},{...options,home,settings})
}

// One durable file per event avoids competing writes between the listener and sender.
export function recordDmMemory({ owner, name, role, content, createdAt, key, group, source, channel = 'dm' }, { home = DSH_HOME, settings = openVikingSettings(process.env, path.join(home, 'whale-openviking.json')), now = Date.now } = {}) {
  if (!settings || !owner || !['user', 'assistant'].includes(role) || !String(content || '').trim()) return false
  if (!['dm', 'comment', 'activity'].includes(channel)) throw Error('无效的记忆渠道')
  const timestamp = new Date(createdAt).toISOString()
  const scope = identity(settings), dir = dirFor(home, channel)
  fs.mkdirSync(dir, { recursive: true })
  const id = eventId(scope, owner, role, key, channel, group)
  const file = path.join(dir, 'event-' + id + '.json')
  if (!source && channel === 'dm' && numeric(owner)) source={channel,visibility:'private',verification:'platform',person:person(owner,name,true)}
  const dshSessionId = currentDshSession(home, channel)
  source = {channel,visibility:channel === 'comment' ? 'public' : 'private',...source}
  const event = { scope, eventId:id, dshSessionId, owner: String(owner), ...(group ? {group} : {}), source, role, content: String(content),
    ...(channel==='comment' && source?.verification==='platform' && source.visibility==='public' ? {publicContent:String(content)} : {}),createdAt: timestamp, receivedAt: now(), status: 'queued' }
  try { fs.writeFileSync(file, JSON.stringify(event), { flag: 'wx', mode: 0o600 }); return true }
  catch (e) { if (e.code === 'EEXIST') return false; throw e }
}

export function recordExperience(input, {ownerMid,...options}={}) {
  const message=typeof input==='string'?{content:input}:input
  if(!message || typeof message!=='object' || typeof message.content!=='string' || !message.content.trim() || message.content.length>11000) throw Error('经历须包含 1 至 11000 字符的 content')
  if(message.role!==undefined && message.role!=='assistant') throw Error('自主经历必须使用 assistant 角色')
  if(message.event_id!==undefined && (typeof message.event_id!=='string' || !/^[A-Za-z0-9_-]{1,120}$/.test(message.event_id))) throw Error('无效的经历 event_id')
  const source=normalizeMemorySource(message.source,{ownerMid,channel:'activity'})
  source.time_basis=message.created_at?'occurrence':'submission'
  const createdAt=message.created_at?isoTime(message.created_at):new Date((options.now || Date.now)()).toISOString()
  return recordDmMemory({owner:'activity',role:'assistant',content:message.content,source,createdAt,
    key:message.event_id?`experience:${message.event_id}`:crypto.randomUUID(),channel:'activity'},options)
}

export async function flushDmMemory({ home = DSH_HOME, settings = openVikingSettings(process.env, path.join(home, 'whale-openviking.json')), now = Date.now, client, log = () => {}, channel = 'dm', extractIdle = false, dshSessionId, strict = false, locked = false } = {}) {
  if (!settings) return
  const dir = dirFor(home, channel)
  if (!fs.existsSync(dir)) return
  const release = locked ? () => {} : await acquireProcessLock(path.join(dir, 'worker'))
  try {
    const scope = identity(settings), api = client || createOpenViking(settings)
    const events = fs.readdirSync(dir).filter(x => /^event-[a-f0-9]{64}\.json$/.test(x)).map(name => {
      const file = path.join(dir, name), event = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { file, ...event }
    }).filter(x => x.scope === scope && x.status === 'queued' && (!dshSessionId || !x.dshSessionId || x.dshSessionId === dshSessionId))
      .sort((a, b) => a.receivedAt - b.receivedAt || a.createdAt.localeCompare(b.createdAt) || (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1) || a.file.localeCompare(b.file))
    const stateFile = path.join(dir, 'sessions-' + scope + '.json')
    let states = {}
    try { states = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    const persist = () => save(stateFile, states)
    const extract = async state => {
      // Attempt once for the current batch. Future messages intentionally
      // trigger extraction of the same growing session, including old text.
      state.dirty = false; persist()
      try {
        await api.extractSession(state.id)
        state.extractedLength = state.length
        persist()
      } catch (e) { log(`${channel} 记忆提取未确认，请检查服务端会话 ${state.id}；新消息仍沿用该会话：` + e.message) }
    }
    for (const event of events) {
      const eventSessionId = event.dshSessionId || dshSessionId || currentDshSession(home, channel)
      event.dshSessionId = eventSessionId
      const content = messageContent(event, channel)
      if (content.length > LIMIT) {
        if (strict) throw Error(`${channel} 记忆内容过长，暂停 DSH 会话轮换：${event.file}`)
        log(`${channel} 记忆内容过长，保留本地记录并跳过：` + event.file); continue
      }
      const id = sessionId(scope, home, eventSessionId, channel)
      const group = 'dsh:' + id
      let state = states[group]
      if (!state) state = states[group] = { id, dshSessionId:eventSessionId, startedAt: now(), length: 0, dirty: false }
      // Mark before the request: a lost response must never resend the same message.
      event.status = 'uncertain'; event.sessionId = state.id; save(event.file, event)
      state.length += content.length; state.dirty = true; state.lastActivity = event.receivedAt; persist()
      try {
        await api.appendMessage(state.id, { role: event.role, content, created_at: event.createdAt })
        event.status = 'sent'; delete event.content; save(event.file, event)
      } catch (e) {
        if (strict) throw e
        log(`${channel} 记忆追加结果未确认（会话 ${state.id}），保留记录且不自动重发：` + e.message); break
      }
    }
    if (extractIdle) for (const state of Object.values(states)) if (state.dirty && now() - state.lastActivity >= (channel === 'activity' ? 30 * 60000 : IDLE)) await extract(state)
    return {file:stateFile,states}
  } finally { await release() }
}

// Snapshot the old conversation, then release queue locks during the slow
// extraction so new DSH conversations can continue appending.
export async function extractDshMemory({home = DSH_HOME, dshSessionId, audience = 'private',
  settings = openVikingSettings(process.env,path.join(home,'whale-openviking.json')), client, now = Date.now} = {}) {
  if (!settings) return
  dshSessionId ??= currentDshSession(home,audience === 'public' ? 'comment' : 'dm')
  if (typeof dshSessionId !== 'string' || !dshSessionId.trim()) throw Error('缺少待提取的 DSH 会话 ID')
  if (!['private','public'].includes(audience)) throw Error('无效的记忆提取场景')
  const channels = audience === 'public' ? ['comment'] : ['dm','activity']
  const releases = [], snapshots = [], sessions = new Map()
  const api = client || createOpenViking(settings)
  try {
    for (const channel of channels) {
      releases.push(await acquireProcessLock(path.join(dirFor(home,channel),'worker')))
    }
    for (const channel of channels) {
      const snapshot = await flushDmMemory({home,settings,client:api,now,channel,dshSessionId,strict:true,locked:true})
      if (!snapshot) continue
      snapshots.push(snapshot)
      for (const state of Object.values(snapshot.states)) {
        if ((state.dshSessionId && state.dshSessionId !== dshSessionId) || !state.length) continue
        const pending = sessions.get(state.id) || false
        sessions.set(state.id,pending || state.extractedLength !== state.length)
      }
    }
    for (const release of releases.reverse()) await release()
    releases.length = 0
    for (const [id,pending] of sessions) if (pending) await api.extractSession(id)
    for (const channel of channels) releases.push(await acquireProcessLock(path.join(dirFor(home,channel),'worker')))
    // Merge completion into fresh state. Appends made while extracting must
    // retain their dirty marker and their own message count.
    for (const {file,states} of snapshots) {
      const latest = JSON.parse(fs.readFileSync(file,'utf8'))
      for (const [key,state] of Object.entries(states)) if (!state.dshSessionId || state.dshSessionId === dshSessionId) {
        latest[key].extractedLength = state.length
        latest[key].dirty = latest[key].length !== state.length
      }
      save(file,latest)
    }
    return {sessions:sessions.size,extracted:[...sessions.values()].filter(Boolean).length}
  } finally {
    for (const release of releases.reverse()) await release()
  }
}

export function queueDshMemoryExtraction({home = DSH_HOME, dshSessionId, audience = 'private',
  settings = openVikingSettings(process.env,path.join(home,'whale-openviking.json')), now = Date.now} = {}) {
  if (!settings) return
  if (!['private','public'].includes(audience)) throw Error('无效的记忆提取场景')
  dshSessionId ??= currentDshSession(home,audience === 'public' ? 'comment' : 'dm')
  if (typeof dshSessionId !== 'string' || !dshSessionId.trim()) throw Error('缺少待提取的 DSH 会话 ID')
  const scope = identity(settings),dir = path.join(home,'whale-memory-extractions')
  const id = hash(JSON.stringify([scope,audience,dshSessionId]))
  const file = path.join(dir,id+'.json')
  fs.mkdirSync(dir,{recursive:true})
  try {
    const previous = JSON.parse(fs.readFileSync(file,'utf8'))
    if (['queued','running'].includes(previous.status)) return {id,status:previous.status}
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  save(file,{id,scope,dshSessionId,audience,status:'queued',queuedAt:now()})
  return {id,status:'queued'}
}

export function retryMemoryExtraction(id,{home = DSH_HOME,
  settings = openVikingSettings(process.env,path.join(home,'whale-openviking.json'))} = {}) {
  if (!settings || !/^[a-f0-9]{64}$/.test(id)) throw Error('无效的本地提取任务 ID')
  const job = JSON.parse(fs.readFileSync(path.join(home,'whale-memory-extractions',id+'.json'),'utf8'))
  if (job.scope !== identity(settings)) throw Error('提取任务不属于当前服务身份')
  return queueDshMemoryExtraction({home,settings,dshSessionId:job.dshSessionId,audience:job.audience})
}

// This worker owns the slow HTTP request. A persisted running job left by a
// terminated process is uncertain and needs an explicit requeue.
export async function flushMemoryExtractions({home = DSH_HOME,
  settings = openVikingSettings(process.env,path.join(home,'whale-openviking.json')),
  client,now = Date.now,log = () => {}} = {}) {
  const dir = path.join(home,'whale-memory-extractions')
  if (!settings || !fs.existsSync(dir)) return
  const release = await acquireProcessLock(path.join(dir,'worker'))
  try {
    for (const name of fs.readdirSync(dir).filter(name=>/^[a-f0-9]{64}\.json$/.test(name))) {
      const file = path.join(dir,name),job = JSON.parse(fs.readFileSync(file,'utf8'))
      if (job.scope !== identity(settings)) continue
      if (job.status === 'running') {
        job.status = 'uncertain';save(file,job)
        log(`OV 提取任务 ${job.id} 在进程退出前未确认，请检查后执行 memory extract ${job.id}`)
        continue
      }
      if (job.status !== 'queued') continue
      job.status = 'running';job.startedAt = now();save(file,job)
      try {
        job.result = await extractDshMemory({home,settings,client,now,dshSessionId:job.dshSessionId,audience:job.audience})
        job.status = 'done';job.finishedAt = now()
      } catch (error) {
        job.status = 'failed'
        log(`OV 提取任务 ${job.id} 失败（DSH ${job.dshSessionId}）：${error.message}；检查后执行 memory extract ${job.id}`)
      }
      save(file,job)
    }
  } finally { await release() }
}
