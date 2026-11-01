import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { guardedFetch as fetch } from './traffic.mjs'

// 2026-11-01 修（主人排查）：102 分钟的「原神交响音乐会2023」抽帧两次失败，报
//   「下载失败：The operation was aborted」。
//   实测：P1 单段 882.6MB，CDN 持续吞吐 1.26–1.43MB/s → 需要 616–700s；
//   而这里原来写死 timeoutMs = 600_000，第 600 秒 AbortSignal.timeout 触发，
//   pipeline 把 TimeoutError 重包成 AbortError: "The operation was aborted" ✗
//   不是 B站 规则（playurl code=0、quality=64、Range 支持 206），也不是多P ✗
// 现在改成三条：
//   ① 不用死钟表：60 秒没有新字节才算卡死（stallMs）；总上限放宽到 30 分钟（capMs）
//   ② 单段视频写 `<output>.part`，失败后保留，下次用 Range 从断点续传
//   ③ 失败信息带上已下载字节数与速度，便于判断是"慢"还是"被墙"

export const STALL_MS = 60_000
export const SEGMENT_CAP_MS = 1_800_000

export function videoCachePath(directory, { bvid, cid, page, quality, segments }) {
  // Signed CDN URLs change between runs; media identity must remain stable.
  const identity = JSON.stringify([cid, quality, segments.map(s => [s.size ?? null, s.length ?? null])])
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return path.join(directory, `${bvid}-p${page}-${key}.mp4`)
}

export function videoSegments(data, duration) {
  const segments = data?.durl
  if (!Array.isArray(segments) || !segments.length || segments.some(s => !s.url)) throw new Error('没拿到完整视频直链')
  const ordered = [...segments].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const total = ordered.reduce((sum, s) => sum + Number(s.length || 0), 0)
  // 元数据可能按秒取整，但不能把只有首段的响应当成完整视频。
  if (total > 0 && total / 1000 < duration - 2) throw new Error(`视频直链不完整：分段合计 ${(total / 1000).toFixed(2)} 秒，预期 ${duration} 秒`)
  return ordered
}

const mb = (n) => `${(n / 1048576).toFixed(1)}MB`

// 按"有没有新字节"计时，而不是按墙钟：CDN 慢但一直在动就不该被杀
async function streamToFile({ response, file, append, stallMs, capMs, log }) {
  const controller = new AbortController()
  const started = Date.now()
  let lastAt = Date.now()
  let bytes = 0
  let aborted = null
  const timer = setInterval(() => {
    const now = Date.now()
    if (now - started > capMs) aborted = new Error(`下载超过 ${(capMs / 60000).toFixed(0)} 分钟总上限（已下载 ${mb(bytes)}）`)
    else if (now - lastAt > stallMs) aborted = new Error(`下载停滞 ${(stallMs / 1000).toFixed(0)} 秒（已下载 ${mb(bytes)}）`)
    if (aborted) controller.abort(aborted)
  }, 2000)
  timer.unref?.()
  const counter = new Transform({
    transform(chunk, _enc, cb) { bytes += chunk.length; lastAt = Date.now(); cb(null, chunk) },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(file, { flags: append ? 'a' : 'w' }), { signal: controller.signal })
  } catch (e) {
    if (aborted) throw aborted
    throw e
  } finally {
    clearInterval(timer)
  }
  return bytes
}

function totalFromHeaders(response, fallback) {
  const cr = response.headers.get('content-range')
  const m = cr && /\/\s*(\d+)\s*$/.exec(cr)
  if (m) return Number(m[1])
  const cl = response.headers.get('content-length')
  return cl !== null ? Number(cl) : fallback
}

export async function downloadVideo({ segments, output, headers, fetch: transport = fetch, ffmpeg, execFileSync, stallMs = STALL_MS, capMs = SEGMENT_CAP_MS, log = () => {} }) {
  const single = segments.length === 1
  if (single) {
    const declared = Number(segments[0].size) > 0 ? Number(segments[0].size) : null
    try {
      const st = fs.statSync(output)
      if (st.size > 0 && (!declared || st.size === declared)) {
        log(`已完整，直接复用 ${mb(st.size)}（不再下载）`)
        return
      }
    } catch {}
  }
  // 单段：直接写 .part 到最终目录，断点可续；多段：仍在临时目录拼
  const work = single ? null : fs.mkdtempSync(path.join(path.dirname(output), '.download-'))
  const partial = single ? output + '.part' : null
  const files = []
  try {
    for (const [i, segment] of segments.entries()) {
      const file = single ? partial : path.join(work, `part-${i}.mp4`)
      const declared = Number(segment.size) > 0 ? Number(segment.size) : null
      let startAt = 0
      try { const st = fs.statSync(file); if (declared && st.size > 0 && st.size <= declared) startAt = st.size } catch {}
      if (declared && startAt === declared) { log(`分段 ${i + 1} 已完整（复用 ${mb(startAt)}）`); files.push(file); continue }
      const rangeHeaders = { ...headers }
      if (startAt > 0) rangeHeaders.range = `bytes=${startAt}-`
      // 传输层给一个比看门狗更宽的兜底（看门狗管"卡住"，这里只防走不到终点的极端情况）
      const response = await transport(segment.url, { headers: rangeHeaders, timeoutMs: capMs + 60_000, signal: AbortSignal.timeout(capMs + 60_000) })
      if (!response.ok || !response.body) throw new Error(`分段 ${i + 1} 下载失败：HTTP ${response.status}`)
      const total = totalFromHeaders(response, declared)
      const resumed = response.status === 206 && startAt > 0
      if (resumed) {
        const range = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
        if (!range || Number(range[1]) !== startAt) {
          await response.body.cancel()
          throw new Error(`分段 ${i + 1} 续传范围不匹配`)
        }
      }
      if (startAt > 0 && !resumed) { startAt = 0 }
      if (startAt > 0) log(`分段 ${i + 1} 从 ${mb(startAt)} 处续传`)
      const t0 = Date.now()
      const bytes = await streamToFile({ response, file, append: startAt > 0, stallMs, capMs, log })
      const size = fs.statSync(file).size
      const seconds = Math.max(0.001, (Date.now() - t0) / 1000)
      const speedMBs = (startAt > 0 ? bytes : size) / 1048576 / seconds
      log(`分段 ${i + 1} 完成 ${mb(size)}（${speedMBs.toFixed(2)} MB/s）`)
      const expected = declared ?? total
      if (!size || (total && size !== total) || (declared && size !== declared)) throw new Error(`分段 ${i + 1} 下载不完整：${mb(size)} / 预期 ${mb(expected)}`)
      files.push(file)
    }
    if (single) fs.renameSync(partial, output)
    else if (files.length === 1) fs.renameSync(files[0], output)
    else {
      // 清单只引用工作目录中生成的文件名，不嵌入外部 URL 或路径。
      const list = path.join(work, 'concat.txt')
      fs.writeFileSync(list, files.map((_, i) => `file 'part-${i}.mp4'`).join('\n'))
      const merged = path.join(work, 'merged.mp4')
      execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', list, '-map', '0', '-c', 'copy', merged], { timeout: 1_800_000 })
      fs.renameSync(merged, output)
    }
  } catch (e) {
    // 单段保留 .part 供下次续传；多段的半成品在 finally 里清掉
    throw e
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true })
  }
}
