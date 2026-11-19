import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { openVikingSettings } from './openviking.js'
import { DSH_HOME } from '../tools/lib/paths.mjs'
import {memoryScope, memoryPerson, validMid, normalizeMemorySource, isoTime} from './memory-format.js'

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
  source = {channel,visibility:channel === 'comment' ? 'public' : 'private',...source}
  const event = { scope, eventId:id, owner: String(owner), ...(group ? {group} : {}), source, role, content: String(content),
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
