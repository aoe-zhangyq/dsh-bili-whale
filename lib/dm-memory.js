import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createOpenViking, openVikingSettings } from './openviking.js'
import { acquireProcessLock } from '../tools/lib/process-lock.mjs'
import { DSH_HOME } from '../tools/lib/paths.mjs'
import {memoryScope, memoryPerson, validMid, formatMemoryMessage, normalizeMemorySource, isoTime} from './memory-format.js'

const DAY = 86400000, LIMIT = 12000, IDLE = 5 * 60000
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

function sessionId(scope, event, channel) {
  const source = event.source
  const label = channel === 'dm' && numeric(event.owner) ? `mid-${event.owner}`
    : channel === 'comment' && source?.thread ? `type-${source.thread.type}-oid-${source.thread.oid}-root-${source.thread.root}`
    : 'events'
  return `whale-${channel}-${scope.slice(0, 16)}-${label}-${crypto.randomUUID()}`
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
  const event = { scope, eventId:id, owner: String(owner), ...(group ? {group} : {}), ...(source ? {source} : {}), role, content: String(content),
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

export async function flushDmMemory({ home = DSH_HOME, settings = openVikingSettings(process.env, path.join(home, 'whale-openviking.json')), now = Date.now, client, log = () => {}, channel = 'dm' } = {}) {
  if (!settings) return
  const dir = dirFor(home, channel)
  if (!fs.existsSync(dir)) return
  const release = await acquireProcessLock(path.join(dir, 'worker'))
  try {
    const scope = identity(settings), api = client || createOpenViking(settings)
    const events = fs.readdirSync(dir).filter(x => /^event-[a-f0-9]{64}\.json$/.test(x)).map(name => {
      const file = path.join(dir, name), event = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { file, ...event }
    }).filter(x => x.scope === scope && x.status === 'queued').sort((a, b) => a.receivedAt - b.receivedAt || a.createdAt.localeCompare(b.createdAt) || (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1) || a.file.localeCompare(b.file))
    const stateFile = path.join(dir, 'sessions-' + scope + '.json')
    let states = {}
    try { states = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    const persist = () => save(stateFile, states)
    const extract = async state => {
      // Seal durably before the request. A timeout may mean the model already
      // wrote memories; never replay that entire batch when new messages arrive.
      state.dirty = false; state.sealed = true; persist()
      try { await api.extractSession(state.id) } catch (e) { log(`${channel} 记忆提取未确认，该批已封存，请检查服务端会话 ${state.id}：` + e.message) }
    }
    for (const event of events) {
      const content = messageContent(event, channel)
      if (content.length > LIMIT) { log(`${channel} 记忆内容过长，保留本地记录并跳过：` + event.file); continue }
      const group = event.group || event.owner
      let state = states[group]
      if (state && (state.sealed || (!state.dirty && state.length>0 && state.sealed===undefined) || now() - state.startedAt >= 7 * DAY || state.length + content.length > LIMIT)) {
        if (state.dirty) await extract(state)
        state = null
      }
      if (!state) state = states[group] = { id: sessionId(scope, event, channel), startedAt: now(), length: 0, dirty: false, sealed: false }
      // Mark before the request: a lost response must never resend the same message.
      event.status = 'uncertain'; event.sessionId = state.id; save(event.file, event)
      state.length += content.length; state.dirty = true; state.lastActivity = event.receivedAt; persist()
      try {
        await api.appendMessage(state.id, { role: event.role, content, created_at: event.createdAt })
        event.status = 'sent'; delete event.content; save(event.file, event)
      } catch (e) { log(`${channel} 记忆追加结果未确认（会话 ${state.id}），保留记录且不自动重发：` + e.message); break }
    }
    for (const state of Object.values(states)) if (state.dirty && now() - state.lastActivity >= (channel === 'activity' ? 30 * 60000 : IDLE)) await extract(state)
  } finally { await release() }
}
