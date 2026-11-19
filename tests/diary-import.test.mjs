import test from 'node:test'
import assert from 'node:assert/strict'
import {parseDiaryMarkdown} from '../lib/diary-import.js'

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
