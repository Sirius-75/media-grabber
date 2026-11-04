import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HlsLiveRecorder } from '../src/shared/hls-live'
import { planHlsSave } from '../src/shared/hls-remux'
import { transmuxTsSegment } from '../src/shared/hls-remux-mux'
import type { PlaylistFetchResult, SegmentFetchResult } from '../src/shared/hls-fetch'

function hasFfmpeg(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

const available = hasFfmpeg()
const workdir = available ? mkdtempSync(join(tmpdir(), 'media-grabber-live-')) : undefined

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true })
})

describe.skipIf(!available)('直播分片的真实 TS 转封装', () => {
  it('ffmpeg 生成的 TS 直播分片能按现有 remux 路径转成 mp4', async () => {
    if (!workdir) return
    const segmentPath = join(workdir, 'seg.ts')
    const generated = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120:rate=25',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'mpegts',
        segmentPath,
      ],
      { stdio: 'ignore' },
    )
    expect(generated.status).toBe(0)
    const segment = new Uint8Array(readFileSync(segmentPath))

    const playlist = (end: boolean): string =>
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:1',
        '#EXT-X-MEDIA-SEQUENCE:1',
        '#EXTINF:1,',
        'seg.ts',
        ...(end ? ['#EXT-X-ENDLIST'] : []),
      ].join('\n')
    let call = 0
    const recorder = new HlsLiveRecorder({
      playlistUrl: 'https://cdn.example/live/index.m3u8',
      cancelSignal: new AbortController().signal,
      now: () => 0,
      wait: async () => undefined,
      fetchPlaylist: async (): Promise<PlaylistFetchResult> => {
        call += 1
        return { ok: true, text: playlist(call >= 2) }
      },
      fetchSegment: async (): Promise<SegmentFetchResult> => ({ ok: true, bytes: segment }),
    })
    const recorded = await recorder.run()
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) return
    expect(recorded.reason).toBe('endlist')
    expect(recorded.parts).toHaveLength(1)

    const planned = await planHlsSave({
      container: 'ts',
      parts: recorded.parts,
      transmux: transmuxTsSegment,
      yield: async () => undefined,
    })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.ext).toBe('mp4')
    const head = new TextDecoder().decode(planned.parts[0]?.slice(4, 12) ?? new Uint8Array())
    expect(head).toContain('ftyp')
  }, 30_000)
})
