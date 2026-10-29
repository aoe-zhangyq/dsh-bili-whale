import fs from 'node:fs'
import path from 'node:path'
import {DSH_HOME} from '../tools/lib/paths.mjs'
import {memoryScope,validMid} from './memory-format.js'

function loadEvidence(file, scope) {
  const event=JSON.parse(fs.readFileSync(file,'utf8'))
  if(event.scope!==scope || event.source?.channel!=='comment' || event.source.visibility!=='public' || event.source.verification!=='platform' || typeof event.publicContent!=='string') return null
  return {uri:`whale-public://${scope}/${path.basename(file).slice(6,-5)}`,content:event.publicContent,
    source:event.source,created_at:event.createdAt,role:event.role}
}

export function readPublicMemory(uri,{settings,home=DSH_HOME}={}) {
  const match=String(uri).match(/^whale-public:\/\/([a-f0-9]{64})\/([a-f0-9]{64})$/)
  if(!settings || !match || match[1]!==memoryScope(settings)) throw Error('无效的公开记忆 URI 或租户不匹配')
  const evidence=loadEvidence(path.join(home,'whale-comment-memory',`event-${match[2]}.json`),match[1])
  if(!evidence) throw Error('该记录不属于已核实的公开记忆')
  return evidence
}

export function recallPublicMemory(query,{settings,home=DSH_HOME,mid,limit=5}={}) {
  if(mid!==undefined && !validMid(mid)) throw Error('无效的 B站 MID')
  if(typeof query!=='string' || !query.trim()) throw Error('请输入记忆查询内容')
  if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('查询数量须为 1 至 20')
  if(!settings)return []
  const scope=memoryScope(settings),dir=path.join(home,'whale-comment-memory')
  if(!fs.existsSync(dir))return []
  const words=query.slice(0,2000).toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]/gu) || []
  const terms=[...new Set(words.flatMap((word,i)=>/\p{Script=Han}/u.test(word) && /\p{Script=Han}/u.test(words[i+1] || '') ? [word+words[i+1]] : [word]))]
  return fs.readdirSync(dir).filter(name=>/^event-[a-f0-9]{64}\.json$/.test(name)).map(name=>loadEvidence(path.join(dir,name),scope))
    .filter(item=>item && (mid===undefined || item.source.person?.mid===String(mid)))
    .map(item=>({...item,abstract:item.content.slice(0,1600),score:terms.filter(term=>item.content.toLowerCase().includes(term)).length/Math.max(terms.length,1)}))
    .sort((a,b)=>b.score-a.score || b.created_at.localeCompare(a.created_at)).slice(0,limit)
}
