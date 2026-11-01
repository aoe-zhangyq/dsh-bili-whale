import { videoSegments, downloadVideo, videoCachePath } from '../lib/watch-download.mjs'
import { watchOptions, videoPage } from '../lib/watch-options.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { apiGet } from '../lib/bili-api.mjs'
// 让 agent 真"看"视频：取直链 → 抽帧拼成一张九宫格 → 输出图片路径（再交给 read_image 看）
//
// 用法: node bili-watch.mjs <BV号> [列x行，默认 3x3] [outDir] [--page N] [--uniform] [--local]
//   例: node bili-watch.mjs BV1iLYm6VET3            → 3x3 九宫格
//       node bili-watch.mjs BV1iLYm6VET3 4x4        → 16 格，看得更细
//
// 两种取帧路子（2026-11-01 加第二条）：
//   ① 短视频：下载整片 → ffmpeg 在本地吸附"画面变化点"抽帧（原行为，最准）
//   ② 长视频（≥25 分钟且单段）：**不下载整片**，让 ffmpeg 拿直链 + -ss 定点抓帧。
//      起因：102 分钟的交响音乐会 882.6MB，1.4MB/s 要 700s，撞上写死的 600s 超时 ✗
//      实测定点抓一帧 5.8s，9 帧约 1 分钟 ✓ 代价是做不了"画面变化点吸附"，只能等间隔
//      （长演出/长直播等间隔本来就够用；要强吸附可加 --local 走整片下载）
//
// 依赖：ffmpeg（查找顺序见 lib/ffmpeg.mjs：$FFMPEG → PATH → bin/ → ~/.dsh/bili-whale/bin → 本机剪映）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from '../lib/capture.mjs'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'
import { dshPath } from '../lib/paths.mjs'

const REMOTE_MIN_DURATION = 1500   // 25 分钟以上不再整片下载
let FFMPEG
try { FFMPEG = requireFfmpeg() } catch (e) { console.error(String(e.message)); process.exit(2) }
let parsed
try { parsed = watchOptions(process.argv.slice(2), dshPath('shots','video')) } catch(e) { console.error(e.message); process.exit(2) }
const {bvid,grid,outDir,tile:TILE,page} = parsed
if (!bvid) { console.error('用法: node bili-watch.mjs <BV号> [列x行] [outDir] [--page N] [--uniform] [--local]'); process.exit(2) }
const [cols, rows] = grid.split('x').map(Number)
if (!cols || !rows) { console.error('格子格式应是 3x3 这样'); process.exit(2) }
const N = cols * rows
const FORCE_LOCAL = process.argv.includes('--local')

const cred = JSON.parse(fs.readFileSync(path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }

const view = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, H)
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message}`); process.exit(3) }
let selectedPage
try { selectedPage = videoPage(view.data, parsed.page) }
catch (e) { console.error(e.message); process.exit(2) }
const { cid, duration } = selectedPage
const { title, owner } = { ...view.data, owner: view.data.owner?.name }
console.log(`标题: ${title}`)
if (selectedPage.total > 1) console.log(`多P: 共 ${selectedPage.total} P，本次取 P${selectedPage.page}`)
console.log(`UP: ${owner}   时长: ${duration}s   cid=${cid}`)

// 画质实测（2026-10-14）：html5 + qn=32 会被压到 360p（返回 quality=16，界面小字全糊）；
// 改 platform=pc + qn=80 可拿到 720p（返回 quality=64），依旧是普通 mp4 直链，不必碰 dash。
const p = await apiGet(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`, H)
let segments
try { segments = videoSegments(p.data, duration) }
catch (e) { console.error(`playurl 失败：${e.message}（code=${p.code}）`); process.exit(4) }
console.log(`视频分段: ${segments.length}`)
const QN = { 16: '360P', 32: '480P', 64: '720P', 80: '1080P' }
console.log(`实际画质: ${QN[p.data.quality] ?? p.data.quality}`)

fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const base = path.join(outDir, `${bvid}-p${selectedPage.page}-${stamp}`)
const mp4 = videoCachePath(outDir, { bvid, cid, page: selectedPage.page, quality: p.data.quality, segments })
const sheet = `${base}-${cols}x${rows}.jpg`

const REMOTE = !FORCE_LOCAL && segments.length === 1 && duration >= REMOTE_MIN_DURATION
const timeOf = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const pickEvenly = (list, n) =>
  n <= 1 ? [list[0]] : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))])
const uniform = Array.from({ length: N }, (_, i) => ((i + 0.5) * duration) / N)

let times = uniform
let how = `等间隔（每 ${(duration / N).toFixed(1)} 秒一帧）`
let localMp4 = null

if (REMOTE) {
  how = `HTTP 定点抓帧（${(duration / 60).toFixed(0)} 分钟的长片不下载整片；等间隔每 ${(duration / N).toFixed(1)} 秒一帧）`
  console.log(`\n下载方式: 跳过整片下载（${segments.length} 段 · 直链定点取帧）`)
} else {
  try {
    await downloadVideo({ segments, output: mp4, fetch, ffmpeg: FFMPEG, execFileSync,
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' },
      log: (m) => console.log('  ' + m) })
    localMp4 = mp4
  } catch (e) {
    console.error('下载失败：' + e.message)
    console.error('（单段视频的已下载部分保留为 .part，下次运行会自动续传；也可加 --local 之外的参数重试）')
    process.exit(5)
  }
  console.log(`已下载: ${localMp4}  (${(fs.statSync(localMp4).size / 1024 / 1024).toFixed(2)} MB)`)

  // ── 取帧方式：优先"画面变化点"，不够再退回等间隔（2026-10-14 参考 K3 的做法）
  // 画面变化由 ffmpeg 的 scene 过滤器给出：空跑一次，把 pts_time 抓出来，再从中均匀挑 N 个。
  function sceneTimes(file, th) {
    try {
      const out = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-vf',
        `select='gt(scene,${th})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 600_000 })
      const ts = [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]))
      return [...new Set(ts)].filter((t) => t > 0.2)
    } catch { return [] }
  }

  if (!process.argv.includes('--uniform')) {
    // 阈值阶梯：录屏/讲解类画面变化平缓，0.3 常只检出几处 → 逐级放宽
    let st = [], used = 0.3
    for (const th of [0.3, 0.15, 0.08]) { used = th; st = sceneTimes(localMp4, th); if (st.length >= N) break }

    if (st.length > 0) {
      // 关键设计（2026-10-14 踩过两次才定）：
      //   ① 只按"变化点里均匀挑"会出事——转场全挤在开头，中段 50 秒一帧没有，叙事线直接断
      //   ② 只按等间隔会漏掉"只闪一两秒的关键画面"
      //   ⇒ 用**等间隔当骨架保证覆盖**，再把每帧**吸附到 ±半格内最近的变化点**（吸不到就保持等间隔）
      const half = duration / N / 2
      let snapped = 0
      times = uniform.map((u) => {
        const near = st.filter((s) => Math.abs(s - u) <= half)
        if (!near.length) return u
        snapped += 1
        return near.reduce((b, s) => (Math.abs(s - u) < Math.abs(b - u) ? s : b), near[0])
      })
      how = `等间隔骨架（保覆盖）+ 吸附画面变化点（阈值 ${used} 检出 ${st.length} 处；${snapped}/${N} 帧吸到了变化点）`
    } else {
      how = `纯等间隔（阈值 0.08 也未检出变化 → 每 ${(duration / N).toFixed(1)} 秒一帧）`
    }
  }
}
console.log(`取帧方式: ${how}`)
console.log(`时间点  : ${times.map((t, i) => `${i + 1}=${timeOf(t)}`).join('  ')}`)

// 抽帧：每个时间点各抽一张原始分辨率，再拼图——这样 SHEET 与 SUBS 干净地共用同一批帧
const tmp = path.join(outDir, `.frames-${stamp}`)
fs.mkdirSync(tmp, { recursive: true })
try {
  if (REMOTE) {
    // 直链 + -ss 定点抓帧：每次只拉一小段，不落整片
    const HDR = `referer: https://www.bilibili.com/\r\nuser-agent: ${UA}\r\n`
    const urls = [segments[0].url, ...(segments[0].backup_url ?? [])]
    times.forEach((t, i) => {
      const frame = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)
      let lastErr = null
      for (const url of urls) {
        try {
          execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-headers', HDR, '-ss', t.toFixed(2), '-i', url,
            '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '2', frame], { stdio: 'inherit', timeout: 180_000 })
          if (fs.existsSync(frame) && fs.statSync(frame).size) { lastErr = null; break }
          lastErr = new Error('没有生成帧')
        } catch (e) { lastErr = e }
      }
      if (lastErr) throw new Error(`时间点 ${t.toFixed(2)}s 抓帧失败：${lastErr.message}`)
    })
  } else {
    times.forEach((t, i) => {
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', localMp4,
        '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '2', path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)], { stdio: 'inherit' })
      const frame = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)
      if (!fs.existsSync(frame) || !fs.statSync(frame).size) throw new Error(`时间点 ${t.toFixed(2)}s 没有生成帧，视频可能不完整`)
    })
  }
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
    `scale=${TILE}:-1,tile=${cols}x${rows}`, '-frames:v', '1', '-pix_fmt', 'yuvj420p', sheet], { stdio: 'inherit' })
  if (!fs.existsSync(sheet)) throw new Error('九宫格没生成')
  console.log(`\nSHEET: ${sheet}`)
} catch (e) {
  console.error('ffmpeg 抽帧失败：' + e.message); process.exit(6)
}

// 字幕条版：裁掉画面、只留底部字幕带再放大，竖着拼 N 条。
// 依据（2026-10-14 实测）：这类"讲解型"视频字幕就是全部信息量，全画幅九宫格会把字幕压糊；
// 同样预算下只留字幕带，9 条字幕能全部读清。用的是同一批帧。
const subs = `${base}-subs.jpg`
try {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
    `crop=iw:ih*0.17:0:ih*0.83,scale=1280:-1,tile=1x${N}`, '-frames:v', '1', '-pix_fmt', 'yuvj420p', subs], { stdio: 'inherit' })
  if (fs.existsSync(subs)) console.log(`SUBS:  ${subs}\n（同一批帧的底部字幕带，竖排 ${N} 条）`)
} catch {
  console.log('（字幕条版生成失败，忽略——不影响 SHEET）')
}
fs.rmSync(tmp, { recursive: true, force: true })
if (REMOTE) console.log('（长片模式没有下载原片；要本地原片做字幕条 / 逐帧核对，加 --local 重跑）')
else console.log(`（原片留着: ${localMp4}；换参数重抽不必重新下载。加 --uniform 可强制等间隔）`)
console.log('（提示：这条视频若有官方字幕，先跑 `node bili.mjs subtitles <BV>` 更省也更准——' +
  '抽帧是给"字幕没官方轨、或要看画面/界面"的情况用的）')
