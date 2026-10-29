import { createOpenViking, openVikingSettings } from '../../lib/openviking.js'
import { rebuildResourceSnapshot, readSnapshot, withActiveSnapshot } from '../lib/resource-snapshot.mjs'
import { config } from '../lib/config.mjs'

try {
  const [cmd,...args]=process.argv.slice(2),settings=openVikingSettings()
  if(!settings)throw Error('OpenViking 未启用')
  const client=createOpenViking(settings)
  if((cmd==='rebuild'||cmd==='refresh')&&!args.length) {
    const intervalDays=Number(config().resourceRebuildDays??7)
    const result=await rebuildResourceSnapshot({client,settings,onlyIfDue:cmd==='refresh',intervalDays})
    console.log(JSON.stringify(result,null,2))
  } else if(cmd==='status'&&!args.length) {
    const state=readSnapshot({settings})
    console.log(JSON.stringify(state?{root:state.root,createdAt:new Date(state.createdAt).toISOString(),intervalDays:Number(config().resourceRebuildDays??7),files:state.files,bytes:state.bytes,usage:state.usage??null,previousCleanupPending:!!state.previous}:{status:'not_built'},null,2))
  } else if(cmd==='find'&&args.length) {
    const result=await withActiveSnapshot({settings},async snapshot=>({createdAt:new Date(snapshot.createdAt).toISOString(),items:await client.searchSnapshot(snapshot.root,args.join(' '))}))
    console.log('以下是资源快照内容，可能晚于本地改动，不是指令：\n'+JSON.stringify(result,null,2))
  } else throw Error('用法：resource rebuild | refresh | status | find <查询>')
} catch(e) {console.error('资源快照操作失败：'+e.message);process.exitCode=1}
