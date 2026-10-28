import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME } from '../tools/lib/paths.mjs'
import { protectCredentials } from './credentials.js'

export const openVikingFile = path.join(DSH_HOME, 'whale-openviking.json')

function validate(input) {
  const url = new URL(input.url || 'http://127.0.0.1:1933')
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('OpenViking URL 必须使用 HTTP 或 HTTPS')
  if (url.username || url.password || url.search || url.hash) throw Error('OpenViking URL 不能包含凭据、查询参数或片段')
  const account = String(input.account || '').trim(), user = String(input.user || '').trim()
  const key = String(input.key || '').trim()
  if ([account, user, key].some(v => v.length > 4096 || /[^\x21-\x7e]/.test(v))) throw Error('账号、用户和密钥必须是有效的 HTTP 标头值')
  return { enabled: input.enabled !== false, url: url.href.replace(/\/$/, ''), account, user, key }
}

export function readOpenVikingFile(file = openVikingFile) {
  try { return validate(JSON.parse(fs.readFileSync(file, 'utf8'))) }
  catch (e) { if (e.code === 'ENOENT') return null; throw Error('OpenViking 配置无法读取或格式无效') }
}

export function saveOpenVikingFile(input, file = openVikingFile, protect = protectCredentials) {
  const current = readOpenVikingFile(file)
  const value = validate({ ...input, key: input.clearKey ? '' : (input.key || current?.key || '') })
  if (value.enabled && !value.key) throw Error('启用 OpenViking 时请填写用户 API Key')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('配置文件不能是符号链接')
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    const fd = fs.openSync(temp, 'wx', 0o600)
    try { protect(temp); fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, file)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  return { enabled: value.enabled, url: value.url, account: value.account, user: value.user, hasKey: !!value.key }
}

export function openVikingSettings(env = process.env, file = openVikingFile) {
  const saved = readOpenVikingFile(file)
  if (saved) return saved.enabled && saved.key ? saved : null
  const key = env.WHALE_OPENVIKING_API_KEY?.trim()
  if (!key) return null
  return validate({ url: env.WHALE_OPENVIKING_URL, key })
}

export function createOpenViking(settings, fetchImpl = fetch) {
  async function call(route, body, method = 'POST') {
    const response = await fetchImpl(settings.url + route, {
      method, headers: { 'X-API-Key': settings.key, 'Content-Type': 'application/json', ...(settings.account ? {'X-OpenViking-Account': settings.account} : {}), ...(settings.user ? {'X-OpenViking-User': settings.user} : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw Error(`OpenViking HTTP ${response.status}`)
    const data = await response.json()
    if (data.status !== 'ok') throw Error('OpenViking 请求失败')
    return data.result
  }
  return {
    async recall(query) {
      const result = await call('/api/v1/search/find', { query: query.slice(0, 2000), target_uri: 'viking://~/memories', limit: 5 })
      if (!result || !Array.isArray(result.memories)) throw Error('OpenViking 检索结果格式无效')
      return result.memories.map(x => ({ uri: String(x.uri || ''), abstract: String(x.abstract || ''), score: x.score })).filter(x => x.abstract).slice(0, 5)
    },
    async store(text) {
      if (!text.trim() || text.length > 12000) throw Error('记忆内容须为 1 至 12000 字符')
      const id = `whale-${crypto.randomUUID()}`
      await call(`/api/v1/sessions/${id}/messages`, { role: 'assistant', content: text })
      const result = await call(`/api/v1/sessions/${id}/commit`)
      return { sessionId: id, taskId: result?.task_id ?? null }
    },
    async task(id) { return call(`/api/v1/tasks/${encodeURIComponent(id)}`, undefined, 'GET') },
  }
}
