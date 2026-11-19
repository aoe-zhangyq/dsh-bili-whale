import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {DSH_HOME} from '../tools/lib/paths.mjs'
import {isoTime} from './memory-format.js'

const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const diaryDir = home => path.join(home,'whale-diary-entries')

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
