import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createOpenViking, openVikingSettings } from './openviking.js'
import { acquireProcessLock } from '../tools/lib/process-lock.mjs'
import { DSH_HOME } from '../tools/lib/paths.mjs'

const DAY = 86400000, LIMIT = 12000, IDLE = 5 * 60000
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const identity = settings => hash(JSON.stringify([settings.url, settings.account || '', settings.user || '', settings.account ? '' : settings.key]))
const dirFor = (home, channel = 'dm') => path.join(home, `whale-${channel}-memory`)
const commentGroup = (owner, type, oid, root) => hash(JSON.stringify([String(owner),String(type),String(oid),String(root)]))
const commentKey = (group, id) => group + ':' + String(id)
function save(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp'
  try { fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file) }
  finally { fs.rmSync(temp, { force: true }) }
}

export function recordOwnerComment({owner, type, oid, root, id, content, createdAt}, options = {}) {
  if (!owner || !type || !oid || !root || !id || !String(content || '').trim()) return false
  const group=commentGroup(owner,type,oid,root)
  return recordDmMemory({owner,group,channel:'comment',role:'user',key:commentKey(group,id),createdAt,content:`[主人评论 type=${type} oid=${oid} root=${root} rpid=${id}]\n${content}`},options)
}

export function recordCommentReply({owner,type,oid,root,parent,id,content,createdAt}, options = {}) {
  const home=options.home || DSH_HOME, settings=options.settings === undefined ? openVikingSettings(process.env,path.join(home,'whale-openviking.json')) : options.settings
  if (!settings || !owner || !type || !oid || !root || !parent || !id) return false
  const group=commentGroup(owner,type,oid,root), scope=identity(settings)
  const parentId=hash(JSON.stringify([scope,String(owner),'user',commentKey(group,parent)]))
  if (!fs.existsSync(path.join(dirFor(home,'comment'),'event-'+parentId+'.json'))) return false
  return recordDmMemory({owner,group,channel:'comment',role:'assistant',key:commentKey(group,id),createdAt,content:`[大肥鱼回复 type=${type} oid=${oid} root=${root} rpid=${id} parent=${parent}]\n${content}`},{...options,home,settings})
}

// One durable file per event avoids competing writes between the listener and sender.
export function recordDmMemory({ owner, role, content, createdAt, key, group, channel = 'dm' }, { home = DSH_HOME, settings = openVikingSettings(process.env, path.join(home, 'whale-openviking.json')), now = Date.now } = {}) {
  if (!settings || !owner || !['user', 'assistant'].includes(role) || !String(content || '').trim()) return false
  const timestamp = new Date(createdAt).toISOString()
  const scope = identity(settings), dir = dirFor(home, channel)
  fs.mkdirSync(dir, { recursive: true })
  const id = hash(JSON.stringify([scope, String(owner), role, String(key)]))
  const file = path.join(dir, 'event-' + id + '.json')
  const event = { scope, owner: String(owner), ...(group ? {group} : {}), role, content: String(content), createdAt: timestamp, receivedAt: now(), status: 'queued' }
  try { fs.writeFileSync(file, JSON.stringify(event), { flag: 'wx', mode: 0o600 }); return true }
  catch (e) { if (e.code === 'EEXIST') return false; throw e }
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
      state.dirty = false; persist() // Do not retry a possibly completed extraction until another message arrives.
      try { await api.extractSession(state.id) } catch (e) { log(`${channel} 记忆提取失败，等待新消息后再提取：` + e.message) }
    }
    for (const event of events) {
      const content = `[消息时间 ${event.createdAt}]\n${event.content}`
      if (content.length > LIMIT) { log(`${channel} 记忆内容过长，保留本地记录并跳过：` + event.file); continue }
      const group = event.group || event.owner
      let state = states[group]
      if (state && (now() - state.startedAt >= 7 * DAY || state.length + content.length > LIMIT)) {
        if (state.dirty) await extract(state)
        state = null
      }
      if (!state) state = states[group] = { id: `whale-${channel}-` + crypto.randomUUID(), startedAt: now(), length: 0, dirty: false }
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
