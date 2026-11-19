import fs from 'node:fs'
globalThis.fetch=async url=>{
  const u=new URL(url)
  const data=JSON.parse(fs.readFileSync(process.env.TEST_HISTORY,'utf8'))
  if(process.env.TEST_REQUESTS)fs.appendFileSync(process.env.TEST_REQUESTS,u.pathname+u.search+'\n')
  let body
  if(u.pathname.endsWith('/nav'))body={code:0,data:{mid:111,wbi_img:{img_url:'https://i.example/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png'}}}
  else if(u.pathname.endsWith('/fetch_session_msgs')){
    if(!u.searchParams.has('w_rid')||u.searchParams.get('talker_id')!=='222')throw Error('invalid history request')
    const before=u.searchParams.get('end_seqno')??'0', after=u.searchParams.get('begin_seqno')
    body=data.pages?data.pages[before]:data
    if(!body)throw Error('unexpected history cursor '+before)
    if(after && after!=='0') {
      body={...body,data:{...body.data,messages:body.data.messages.filter(row=>BigInt(row.msg_seqno)>BigInt(after))}}
    }
  }else throw Error('unexpected network '+url)
  return new Response(JSON.stringify(body),{status:200})
}
