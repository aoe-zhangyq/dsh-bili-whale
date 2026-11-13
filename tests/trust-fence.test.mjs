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

test('diary sync requires authorization and reports background reconciliation', async t => {
  const route = 'openviking/diary-sync', host = '127.0.0.1'
  assert.equal((await request(mount({requestRejection:()=>401}),route,{host,method:'POST'})).status,401)
  const routes = mount({requestRejection:()=>undefined})
  const file = path.join(dshHome,'whale-openviking.json')
  fs.writeFileSync(file,JSON.stringify({url:'http://127.0.0.1:1933',account:'test',user:'whale',key:'test'}))
  t.after(()=>fs.rmSync(file,{force:true}))
  const {archiveDiary} = await import('../lib/diary-memory.js')
  archiveDiary({book:'private',at:'2099-01-01T00:00:00+08:00',content:'fixture'},{home:dshHome})
  let finish, reads=0, writes=0
  const pending = new Promise(resolve=>{finish=resolve})
  t.mock.method(globalThis,'fetch',async url=>{
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
  assert.fail('日记补传未完成')
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
