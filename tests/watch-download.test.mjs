import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { videoSegments, downloadVideo } from '../tools/lib/watch-download.mjs'

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

test('downloads every segment before concat, with a separate ten-minute deadline', async t => {
  const { directory, output } = setup(t), calls = []
  await downloadVideo({ output, segments: [{ url: 'first', size: 5 }, { url: 'second', size: 6 }], headers: { referer: 'bili' },
    fetch: async (url, options) => {
      calls.push(url)
      assert.equal(options.timeoutMs, 600000)
      assert.equal(options.headers.referer, 'bili')
      return new Response(url)
    }, ffmpeg: 'ffmpeg', execFileSync: (command, args) => {
      assert.equal(command, 'ffmpeg')
      const list = args[args.indexOf('-i') + 1], work = path.dirname(list)
      assert.equal(fs.readFileSync(list, 'utf8'), "file 'part-0.mp4'\nfile 'part-1.mp4'")
      assert.equal(fs.readFileSync(path.join(work, 'part-1.mp4'), 'utf8'), 'second')
      assert.deepEqual(args.slice(-3), ['-c', 'copy', output])
      fs.writeFileSync(output, 'merged')
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
