import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {parseDiaryMarkdown} from '../lib/diary-import.js'
import {syncDiaryMemory} from '../lib/diary-memory.js'

test('dated headings retain subheadings and ignore headings inside code fences',()=>{
  const parsed=parseDiaryMarkdown('# 日记\n## 2026-11-01 · 凌晨 04:59\n甲\n## 今夜看过的\n乙\n```md\n## 2025-01-01 · 上午 09:00\n```\n## 2026-11-01 · 上午 05:00\n丙','public')
  assert.equal(parsed.entries.length,2);assert.deepEqual(parsed.warnings,[])
  assert.match(parsed.entries[0].content,/今夜看过的/)
  assert.equal(parsed.entries[1].at,'2026-11-01T05:00:00+08:00')
})
test('invalid dates and missing times are reported without joining adjacent entries',()=>{
  const parsed=parseDiaryMarkdown('## 2026-02-30 · 上午 09:00\ninvalid\n## 2026-11-01\nunknown\n## 2026-11-02 · 下午 2:30\nvalid','private')
  assert.equal(parsed.warnings.length,2);assert.equal(parsed.entries.length,1)
  assert.equal(parsed.entries[0].at,'2026-11-02T14:30:00+08:00')
  assert.doesNotMatch(parsed.entries[0].content,/invalid|unknown/)
})
test('manual compensation imports markdown, respects monthly cutoff and resumes new entries',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-import-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const file=path.join(home,'whale-diary.md')
  const original='# 日记\n## 2026-11-01 · 凌晨 04:59\n旧月\n## 2026-11-01 · 上午 05:00\n新月'
  fs.writeFileSync(file,original)
  const remote=new Map(),extracted=[]
  const settings={url:'http://localhost:1933',account:'test',user:'whale',key:'test'}
  const client={sessionMessages:async id=>remote.get(id)||[],appendMessage:async(id,m)=>remote.set(id,[...(remote.get(id)||[]),m.content]),extractSession:async id=>extracted.push(id)}
  const options={home,settings,client,now:()=>Date.parse('2026-11-11T10:00:00+08:00')}
  assert.equal((await syncDiaryMemory(options)).sessions,0)
  const first=await syncDiaryMemory({...options,manual:true})
  assert.equal(first.imported,2);assert.equal(first.uploaded,2);assert.equal(remote.size,2)
  assert.ok(extracted[0].startsWith('20261001-'))
  assert.equal((await syncDiaryMemory({...options,manual:true})).uploaded,0)
  fs.appendFileSync(file,'\n## 2026-11-02 · 上午 09:00\n新增')
  assert.equal((await syncDiaryMemory({...options,manual:true})).uploaded,1)
  assert.equal(fs.readFileSync(file,'utf8'),original+'\n## 2026-11-02 · 上午 09:00\n新增')
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'whale-diary-entries','legacy-import.json'))).parsed,3)
})
