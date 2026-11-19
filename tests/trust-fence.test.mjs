import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

globalThis.setInterval = () => ({})
globalThis.setTimeout = () => ({})
globalThis.clearInterval = () => {}
globalThis.clearTimeout = () => {}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-trust-'))
const dshHome = path.join(home, '.dsh')
fs.mkdirSync(dshHome, { recursive: true })
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = dshHome
process.env.DSH_NODE = process.execPath
process.env.BILI_WHALE_CONFIG = path.join(dshHome, 'bili-whale.config.json')

const { default: plugin } = await import('../lib/index.js')

function mount(connection) {
  const routes = new Map()
  const ctx = {
    get: (name) => (name === 'connection' ? connection : undefined),
    webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {} } },
    effect: () => {},
  }
  plugin.apply(ctx)
  return routes
}

function request(routes, name, { host, method = 'GET', body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = method
    req.headers = { host }
    const res = {
      statusCode: 200,
      writeHead(code) { this.statusCode = code },
      end(text) { resolve({ status: this.statusCode, data: text ? JSON.parse(text) : null }) },
    }
    routes.get('/dsh-bili/api/' + name)(req, res).catch(reject)
  })
}

test.after(() => fs.rmSync(home, { recursive: true, force: true }))

test('loopback is trusted without consulting the connection service', async () => {
  const routes = mount({ isTrusted: () => false, requestRejection: () => undefined })
  assert.equal((await request(routes, 'settings', { host: '127.0.0.1:3080' })).status, 200)
})

test('LAN bind address accepted when DSH trust fence accepts it', async () => {
  const seen = []
  const routes = mount({
    isTrusted: (req) => (seen.push(req.headers.host), req.headers.host === '192.168.0.101:3080'),
    requestRejection: () => undefined,
  })
  const r = await request(routes, 'settings', { host: '192.168.0.101:3080' })
  assert.equal(r.status, 200)
  assert.deepEqual(seen, ['192.168.0.101:3080'])
})

test('untrusted host is rejected with 403', async () => {
  const routes = mount({ isTrusted: () => false, requestRejection: () => undefined })
  const r = await request(routes, 'settings', { host: 'evil.example:3080' })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /不受信任/)
})

test('trusted host still requires authentication', async () => {
  const routes = mount({ isTrusted: () => true, requestRejection: () => 401 })
  assert.equal((await request(routes, 'settings', { host: '192.168.0.101:3080' })).status, 401)
})

test('connection service missing stays fail-closed', async () => {
  const routes = mount(undefined)
  assert.equal((await request(routes, 'settings', { host: '192.168.0.101:3080' })).status, 403)
  assert.equal((await request(routes, 'settings', { host: '127.0.0.1:3080' })).status, 503)
})

test('write routes apply the same trust rule', async () => {
  const trusted = mount({ isTrusted: (req) => req.headers.host === '192.168.0.101:3080', requestRejection: () => undefined })
  assert.equal((await request(trusted, 'settings', { host: '192.168.0.101:3080', method: 'POST', body: { sessionRotateDays: 3 } })).status, 200)

  const untrusted = mount({ isTrusted: () => false, requestRejection: () => undefined })
  assert.equal((await request(untrusted, 'settings', { host: 'evil.example:3080', method: 'POST', body: { sessionRotateDays: 3 } })).status, 403)
})

test('OpenViking settings reject untrusted or unauthenticated requests', async () => {
  const body={enabled:true,url:'http://127.0.0.1:1933',account:'tester',user:'cs_1',key:'test-key'}
  assert.equal((await request(mount({isTrusted:()=>false,requestRejection:()=>undefined}),'openviking',{host:'evil.example',method:'POST',body})).status,403)
  assert.equal((await request(mount({isTrusted:()=>true,requestRejection:()=>401}),'openviking',{host:'127.0.0.1',method:'POST',body})).status,401)
  assert.equal((await request(mount(undefined),'openviking',{host:'127.0.0.1',method:'POST',body})).status,503)
})

test('private message sync requires authorization and reports background reconciliation', async t => {
  const route = 'openviking/dm-sync', host = '127.0.0.1'
  assert.equal((await request(mount({requestRejection:()=>401}),route,{host,method:'POST'})).status,401)
  const routes = mount({requestRejection:()=>undefined})
  const file = path.join(dshHome,'whale-openviking.json')
  fs.writeFileSync(file,JSON.stringify({url:'http://127.0.0.1:1933',account:'test',user:'whale',key:'test'}))
  t.after(()=>fs.rmSync(file,{force:true}))
  const {recordDmHistory} = await import('../lib/dm-history-sync.js')
  await recordDmHistory('123',[{sender:'123',ts:1700000000,key:'route-fixture',type:1,text:'fixture'}],{home:dshHome})
  let finish, reads=0, writes=0
  const pending = new Promise(resolve=>{finish=resolve})
  t.mock.method(globalThis,'fetch',async url=>{
    assert.match(url,/\/sessions\/whale-dm-123-/)
    if (url.includes('/context?')) {reads++;await pending}
    if (url.endsWith('/messages')) writes++
    return {ok:true,json:async()=>({status:'ok',result:{messages:[],commit_count:0}})}
  })
  try {
    const first = await request(routes,route,{host,method:'POST'})
    assert.equal(first.status,202)
    assert.equal(first.data.status.phase,'running')
    const second = await request(routes,route,{host,method:'POST'})
    assert.equal(second.data.status.phase,'running')
  } finally { finish() }
  for (let attempt=0;attempt<100;attempt++) {
    const {data} = await request(routes,route,{host})
    if (data.status.phase !== 'running') {
      assert.equal(data.status.phase,'done')
      assert.equal(data.status.uploaded,1)
      assert.deepEqual([reads,writes],[1,1])
      return
    }
    await new Promise(resolve=>setImmediate(resolve))
  }
  assert.fail('私信同步未完成')
})

test('dated DM sync pages toward older messages past a 30-message page and resumes after interruption',async t=>{
  const route='openviking/dm-sync',host='127.0.0.1',routes=mount({requestRejection:()=>undefined})
  const settings=path.join(dshHome,'whale-openviking.json')
  const config=process.env.BILI_WHALE_CONFIG
  const credentials=path.join(home,'.bili-ai','credentials.json')
  const cache=path.join(dshHome,'whale-dm-history')
  fs.mkdirSync(path.dirname(credentials),{recursive:true})
  fs.writeFileSync(credentials,JSON.stringify({sessdata:'test'}))
  fs.writeFileSync(settings,JSON.stringify({url:'http://127.0.0.1:1933',account:'dated',user:'whale',key:'test'}))
  const previous=fs.existsSync(config)?fs.readFileSync(config):null
  fs.writeFileSync(config,JSON.stringify({owner:{mid:'456',name:'联系人'}}))
  t.after(()=>{
    if(previous)fs.writeFileSync(config,previous);else fs.rmSync(config,{force:true})
    fs.rmSync(settings,{force:true});fs.rmSync(credentials,{force:true})
  })
  const {recordDmHistory}=await import('../lib/dm-history-sync.js')
  await recordDmHistory('789',[{sender:'789',ts:1700000000,key:'older-cached',type:1,text:'fixture'}],{home:dshHome})
  const trafficTest=process.env.BILI_TRAFFIC_TEST
  process.env.BILI_TRAFFIC_TEST='1'
  t.after(()=>{if(trafficTest===undefined)delete process.env.BILI_TRAFFIC_TEST;else process.env.BILI_TRAFFIC_TEST=trafficTest})
  const since=Date.parse('2025-10-01T00:00:00+08:00')/1000
  const cursors=[],remote=new Map(),peers=new Set()
  let interrupt=true
  t.mock.method(globalThis,'fetch',async (input,options)=>{
    const url=new URL(input)
    const reply=result=>new Response(JSON.stringify({status:'ok',result}))
    if (url.pathname.endsWith('/nav')) return new Response(JSON.stringify({code:0,data:{mid:111,wbi_img:{img_url:'https://i.example/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png'}}}))
    if (url.pathname.endsWith('/fetch_session_msgs')) {
      const mid=url.searchParams.get('talker_id'),cursor=Number(url.searchParams.get('end_seqno'))
      const after=Number(url.searchParams.get('begin_seqno'))
      peers.add(mid)
      if (mid==='123'||mid==='789') return new Response(JSON.stringify({code:0,data:{messages:null,has_more:0}}))
      assert.equal(mid,'456')
      cursors.push(cursor)
      if (cursor===4 && interrupt) return new Response(JSON.stringify({code:-1}),{status:503})
      const seq=cursor===0?(interrupt?43:45):cursor-1
      const row=n=>({msg_key:String(n),msg_seqno:n,sender_uid:n===13?111:456,timestamp:n>=14?since+10*86400+n:since+n-1,content:`私信 ${n}`})
      let messages=cursor===0?Array.from({length:30},(_,i)=>row(seq-i)):seq===1?[row(1),row(0)]:[row(seq)]
      if(after) messages=messages.filter(message=>message.msg_seqno>after)
      return new Response(JSON.stringify({code:0,data:{messages,has_more:0}}))
    }
    const id=url.pathname.split('/')[4]
    if (url.pathname.endsWith('/context')) return reply({messages:remote.get(id)||[]})
    if (url.pathname.endsWith('/messages')) {
      remote.set(id,[...(remote.get(id)||[]),JSON.parse(options.body)])
      return reply({})
    }
    return reply({commit_count:0})
  })
  const run=async ()=>{
    const start=await request(routes,route,{host,method:'POST',body:{startDate:'2025-10-01'}})
    assert.equal(start.status,202)
    for(let attempt=0;attempt<300;attempt++) {
      const {data}=await request(routes,route,{host})
      if(data.status.phase!=='running') return data.status
      await new Promise(resolve=>setImmediate(resolve))
    }
    assert.fail('历史私信同步未完成')
  }
  assert.equal((await request(routes,route,{host,method:'POST',body:{startDate:'2025-02-30'}})).status,400)
  assert.equal(cursors.length,0)
  const first=await run()
  assert.equal(first.phase,'partial')
  assert.equal(first.history.failed,1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache,'456.json'))).messages.length,40)
  const before=cursors.length
  interrupt=false
  const second=await run()
  assert.equal(second.phase,'done')
  assert.ok(peers.has('789'))
  assert.equal(second.history.endedEarly,peers.size-1)
  assert.deepEqual(cursors.slice(before),[0,16,15,4,3,2])
  const local=JSON.parse(fs.readFileSync(path.join(cache,'456.json')))
  assert.equal(local.backfill,undefined)
  assert.equal(local.messages.length,45)
  assert.ok(local.messages.some(row=>row.key==='1' && row.at===new Date(since*1000).toISOString()))
  assert.equal(local.messages.find(row=>row.key==='13').role,'assistant')
  assert.equal([...remote].find(([id])=>id.startsWith('whale-dm-456-'))[1].length,45)
  assert.equal(fs.existsSync(path.join(home,'.bili-ai','dm-await-state.json')),false)
})

test('QR routes enforce trust, host authentication and POST before running login', async () => {
  for (const name of ['start', 'poll', 'cancel']) {
    const route = 'auth/qr/' + name
    assert.equal((await request(mount({ isTrusted: () => false, requestRejection: () => undefined }), route,
      { host: 'evil.example', method: 'POST' })).status, 403)
    assert.equal((await request(mount({ isTrusted: () => true, requestRejection: () => 401 }), route,
      { host: '127.0.0.1', method: 'POST' })).status, 401)
    assert.equal((await request(mount(undefined), route,
      { host: '127.0.0.1', method: 'POST' })).status, 503)
    assert.equal((await request(mount({ requestRejection: () => undefined }), route,
      { host: '127.0.0.1' })).status, 405)
  }
  const routes = mount({ isTrusted: () => true, requestRejection: () => undefined })
  assert.equal((await request(routes, 'auth/qr/cancel', { host: '192.168.0.101', method: 'POST' })).status, 200)
  const invalid = await request(routes, 'auth/qr/poll', { host: '192.168.0.101', method: 'POST', body: { id: 'stale' } })
  assert.equal(invalid.status, 400)
  assert.match(invalid.data.error, /失效/)
})
