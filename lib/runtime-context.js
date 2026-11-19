import path from 'node:path'
import {fileURLToPath} from 'node:url'

const bundledCli=fileURLToPath(new URL('../tools/bili.mjs',import.meta.url))

export function runtimeContext({dshHome,cwd,biliMjs=bundledCli,nodeExe=process.execPath,runtimeEnv={},platform=process.platform}) {
  const quote=value=>platform==='win32'?`'${String(value).replaceAll("'","''")}'`:`'${String(value).replaceAll("'","'\\''")}'`
  const variables={DSH_HOME:dshHome,BILI_WHALE_CONFIG:process.env.BILI_WHALE_CONFIG || path.join(dshHome,'bili-whale.config.json'),
    ...(runtimeEnv.ELECTRON_RUN_AS_NODE==='1'?{ELECTRON_RUN_AS_NODE:'1'}:{})}
  const environment=Object.entries(variables).map(([key,value])=>platform==='win32'?`$env:${key}=${quote(value)};`:`${key}=${quote(value)}`).join(' ')
  const command=`${environment} ${platform==='win32'?'& ':''}${quote(nodeExe)} ${quote(path.resolve(biliMjs))}`
  return `【运行入口】工作目录：${cwd}\n以下 node bili.mjs <参数> 均是简写；实际执行请使用此绝对命令并追加参数，不要假定工作目录里有 bili.mjs：\n${command} <参数>\n命令参数不清楚时先执行 help。`
}
