import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {archiveDiary} from '../lib/diary-memory.js'

test('legacy diary archive remains local and idempotent',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-diary-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const input={book:'private',at:'2026-11-14T04:59:59+08:00',content:'本次日记'}
  const first=archiveDiary(input,{home})
  assert.deepEqual(archiveDiary(input,{home}),first)
  const dir=path.join(home,'whale-diary-entries')
  assert.deepEqual(fs.readdirSync(dir),[`${first.id}.json`])
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,`${first.id}.json`),'utf8')).content,input.content)
})
