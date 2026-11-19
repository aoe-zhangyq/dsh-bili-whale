import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// One queue owns session selection and persona acknowledgement for all channels.
export function createSessionDelivery({controller,dshHome,cwd,sessionId,config,persona,isBusy=()=>false,now=Date.now,log=()=>{},onSession=()=>{}}) {
  const options={controller,dshHome,cwd,sessionId,config,persona,isBusy,now,log,onSession}
  const privateDelivery=createDelivery(options)
  let publicDelivery,tail=Promise.resolve()
  const enqueue=fn=>{const job=tail.then(fn);tail=job.catch(()=>{});return job}
  return {
    send(request,signal,settings={}) {return enqueue(()=>{
      if(!['private','public'].includes(settings.audience ?? 'private'))throw Error('无效的投递场景')
      if(settings.audience==='public') {
        publicDelivery ||= createDelivery({...options,sessionId:'bili-whale-public',stateFile:'whale-public-session.json',onSession:()=>{}})
        return publicDelivery.send(request,signal,settings)
      }
      return privateDelivery.send(request,signal,settings)
    })},
    confirm(id){return enqueue(()=>privateDelivery.confirm(id))},
  }
}

function createDelivery({controller,dshHome,cwd,sessionId,config,persona,isBusy,now,log,onSession,stateFile='whale-session.json'}) {
  const file=path.join(dshHome,stateFile)
  let state={id:sessionId,startedAt:now()},ready=false,tail=Promise.resolve(),lastDelivered=0
  // 2026-10-24：进程启动后有没有投递过 —— 用来做「重启后首次必注入人设」
  //   因为 DSH 的 create() 返回 { sessionId, agentPreset? }，分不出"新建"还是"复用" ✗
  let booted=false
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'))
    if(typeof saved.id!=='string'||!saved.id||!Number.isFinite(saved.startedAt)||saved.startedAt<0)throw Error('invalid state')
    state=saved
  } catch(e) { if(e.code!=='ENOENT')throw Error('会话状态损坏，请检查 whale-session.json，避免误建会话') }
  onSession(state.id)
  lastDelivered=Number.isFinite(state.deliveredAt)?state.deliveredAt:0
  function save(next) {
    fs.mkdirSync(dshHome,{recursive:true})
    const tmp=file+'.'+crypto.randomUUID()+'.tmp'
    try {fs.writeFileSync(tmp,JSON.stringify(next));fs.renameSync(tmp,file)} finally {fs.rmSync(tmp,{force:true})}
  }
  return {
    send(request,signal,{retainUntilAck=false,audience='private'}={}) {
      const job=tail.then(async()=>{
        signal?.throwIfAborted()
        const cfg=config(),days=Number(cfg.sessionRotateDays??0),once=cfg.personaOncePerSession===true
        const rotating=!state.pendingRequest&&Number.isFinite(days)&&days>0&&now()-state.startedAt>=days*86400000&&now()-lastDelivered>=8*60000&&!(await isBusy(state.id))
        signal?.throwIfAborted()
        let next=rotating?{id:crypto.randomUUID(),startedAt:now(),rotatedFrom:state.id}:state
        if(retainUntilAck){
          if(!request.requestId)throw Error('可靠交付需要 requestId')
          next={...next,pendingRequest:request.requestId}
        }
        if (rotating || (!ready && !next.hostCreated && !next.deliveredAt)) {
          const created = await controller.create({sessionId:next.id,cwd})
          next={...next,id:created?.sessionId ?? next.id,hostCreated:true}
        }
        // 2026-10-24 修第二版（审查报告第 3 条 + 复审）：
        //   上一版想靠 create() 的返回字段判断"是不是新建会话" ✗
        //   但 DSH 的 sessionController.create 返回的是 { sessionId, agentPreset? }
        //   —— 根本没有 created / fresh 这种布尔 ✗ 那段判断永远为假 ✗
        //   （而且注释写着"拿不到信号就往多注入那边靠"，代码却继续跳过 ✗ 自相矛盾）
        //
        // 现在的做法：接口分不出来就不分 ✗
        //   每次【进程启动后的第一次投递】都重新注入完整人设 + 日记恢复指引 ✓
        //   之后同一会话内按 personaIHash 去重 ✓
        //   代价：每次重启多重注入一次人设（~1000 字）✓ 换来"她不会重启后失忆"✓
        //   只开 personaIze 开关时才这样；关着的时候每条都注入，和以前一样 ✓
        const bootFirst = !booted
        save(next)
        if(rotating)log(`会话轮换：${state.id} → ${next.id}；旧会话保留`)
        state=next;ready=true;onSession(state.id)
        signal?.throwIfAborted()
        const block=persona(),fingerprint=crypto.createHash('sha256').update(block).digest('hex')
        const include=!once||bootFirst||state.personaHash!==fingerprint
        const reminder=`人设依据：${path.join(process.env.USERPROFILE||process.env.HOME||'.','.bili-ai/persona.md')}；上下文缺失时重读。`
        const diary=audience==='public'?'公开互动只依据已核实的公开材料。不要读取或引用私信、私人日记或混合来源的人物档案。':
          (!state.deliveredAt||bootFirst)?`先读本地日记恢复记忆：${path.join(dshHome,'whale-diary.md')} 和 ${path.join(dshHome,'whale-diary-private.md')}；不要将旧会话未确认事项当成已完成。`:''
        const prefix=[include?block:reminder,diary].filter(Boolean).join('\n')
        const content=[...(request.content??[])]
        if(content[0]?.type==='text')content[0]={...content[0],text:prefix+'\n'+content[0].text}
        else content.unshift({type:'text',text:prefix})
        try {
          await controller.prompt({
            ...request,requestId:request.requestId ?? crypto.randomUUID(),
            mode:request.mode ?? 'queue',sessionId:state.id,content,
          },signal ?? new AbortController().signal)
        }
        catch(e) {ready=false;throw e}
        booted=true   // 投递成功了才算
        lastDelivered=now()
        state={...state,personaHash:fingerprint,deliveredAt:lastDelivered}
        // Delivery succeeded: persistence failure must not make callers retry it.
        try {save(state)} catch(e){log('会话已投递，但保存人设标记失败：'+e.message)}
      })
      tail=job.catch(()=>{})
      return job
    },
    confirm(requestId) {
      const job=tail.then(()=>{
        if(state.pendingRequest!==requestId)return
        const next={...state};delete next.pendingRequest
        save(next);state=next
      })
      tail=job.catch(()=>{});return job
    },
  }
}
