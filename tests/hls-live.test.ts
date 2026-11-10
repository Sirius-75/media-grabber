import { describe, expect, it } from 'vitest'
import {
  HlsLiveRecorder,
  LIVE_POLL_MAX_MS,
  LIVE_POLL_MIN_MS,
  LIVE_STALL_MS,
  firstLiveSequence,
  formatLiveElapsed,
  liveRecordingText,
} from '../src/shared/hls-live'
import type { PlaylistFetchResult, SegmentFetchResult } from '../src/shared/hls-fetch'
import { ivFromMediaSequence } from '../src/shared/hls'
import { formatBytes } from '../src/shared/format'

const PLAYLIST = 'https://cdn.example/live/index.m3u8'

function playlist(sequence: number, names: string[], options: { end?: boolean; key?: string } = {}): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${sequence}`]
  if (options.key) lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="${options.key}"`)
  for (const name of names) lines.push('#EXTINF:2,', name)
  if (options.end) lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function textOf(parts: readonly Uint8Array[]): string {
  return parts.map((part) => new TextDecoder().decode(part)).join('')
}

interface Harness {
  clock: { now: number }
  recorder: HlsLiveRecorder
  playlistCalls: () => number
  segmentCalls: string[]
}

function makeHarness(input: {
  playlists: string[]
  segments: Record<string, Uint8Array | number>
  cancelSignal?: AbortSignal
  maxBytes?: number
  maxManifestFailures?: number
  /**
   * 这些用例测的是去重、停止和失败，需要把第一份窗口里的分片都录下来。
   * 产品默认是从直播边缘开始；要测边缘时显式传 false。
   */
  includeExistingSegments?: boolean
  onPlaylist?: (call: number) => void
  onSegment?: (url: string, call: number) => void
}): Harness {
  const clock = { now: 0 }
  let playlistCall = 0
  const segmentCalls: string[] = []
  const cancel = new AbortController()
  const cancelSignal = input.cancelSignal ?? cancel.signal
  const recorder = new HlsLiveRecorder({
    playlistUrl: PLAYLIST,
    cancelSignal,
    maxBytes: input.maxBytes,
    maxManifestFailures: input.maxManifestFailures,
    includeExistingSegments: input.includeExistingSegments ?? true,
    now: () => clock.now,
    wait: async (ms, signal) => {
      if (signal.aborted) return
      clock.now += ms
      if (input.onPlaylist) {
        // 只推进时间，不代替 fetch 回调。
      }
    },
    fetchPlaylist: async (): Promise<PlaylistFetchResult> => {
      playlistCall += 1
      input.onPlaylist?.(playlistCall)
      const body = input.playlists[playlistCall - 1]
      if (body === undefined) return { ok: false, status: 0, reason: 'network' }
      return { ok: true, text: body }
    },
    fetchSegment: async (url): Promise<SegmentFetchResult> => {
      segmentCalls.push(url)
      input.onSegment?.(url, segmentCalls.length)
      const value = input.segments[url]
      if (value === undefined) return { ok: false, status: 404 }
      if (typeof value === 'number') return { ok: false, status: value }
      return { ok: true, bytes: value }
    },
  })
  return { clock, recorder, playlistCalls: () => playlistCall, segmentCalls }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

async function encrypt(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['encrypt'])
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: toArrayBuffer(iv) },
    cryptoKey,
    toArrayBuffer(plain),
  )
  return new Uint8Array(cipher)
}

describe('直播录制轮询', () => {
  it('按 media sequence 去重，滚动窗口和重复清单都只追加新分片', async () => {
    const harness = makeHarness({
      playlists: [
        playlist(10, ['a.ts', 'b.ts']),
        playlist(10, ['a.ts', 'b.ts']),
        playlist(11, ['b.ts', 'c.ts']),
        playlist(12, ['c.ts', 'd.ts'], { end: true }),
      ],
      segments: {
        'https://cdn.example/live/a.ts': bytesOf('a'),
        'https://cdn.example/live/b.ts': bytesOf('b'),
        'https://cdn.example/live/c.ts': bytesOf('c'),
        'https://cdn.example/live/d.ts': bytesOf('d'),
      },
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reason).toBe('endlist')
    expect(result.segmentCount).toBe(4)
    expect(textOf(result.parts)).toBe('abcd')
    expect(result.durationSeconds).toBe(8)
    expect(harness.segmentCalls).toHaveLength(4)
    expect(result.message).toContain('EXT-X-ENDLIST')
  })

  it('「停止并保存」中断轮询时，已经录到的分片仍然返回', async () => {
    let recorder: HlsLiveRecorder | undefined
    const harness = makeHarness({
      playlists: [playlist(1, ['a.ts']), playlist(1, ['a.ts', 'b.ts']), playlist(1, ['a.ts', 'b.ts'])],
      segments: {
        'https://cdn.example/live/a.ts': bytesOf('a'),
        'https://cdn.example/live/b.ts': bytesOf('b'),
      },
      onPlaylist(call) {
        if (call === 3) recorder?.stop()
      },
    })
    recorder = harness.recorder
    const result = await recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reason).toBe('user')
    expect(textOf(result.parts)).toBe('ab')
    expect(result.parts.length).toBeGreaterThan(0)
  })

  it('停止会打断卡住的清单请求，已录内容仍然返回', async () => {
    let call = 0
    let secondStarted: () => void = () => undefined
    const secondPoll = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    const recorder = new HlsLiveRecorder({
      playlistUrl: PLAYLIST,
      cancelSignal: new AbortController().signal,
      now: () => 0,
      wait: async () => undefined,
      fetchPlaylist: async (_url, signal): Promise<PlaylistFetchResult> => {
        call += 1
        if (call === 1) return { ok: true, text: playlist(1, ['a.ts']) }
        secondStarted()
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: false, status: 0, reason: 'network' }), { once: true })
        })
      },
      fetchSegment: async (): Promise<SegmentFetchResult> => ({ ok: true, bytes: bytesOf('a') }),
    })
    const running = recorder.run()
    await secondPoll
    recorder.stop()
    const result = await running
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reason).toBe('user')
    expect(textOf(result.parts)).toBe('a')
  })

  it('分片 404 时停止并保留之前的内容', async () => {
    const harness = makeHarness({
      playlists: [playlist(1, ['a.ts']), playlist(1, ['a.ts', 'b.ts'])],
      segments: {
        'https://cdn.example/live/a.ts': bytesOf('a'),
        'https://cdn.example/live/b.ts': 404,
      },
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reason).toBe('segment-failed')
    expect(textOf(result.parts)).toBe('a')
  })

  it('连续 30 秒没有新分片时自动停止，重复清单不重复下载', async () => {
    const harness = makeHarness({
      playlists: Array.from({ length: 40 }, () => playlist(5, ['a.ts'])),
      segments: { 'https://cdn.example/live/a.ts': bytesOf('a') },
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reason).toBe('stalled')
    expect(result.segmentCount).toBe(1)
    expect(harness.clock.now).toBeGreaterThanOrEqual(LIVE_STALL_MS)
    expect(harness.segmentCalls).toHaveLength(1)
  })

  it('清单连续请求失败时自动停止并保留已有内容', async () => {
    const harness = makeHarness({
      playlists: [playlist(1, ['a.ts'])],
      segments: { 'https://cdn.example/live/a.ts': bytesOf('a') },
      maxManifestFailures: 3,
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reason).toBe('manifest-failed')
    expect(result.parts).toHaveLength(1)
  })

  it('用小上限验证 1GB 上限：超出的那一片不加入，已录内容保留', async () => {
    const harness = makeHarness({
      playlists: [playlist(1, ['a.ts', 'b.ts'])],
      segments: {
        'https://cdn.example/live/a.ts': bytesOf('12345'),
        'https://cdn.example/live/b.ts': bytesOf('123456'),
      },
      maxBytes: 10,
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reason).toBe('size-limit')
    expect(result.bytes).toBe(5)
    expect(textOf(result.parts)).toBe('12345')
  })

  it('取消后不返回任何已录分片', async () => {
    const controller = new AbortController()
    const harness = makeHarness({
      playlists: [playlist(1, ['a.ts']), playlist(2, ['a.ts'])],
      segments: { 'https://cdn.example/live/a.ts': bytesOf('a') },
      cancelSignal: controller.signal,
      onPlaylist(call) {
        if (call === 2) controller.abort()
      },
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.cancelled).toBe(true)
    expect(result.error).toContain('取消')
  })

  it('AES-128 直播边下边解密，密钥只取一次', async () => {
    const key = new Uint8Array(16).fill(7)
    const ivA = ivFromMediaSequence(5)
    const ivB = ivFromMediaSequence(6)
    const plainA = new Uint8Array([0x47, 1, 2, 3, 4, 5])
    const plainB = new Uint8Array([0x47, 6, 7, 8, 9, 10])
    const cipherA = await encrypt(plainA, key, ivA)
    const cipherB = await encrypt(plainB, key, ivB)
    const harness = makeHarness({
      playlists: [
        playlist(5, ['a.ts'], { key: 'key.bin' }),
        playlist(5, ['a.ts', 'b.ts'], { key: 'key.bin', end: true }),
      ],
      segments: {
        'https://cdn.example/live/key.bin': key,
        'https://cdn.example/live/a.ts': cipherA,
        'https://cdn.example/live/b.ts': cipherB,
      },
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reason).toBe('endlist')
    expect(Array.from(result.parts[0] ?? [])).toEqual(Array.from(plainA))
    expect(Array.from(result.parts[1] ?? [])).toEqual(Array.from(plainB))
    expect(harness.segmentCalls.filter((url) => url.endsWith('key.bin'))).toHaveLength(1)
  })
})

describe('直播从点击时的边缘开始', () => {
  it('默认只收录窗口里序号最大的分片，之后的新分片继续追加', async () => {
    const harness = makeHarness({
      includeExistingSegments: false,
      playlists: [
        playlist(10, ['a.ts', 'b.ts', 'c.ts']),
        playlist(12, ['c.ts', 'd.ts']),
        playlist(13, ['d.ts', 'e.ts'], { end: true }),
      ],
      segments: {
        'https://cdn.example/live/a.ts': bytesOf('a'),
        'https://cdn.example/live/b.ts': bytesOf('b'),
        'https://cdn.example/live/c.ts': bytesOf('c'),
        'https://cdn.example/live/d.ts': bytesOf('d'),
        'https://cdn.example/live/e.ts': bytesOf('e'),
      },
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(textOf(result.parts)).toBe('cde')
    expect(result.segmentCount).toBe(3)
    expect(result.durationSeconds).toBe(6)
    expect(harness.segmentCalls).toEqual([
      'https://cdn.example/live/c.ts',
      'https://cdn.example/live/d.ts',
      'https://cdn.example/live/e.ts',
    ])
  })

  it('第一份清单还没有分片时，下一份再按边缘对齐', async () => {
    const harness = makeHarness({
      includeExistingSegments: false,
      playlists: [playlist(1, []), playlist(4, ['a.ts', 'b.ts', 'c.ts'], { end: true })],
      segments: {
        'https://cdn.example/live/a.ts': bytesOf('a'),
        'https://cdn.example/live/b.ts': bytesOf('b'),
        'https://cdn.example/live/c.ts': bytesOf('c'),
      },
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(textOf(result.parts)).toBe('c')
    expect(harness.segmentCalls).toEqual(['https://cdn.example/live/c.ts'])
  })

  it('fMP4 仍然先取初始化段，媒体分片只留边缘那一片', async () => {
    const init = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:8',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:2,',
      'a.m4s',
      '#EXTINF:2,',
      'b.m4s',
      '#EXTINF:2,',
      'c.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n')
    // 第一份是直播，第二份才结束。边缘对齐发生在第一份。
    const live = init.replace('#EXT-X-ENDLIST', '')
    const harness = makeHarness({
      includeExistingSegments: false,
      playlists: [live, init],
      segments: {
        'https://cdn.example/live/init.mp4': bytesOf('INIT'),
        'https://cdn.example/live/a.m4s': bytesOf('a'),
        'https://cdn.example/live/b.m4s': bytesOf('b'),
        'https://cdn.example/live/c.m4s': bytesOf('c'),
      },
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.container).toBe('mp4')
    expect(textOf(result.parts)).toBe('INITc')
    expect(harness.segmentCalls).toEqual([
      'https://cdn.example/live/init.mp4',
      'https://cdn.example/live/c.m4s',
    ])
  })

  it('开关打开时，窗口里已有的分片都写入', async () => {
    const harness = makeHarness({
      includeExistingSegments: true,
      playlists: [playlist(3, ['a.ts', 'b.ts']), playlist(3, ['a.ts', 'b.ts'], { end: true })],
      segments: {
        'https://cdn.example/live/a.ts': bytesOf('a'),
        'https://cdn.example/live/b.ts': bytesOf('b'),
      },
    })
    const result = await harness.recorder.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(textOf(result.parts)).toBe('ab')
  })

  it('firstLiveSequence 在边缘和整窗之间切换', () => {
    const segments = [{ sequence: 4 }, { sequence: 5 }, { sequence: undefined }, { sequence: 9 }]
    expect(firstLiveSequence(segments, 'edge')).toBe(9)
    expect(firstLiveSequence(segments, 'all')).toBe(4)
    expect(firstLiveSequence([], 'edge')).toBeUndefined()
    expect(firstLiveSequence([{ sequence: undefined }], 'all')).toBeUndefined()
  })
})

describe('直播状态文案', () => {
  it('mm:ss 向上取整到秒，已录大小用现有格式化', () => {
    expect(formatLiveElapsed(0)).toBe('00:00')
    expect(formatLiveElapsed(65_000)).toBe('01:05')
    expect(formatLiveElapsed(3_599_000)).toBe('59:59')
    expect(formatLiveElapsed(Number.NaN)).toBe('00:00')
    expect(liveRecordingText({ elapsedMs: 61_000, bytes: 1536 })).toBe(
      `正在录制 01:01 / 已录 ${formatBytes(1536)}`,
    )
  })

  it('轮询间隔常量在 1 到 5 秒之间', () => {
    expect(LIVE_POLL_MIN_MS).toBe(1_000)
    expect(LIVE_POLL_MAX_MS).toBe(5_000)
  })
})
