import fs from 'node:fs'
import { createOpenViking, openVikingSettings } from '../../lib/openviking.js'

try {
  const settings = openVikingSettings()
  if (!settings) throw Error('请先设置 WHALE_OPENVIKING_API_KEY')
  const client = createOpenViking(settings)
  const [command, ...args] = process.argv.slice(2)
  if (command === 'recall' && args.length) {
    console.log(JSON.stringify(await client.recall(args.join(' ')), null, 2))
  } else if (command === 'store' && args.length === 1) {
    const text = fs.readFileSync(args[0], 'utf8')
    const result = await client.store(text)
    console.log(JSON.stringify({ ...result, message: '已提交；记忆提取在后台进行，请用 memory task 查询结果。' }))
  } else if (command === 'task' && args.length === 1) {
    console.log(JSON.stringify(await client.task(args[0]), null, 2))
  } else throw Error('用法：memory recall <查询> | store <UTF-8 文件路径> | task <任务 ID>')
} catch (e) {
  console.error('记忆操作失败：' + e.message)
  process.exitCode = 1
}
