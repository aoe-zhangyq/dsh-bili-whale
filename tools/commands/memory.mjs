import fs from 'node:fs'
import crypto from 'node:crypto'
import { createOpenViking, openVikingSettings } from '../../lib/openviking.js'
import { recordDmMemory } from '../../lib/dm-memory.js'

try {
  const settings = openVikingSettings()
  if (!settings) throw Error('请先设置 WHALE_OPENVIKING_API_KEY')
  const client = createOpenViking(settings)
  const [command, ...args] = process.argv.slice(2)
  if (command === 'recall' && args.length) {
    console.log(JSON.stringify(await client.recall(args.join(' ')), null, 2))
  } else if (command === 'store' && args.length === 1) {
    const text = fs.readFileSync(args[0], 'utf8')
    const input = /\.json$/i.test(args[0]) ? JSON.parse(text.replace(/^\uFEFF/, '')) : text
    const result = await client.store(input)
    console.log(JSON.stringify({ ...result, message: '已提交；记忆提取在后台进行，请用 memory task 查询结果。' }))
  } else if (command === 'experience' && args.length === 1) {
    const content = fs.readFileSync(args[0], 'utf8').replace(/^\uFEFF/, '').trim()
    if (!content || content.length > 11000) throw Error('经历须为 1 至 11000 字符的 UTF-8 文本')
    recordDmMemory({owner:'activity',role:'assistant',content,createdAt:Date.now(),key:crypto.randomUUID(),channel:'activity'}, {settings})
    console.log('经历已记录到本地待处理队列；插件运行时会合并提取。')
  } else if (command === 'task' && args.length === 1) {
    console.log(JSON.stringify(await client.task(args[0]), null, 2))
  } else throw Error('用法：memory recall <查询> | store <UTF-8 文件路径> | experience <UTF-8 文本文件> | task <任务 ID>')
} catch (e) {
  console.error('记忆操作失败：' + e.message)
  process.exitCode = 1
}
