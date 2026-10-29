import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME } from '../tools/lib/paths.mjs'
import { protectCredentials } from './credentials.js'
import {validMid,normalizeMemorySource,formatMemoryMessage,isoTime} from './memory-format.js'

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
  return validate({ url: env.WHALE_OPENVIKING_URL, account: env.WHALE_OPENVIKING_ACCOUNT, user: env.WHALE_OPENVIKING_USER, key })
}

export function createOpenViking(settings, fetchImpl = fetch) {
  const headers = { 'X-API-Key': settings.key, ...(settings.account ? {'X-OpenViking-Account': settings.account} : {}), ...(settings.user ? {'X-OpenViking-User': settings.user} : {}) }
  async function call(route, body, method = 'POST', timeout = 10000, includeTelemetry = false) {
    const response = await fetchImpl(settings.url + route, {
      method, headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) {
      let detail = ''
      try { const error = (await response.json()).error; if (error?.code === 'INVALID_ARGUMENT' && /resource is busy/i.test(error.message || '')) detail = '（资源仍在处理，请稍后重试）' } catch {}
      const e = Error(`OpenViking HTTP ${response.status}${detail}`); e.status = response.status; throw e
    }
    const data = await response.json()
    if (data.status !== 'ok') {
      const error=Error('OpenViking 请求失败')
      error.code=data.error?.code
      if(error.code==='NOT_FOUND')error.status=404
      throw error
    }
    return includeTelemetry ? {result:data.result,telemetry:data.telemetry??null} : data.result
  }
  const readMemory = async uri => {
    validateMemoryUri(uri)
    const result=await call('/api/v1/content/read?uri='+encodeURIComponent(uri),undefined,'GET',30000)
    if(typeof result!=='string')throw Error('OpenViking 记忆正文格式无效')
    return {uri,content:result}
  }
  let userRoot
  async function memoryRoot() {
    if(!userRoot) {
      const user=settings.user || (await call('/api/v1/system/status',undefined,'GET')).user
      if(typeof user!=='string' || !/^[A-Za-z0-9_-]+$/.test(user)) throw Error('无法确定 OpenViking 用户记忆路径')
      userRoot=`viking://user/${user}/memories`
    }
    return userRoot
  }
  return {
    readMemory,
    async appendMessage(id, message) {
      validateSessionId(id)
      return call(`/api/v1/sessions/${encodeURIComponent(id)}/messages`, message, 'POST', 30000)
    },
    async extractSession(id) {
      validateSessionId(id)
      return call(`/api/v1/sessions/${encodeURIComponent(id)}/extract`, undefined, 'POST', 600000)
    },
    async importSnapshot(root, zip) {
      validateSnapshotRoot(root)
      if (!Buffer.isBuffer(zip) || !zip.length) throw Error('资源快照为空')
      const form=new FormData();form.append('file',new Blob([zip],{type:'application/zip'}),'whale-snapshot.zip')
      const response=await fetchImpl(settings.url+'/api/v1/resources/temp_upload',{method:'POST',headers,body:form,signal:AbortSignal.timeout(30000)})
      if(!response.ok)throw Error(`OpenViking 上传快照失败 HTTP ${response.status}`)
      const upload=await response.json()
      if(upload.status!=='ok'||!upload.result?.temp_file_id)throw Error('OpenViking 快照上传结果无效')
      const responseData=await call('/api/v1/resources',{temp_file_id:upload.result.temp_file_id,to:root,reason:'',preserve_structure:true,wait:true,timeout:600,strict:true,telemetry:true},'POST',610000,true)
      const result=responseData.result
      if(result?.status!=='success'||result.root_uri!==root||result.errors?.length||!result.queue_status||Object.values(result.queue_status).some(x=>x?.error_count))throw Error('OpenViking 快照导入或索引未确认')
      const summary=responseData.telemetry?.summary
      const value=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null
      return { ...result, usage:summary?{durationMs:value(summary.duration_ms),llmInputTokens:value(summary.tokens?.llm?.input),llmOutputTokens:value(summary.tokens?.llm?.output),embeddingTokens:value(summary.tokens?.embedding?.total)}:null }
    },
    async snapshotTree(root) {
      validateSnapshotRoot(root)
      const result=await call('/api/v1/fs/tree?uri='+encodeURIComponent(root)+'&level_limit=12&node_limit=20000',undefined,'GET')
      if(!Array.isArray(result))throw Error('OpenViking 快照目录格式无效')
      return result
    },
    async searchSnapshot(root,query,section='') {
      validateSnapshotRoot(root)
      if(typeof query!=='string'||!query.trim())throw Error('请输入资源查询内容')
      if(!['','diary','videos','manuals'].includes(section))throw Error('无效的资源类别')
      const target_uri=root+(section?'/'+section:'')
      const result=await call('/api/v1/search/find',{query:query.slice(0,2000),target_uri,limit:20})
      if(!result||!Array.isArray(result.resources))throw Error('OpenViking 快照检索结果无效')
      return result.resources.filter(x=>typeof x.uri==='string'&&x.uri.startsWith(target_uri+'/')).map(x=>({uri:x.uri,abstract:String(x.abstract||'').slice(0,1600),score:x.score})).slice(0,20)
    },
    async removeSnapshot(root) {
      validateSnapshotRoot(root)
      try {return await call('/api/v1/fs?uri='+encodeURIComponent(root)+'&recursive=true',undefined,'DELETE',30000)}
      catch(e) {if(e.status===404)return;throw e}
    },
    async cleanupLegacy(entries) {
      // Only fixed paths owned by the older whale integration are considered.
      // A resource whose original is absent locally is never destroyed.
      const names=new Set(entries.map(x=>x.name)),warnings=[]
      for(const [root,required] of [['viking://resources/whale-diary-public','diary/public.md'],['viking://resources/whale-diary-private','diary/private.md'],['viking://resources/whale/videos',null]]) {
        let tree
        try {tree=await call('/api/v1/fs/tree?uri='+encodeURIComponent(root)+'&level_limit=12&node_limit=20000&show_all_hidden=true',undefined,'GET')}
        catch(e) {if(e.status===404)continue;warnings.push('无法检查旧资源 '+root);continue}
        if(!Array.isArray(tree)||tree.length>=20000){warnings.push('旧资源目录不完整 '+root);continue}
        let safe=required?names.has(required):true
        if(required) for(const row of tree) {
          const rel=typeof row.uri==='string'&&row.uri.startsWith(root+'/')?row.uri.slice(root.length+1):''
          const expected=required.endsWith('public.md')?'public.md':'private.md'
          if(row.isDir||![expected,'.abstract.md','.overview.md','.relations.json'].includes(rel)){safe=false;break}
        }
        if(!required) for(const row of tree) {
          const rel=typeof row.uri==='string'&&row.uri.startsWith(root+'/')?row.uri.slice(root.length+1):''
          if(['.abstract.md','.overview.md','.relations.json'].includes(rel))continue
          const match=rel.match(/^(BV[0-9A-Za-z]{10})(?:\/|$)/)
          const leaf=rel.split('/').at(-1)
          if(!match||!names.has('videos/'+match[1]+'.md')||(leaf.startsWith('.')&&!['.abstract.md','.overview.md','.relations.json'].includes(leaf))||(!row.isDir&&!leaf.endsWith('.md')&&leaf!=='.relations.json')) {safe=false;break}
        }
        if(!safe){warnings.push('旧资源含有本地缺失的原件，已保留 '+root);continue}
        try {await call('/api/v1/fs?uri='+encodeURIComponent(root)+'&recursive=true',undefined,'DELETE',30000)}
        catch {warnings.push('旧资源未能删除 '+root)}
      }
      return warnings
    },
    async recall(query, {mid,limit=5,audience='private'}={}) {
      if(typeof query!=='string' || !query.trim())throw Error('请输入记忆查询内容')
      if(audience!=='private')throw Error('公开查询必须使用插件本地公开证据接口')
      if(mid!==undefined && !validMid(mid))throw Error('无效的 B站 MID')
      if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('查询数量须为 1 至 20')
      const memories=[]
      const belongs=uri=>mid===undefined || new RegExp(`/entities/[^/]+/bilibili_${mid}\\.md$|/preferences/bilibili_${mid}/[^/]+\\.md$`).test(uri)
      let target_uri
      if(mid!==undefined) {
        const root=await memoryRoot()
        // Read the exact person, including legacy category aliases, before
        // semantic preferences. A MID in query text alone is not a filter.
        for(const category of ['people','person','人物'])try {
          const item=await readMemory(`${root}/entities/${category}/bilibili_${mid}.md`)
          memories.push({...item,abstract:item.content.slice(0,1600),score:1,match:'exact-person'})
          break
        } catch(error) {if(error.status!==404)throw error}
        target_uri=`${root}/preferences/bilibili_${mid}`
      }
      // Search the authenticated user's available memory spaces. Some server
      // versions treat viking://~/memories as a literal, nonexistent path.
      let result
      try {result = await call('/api/v1/search/find', { query: (mid?`bilibili_${mid} ${query}`:query).slice(0, 2000), ...(target_uri?{target_uri}:{}), limit, include_provenance:true })}
      catch(error){if(error.status!==404)throw error;result={memories:[]}}
      if (!result || !Array.isArray(result.memories)) throw Error('OpenViking 检索结果格式无效')
      for(const item of result.memories) {
        const uri=String(item.uri || '')
        if(!belongs(uri) || (target_uri && !uri.startsWith(target_uri+'/')) || !item.abstract || memories.some(x=>x.uri===uri))continue
        memories.push({uri,abstract:String(item.abstract),score:item.score,...(item.provenance?{provenance:item.provenance}:{}),...(item.updated_at?{updated_at:item.updated_at}:{})})
      }
      return memories.slice(0,limit)
    },
    async store(input, {ownerMid}={}) {
      const messages = typeof input === 'string' ? [{ role: 'assistant', content: input }] : input
      if (!Array.isArray(messages) || !messages.length || messages.length > 100) throw Error('记忆须包含 1 至 100 条消息')
      let length = 0
      const normalized = messages.map(m => {
        if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) throw Error('每条记忆须包含 user 或 assistant 角色和非空内容')
        const created_at=m.created_at===undefined?new Date().toISOString():isoTime(m.created_at)
        const source=normalizeMemorySource(m.source,{ownerMid})
        source.time_basis=m.created_at?'occurrence':'submission'
        if(m.event_id!==undefined && (typeof m.event_id!=='string' || !/^[A-Za-z0-9_-]{1,120}$/.test(m.event_id)))throw Error('无效的 event_id')
        const event_id=m.event_id || crypto.createHash('sha256').update(JSON.stringify([m.role,created_at,source,m.content])).digest('hex')
        const content=formatMemoryMessage({role:m.role,content:m.content,created_at,source,event_id,recorded_at:new Date().toISOString()})
        length += content.length
        return {role:m.role,content,created_at}
      })
      if (length > 12000) throw Error('记忆内容总计不能超过 12000 字符')
      const id = `whale-${crypto.randomUUID()}`
      try {
        for (const message of normalized) await call(`/api/v1/sessions/${id}/messages`, message)
        const result = await call(`/api/v1/sessions/${id}/commit`)
        return { sessionId: id, taskId: result?.task_id ?? null }
      } catch (e) { throw Error(`OpenViking 会话 ${id} 提交未确认：${e.message}；请先检查该会话后再重试`) }
    },
    async task(id) { return call(`/api/v1/tasks/${encodeURIComponent(id)}`, undefined, 'GET') },
  }
}

function validateSessionId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) throw Error('无效的记忆会话 ID（须为 1–200 位字母、数字、下划线或连字符）')
}

function validateMemoryUri(uri) {
  if(typeof uri!=='string' || !/^viking:\/\/(?:user|agent)\/[^?#%\\\s]+\/memories\/[^?#%\\]+\.md$/.test(uri) || uri.split('/').some(part=>part==='.'||part==='..')) throw Error('无效的记忆 URI（仅支持 user/agent 记忆正文）')
}

function validateSnapshotRoot(root) {
  if(typeof root!=='string'||!/^viking:\/\/resources\/whale-snapshot-[a-f0-9]{32}$/.test(root))throw Error('无效的资源快照目录')
}
