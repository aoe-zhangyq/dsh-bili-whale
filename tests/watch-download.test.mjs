import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { videoSegments, downloadVideo, videoCachePath, SEGMENT_CAP_MS } from '../tools/lib/watch-download.mjs'
import { watchOptions, videoPage } from '../tools/lib/watch-options.mjs'

test('multipart video selects matching cid and duration instead of combined duration', () => {
  const data = { cid: 11, duration: 814, pages: [
    { cid: 11, duration: 202 }, { cid: 22, duration: 203 },
    { cid: 33, duration: 204 }, { cid: 44, duration: 205 },
  ] }
  assert.deepEqual(videoPage(data), { cid: 11, duration: 202, page: 1, total: 4 })
  const options = watchOptions(['--page', '2', 'BVtest'], 'out')
  assert.equal(options.bvid, 'BVtest')
  assert.deepEqual(videoPage(data, options.page), { cid: 22, duration: 203, page: 2, total: 4 })
  assert.equal(watchOptions(['BVtest', '--page=4'], 'out').page, 4)
  assert.equal(videoSegments({ durl: [{ url: 'P1', length: 202000 }] }, videoPage(data).duration).length, 1)
  assert.throws(() => videoPage(data, 5), /超出范围/)
  for (const value of ['', '0', '-1', '1.5', 'NaN', undefined]) {
    assert.throws(() => watchOptions(['BVtest', '--page', value ?? '--uniform'], 'out'), /正整数/)
  }
  assert.deepEqual(videoPage({ cid: 99, duration: 208 }), { cid: 99, duration: 208, page: 1, total: 1 })
})

test('all playurl segments are ordered; first-segment-only responses fail explicitly', () => {
  const first = { order: 1, url: 'first', length: 115000 }
  const rest = { order: 2, url: 'rest', length: 343000 }
  assert.deepEqual(videoSegments({ durl: [rest, first] }, 458), [first, rest])
  assert.throws(() => videoSegments({ durl: [first] }, 458), /不完整/)
  assert.throws(() => videoSegments({ durl: [{ url: 'first', length: 169984 }] }, 679), /不完整/)
  assert.equal(videoSegments({ durl: [{ url: 'whole', length: 208000 }] }, 208).length, 1)
})

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-video-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, output: path.join(directory, 'video.mp4') }
}

test('downloads every segment before concat, with a separate per-segment deadline', async t => {
  const { directory, output } = setup(t), calls = []
  await downloadVideo({ output, segments: [{ url: 'first', size: 5 }, { url: 'second', size: 6 }], headers: { referer: 'bili' },
    fetch: async (url, options) => {
      calls.push(url)
      assert.equal(options.timeoutMs, SEGMENT_CAP_MS + 60000)
      assert.equal(options.headers.referer, 'bili')
      return new Response(url)
    }, ffmpeg: 'ffmpeg', execFileSync: (command, args) => {
      assert.equal(command, 'ffmpeg')
      const list = args[args.indexOf('-i') + 1], work = path.dirname(list)
      assert.equal(fs.readFileSync(list, 'utf8'), "file 'part-0.mp4'\nfile 'part-1.mp4'")
      assert.equal(fs.readFileSync(path.join(work, 'part-1.mp4'), 'utf8'), 'second')
      assert.deepEqual(args.slice(-3, -1), ['-c', 'copy'])
      fs.writeFileSync(args.at(-1), 'merged')
    } })
  assert.deepEqual(calls, ['first', 'second'])
  assert.deepEqual(fs.readdirSync(directory), ['video.mp4'])
})

test('single-segment download stays intact without concat', async t => {
  const { output } = setup(t)
  await downloadVideo({ output, segments: [{ url: 'whole' }], fetch: async () => new Response('whole'),
    execFileSync: () => assert.fail('single segment needs no concat') })
  assert.equal(fs.readFileSync(output, 'utf8'), 'whole')
})

test('incomplete later segment removes temporary files and never reaches concat', async t => {
  const { directory, output } = setup(t)
  await assert.rejects(downloadVideo({ output, segments: [{ url: 'first' }, { url: 'second', size: 100 }],
    fetch: async () => new Response('partial'), execFileSync: () => assert.fail('must not concat') }), /分段 2 下载不完整/)
  assert.deepEqual(fs.readdirSync(directory), [])
})


test('cache identity survives reruns and signed URL changes, but separates media variants', () => {
  const media = { bvid: 'BVtest', cid: 11, page: 1, quality: 64, segments: [{url: 'old', size: 10, length: 1000}] }
  const file = videoCachePath('out', media)
  assert.equal(videoCachePath('out', {...media, segments: [{...media.segments[0], url: 'renewed'}]}), file)
  for (const change of [{cid: 12}, {page: 2}, {quality: 80}, {segments: [{size: 20, length: 1000}]}]) {
    assert.notEqual(videoCachePath('out', {...media, ...change}), file)
  }
})

test('failed single download resumes its retained bytes on retry', async t => {
  const {output} = setup(t)
  await assert.rejects(downloadVideo({output, segments: [{url: 'mock', size: 10}],
    fetch: async () => new Response('first', {headers: {'content-length': '5'}})}), /下载不完整/)
  assert.equal(fs.existsSync(output), false)
  assert.equal(fs.readFileSync(output + '.part', 'utf8'), 'first')
  await downloadVideo({output, segments: [{url: 'mock', size: 10}], fetch: async (_, options) => {
    assert.equal(options.headers.range, 'bytes=5-')
    return new Response('later', {status: 206, headers: {'content-range': 'bytes 5-9/10', 'content-length': '5'}})
  }})
  assert.equal(fs.readFileSync(output, 'utf8'), 'firstlater')
  assert.equal(fs.existsSync(output + '.part'), false)
})

test('server ignoring Range restarts instead of appending', async t => {
  const {output} = setup(t)
  fs.writeFileSync(output + '.part', 'first')
  await downloadVideo({output, segments: [{url: 'mock', size: 10}], fetch: async () =>
    new Response('0123456789', {headers: {'content-length': '10'}})})
  assert.equal(fs.readFileSync(output, 'utf8'), '0123456789')
})

test('mismatched resume range preserves partial data and fails', async t => {
  const {output} = setup(t)
  fs.writeFileSync(output + '.part', 'first')
  await assert.rejects(downloadVideo({output, segments: [{url: 'mock', size: 10}], fetch: async () =>
    new Response('later', {status: 206, headers: {'content-range': 'bytes 0-4/10'}})}), /续传范围不匹配/)
  assert.equal(fs.readFileSync(output + '.part', 'utf8'), 'first')
})

test('complete partial file is published without redownloading', async t => {
  const {output} = setup(t)
  fs.writeFileSync(output + '.part', 'whole')
  await downloadVideo({output, segments: [{url: 'mock', size: 5}], fetch: () => assert.fail('already complete')})
  assert.equal(fs.readFileSync(output, 'utf8'), 'whole')
})

test('concat failure never publishes partial output or replaces an existing file', async t => {
  const {directory, output} = setup(t)
  fs.writeFileSync(output, 'existing')
  await assert.rejects(downloadVideo({output, segments: [{url: 'a'}, {url: 'b'}], fetch: async () => new Response('ok'),
    execFileSync: (_, args) => {fs.writeFileSync(args.at(-1), 'partial'); throw Error('concat failed')}}), /concat failed/)
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing')
  assert.deepEqual(fs.readdirSync(directory), ['video.mp4'])
})
