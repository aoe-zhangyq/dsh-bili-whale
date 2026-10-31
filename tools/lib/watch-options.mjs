export function watchOptions(args,defaultDir) {
  const positional=[];let tile=720,page=1
  for(let i=0;i<args.length;i++) {
    const arg=args[i]
    if(arg==='--tile'||arg.startsWith('--tile=')) {
      const value=arg==='--tile'?args[++i]:arg.slice(7)
      tile=Number(value)
      if(!Number.isInteger(tile)||tile<240||tile>1280)throw Error('--tile 必须是 240–1280 的整数')
    } else if(arg==='--page'||arg.startsWith('--page=')) {
      page=pageNumber(arg==='--page'?args[++i]:arg.slice(7))
    } else if(!arg.startsWith('--'))positional.push(arg)
    else if(arg!=='--uniform')throw Error('未知抽帧选项：'+arg)
  }
  return {bvid:positional[0],grid:(positional[1]??'3x3').toLowerCase(),outDir:positional[2]??defaultDir,tile,page}
}

export function pageNumber(value) {
  const page=Number(value)
  if(typeof value==='boolean'||!Number.isSafeInteger(page)||page<1)throw Error('--page 必须是正整数')
  return page
}

export function videoPage(data, value=1) {
  const page=pageNumber(value)
  const pages=Array.isArray(data.pages)&&data.pages.length ? data.pages : [{cid:data.cid,duration:data.duration}]
  const selected=pages[page-1]
  if(!selected)throw Error(`--page ${page} 超出范围：共 ${pages.length} P`)
  if(!selected.cid||!Number.isFinite(Number(selected.duration))||Number(selected.duration)<=0)throw Error(`P${page} 缺少有效的 cid 或时长`)
  return {cid:selected.cid,duration:Number(selected.duration),page,total:pages.length}
}
