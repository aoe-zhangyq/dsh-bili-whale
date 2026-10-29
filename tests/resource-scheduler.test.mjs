import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

test('scheduler checks snapshots hourly, prevents overlap and stops its child',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-snapshot-scheduler-'))
  const original={execFile:cp.execFile,setInterval:globalThis.setInterval,setTimeout:globalThis.setTimeout,clearInterval:globalThis.clearInterval,clearTimeout:globalThis.clearTimeout,now:Date.now}
  const env={...process.env},timers=[],calls=[],logs=[];let now=Date.now(),callback,killed=false
  try {
    process.env.DSH_HOME=home;process.env.DSH_NODE=process.execPath;process.env.USERPROFILE=home;process.env.HOME=home
    fs.writeFileSync(path.join(home,'whale-openviking.json'),JSON.stringify({enabled:true,url:'http://localhost:1933',account:'tester',user:'cs_1',key:'test'}))
    globalThis.setInterval=globalThis.setTimeout=fn=>{const t={fn};timers.push(t);return t}
    globalThis.clearInterval=globalThis.clearTimeout=t=>{t.cleared=true}
    Date.now=()=>now
    cp.execFile=(_exe,args,_options,cb)=>{calls.push(args);callback=cb;return {kill(){killed=true}}}
    syncBuiltinESMExports()
    const {startScheduler}=await import('../lib/scheduler.js')
    const scheduler=startScheduler({sessionController:{}},{dshHome:home,cwd:home,biliMjs:path.join(home,'tools','bili.mjs'),log:s=>logs.push(s)})
    scheduler.resourceTick();scheduler.resourceTick()
    assert.equal(calls.length,1);assert.equal(path.basename(calls[0][0]),'resource.mjs');assert.equal(calls[0][1],'refresh')
    callback(null,JSON.stringify({status:'rebuilt'}),'')
    scheduler.resourceTick();assert.equal(calls.length,1)
    now+=60*60_000;scheduler.resourceTick();assert.equal(calls.length,2)
    scheduler.stop();assert.equal(killed,true);assert.ok(timers.every(t=>t.cleared))
  } finally {
    cp.execFile=original.execFile;syncBuiltinESMExports();globalThis.setInterval=original.setInterval;globalThis.setTimeout=original.setTimeout;globalThis.clearInterval=original.clearInterval;globalThis.clearTimeout=original.clearTimeout;Date.now=original.now
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key]
    Object.assign(process.env,env);fs.rmSync(home,{recursive:true,force:true})
  }
})
