import fs from 'node:fs'
import { createOpenViking, openVikingSettings } from '../../lib/openviking.js'
import { recordExperience } from '../../lib/dm-memory.js'
import {readPublicMemory,recallPublicMemory} from '../../lib/public-memory.js'
import {config} from '../lib/config.mjs'

try {
  const settings = openVikingSettings()
  if (!settings) throw Error('请先设置 WHALE_OPENVIKING_API_KEY')
  const client = createOpenViking(settings)
  const [command, ...rawArgs] = process.argv.slice(2)
  const args=[],flags={audience:'private'}
  for(let i=0;i<rawArgs.length;i++) {
    if(['--mid','--audience'].includes(rawArgs[i])) {
      const key=rawArgs[i].slice(2)
      if(!rawArgs[i+1] || rawArgs[i+1].startsWith('--'))throw Error(`${rawArgs[i]} 缺少参数`)
      flags[key]=rawArgs[++i]
    } else if(rawArgs[i].startsWith('--'))throw Error('未知参数：'+rawArgs[i])
    else args.push(rawArgs[i])
  }
  if(!['private','public'].includes(flags.audience))throw Error('audience 须为 private 或 public')
  if(command!=='recall' && flags.mid!==undefined)throw Error('--mid 仅用于 recall')
  if(!['recall','read'].includes(command) && flags.audience!=='private')throw Error('--audience 仅用于 recall/read')
  if (command === 'recall' && args.length) {
    const result=flags.audience==='public'?recallPublicMemory(args.join(' '),{settings,...flags}):await client.recall(args.join(' '),flags)
    console.log(JSON.stringify(result, null, 2))
  } else if(command==='read' && args.length===1) {
    const result=flags.audience==='public'?readPublicMemory(args[0],{settings}):await client.readMemory(args[0])
    console.log(JSON.stringify(result,null,2))
  } else if (command === 'experience' && args.length === 1) {
    const text = fs.readFileSync(args[0], 'utf8').replace(/^\uFEFF/, '').trim()
    const input=/\.json$/i.test(args[0])?JSON.parse(text):text
    const queued=recordExperience(input,{settings,ownerMid:config().owner?.mid})
    console.log(queued?'经历已保存在本地。':'该 event_id 已记录。')
  } else if (command === 'task' && args.length === 1) {
    console.log(JSON.stringify(await client.task(args[0]), null, 2))
  } else throw Error('用法：memory recall <查询> [--mid MID] [--audience private|public] | read <URI> [--audience private|public] | experience <UTF-8 文本或 JSON 文件> | task <任务 ID>')
} catch (e) {
  console.error('记忆操作失败：' + e.message)
  process.exitCode = 1
}
