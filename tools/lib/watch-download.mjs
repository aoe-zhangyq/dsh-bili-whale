import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { guardedFetch as fetch } from './traffic.mjs'

export function videoSegments(data, duration) {
  const segments = data?.durl
  if (!Array.isArray(segments) || !segments.length || segments.some(s => !s.url)) throw new Error('没拿到完整视频直链')
  const ordered = [...segments].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const total = ordered.reduce((sum, s) => sum + Number(s.length || 0), 0)
  // 元数据可能按秒取整，但不能把只有首段的响应当成完整视频。
  if (total > 0 && total / 1000 < duration - 2) throw new Error(`视频直链不完整：分段合计 ${(total / 1000).toFixed(2)} 秒，预期 ${duration} 秒`)
  return ordered
}

export async function downloadVideo({ segments, output, headers, fetch: transport = fetch, ffmpeg, execFileSync }) {
  const work = fs.mkdtempSync(path.join(path.dirname(output), '.download-'))
  try {
    const files = []
    for (const [i, segment] of segments.entries()) {
      const file = path.join(work, `part-${i}.mp4`)
      const timeoutMs = 600_000, signal = AbortSignal.timeout(timeoutMs)
      const response = await transport(segment.url, { headers, timeoutMs, signal })
      if (!response.ok || !response.body) throw new Error(`分段 ${i + 1} 下载失败：HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file), { signal })
      signal.throwIfAborted()
      const size = fs.statSync(file).size
      const expected = response.headers.get('content-length')
      if (!size || (expected !== null && size !== Number(expected)) || (Number(segment.size) > 0 && size !== Number(segment.size))) throw new Error(`分段 ${i + 1} 下载不完整`)
      files.push(file)
    }
    if (files.length === 1) fs.renameSync(files[0], output)
    else {
      // 清单只引用工作目录中生成的文件名，不嵌入外部 URL 或路径。
      const list = path.join(work, 'concat.txt')
      fs.writeFileSync(list, files.map((_, i) => `file 'part-${i}.mp4'`).join('\n'))
      execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', list, '-map', '0', '-c', 'copy', output], { timeout: 600_000 })
    }
  } catch (e) {
    fs.rmSync(output, { force: true })
    throw e
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
