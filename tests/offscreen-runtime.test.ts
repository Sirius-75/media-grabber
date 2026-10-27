/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DASH_JOB_STORAGE_KEY } from '../src/shared/dash-job'
import { HLS_TEXT } from '../src/shared/hls'
import { HLS_JOB_STORAGE_KEY } from '../src/shared/hls-job'
import { OFFSCREEN_BRIDGE } from '../src/shared/offscreen-bridge'
import { inspectFailureMessage } from '../src/offscreen/failure'

/**
 * offscreen 文档里只有 chrome.runtime。
 * 其余 chrome.* 一访问就抛错，用来抓住存储和下载 API 漏回去的回归。
 */

const MASTER = 'https://cdn.example/master.m3u8'
const MEDIA = 'https://cdn.example/high.m3u8'
const PICK = 'https://origin.example/dash/pick.mpd'
const AV = 'https://origin.example/dash/av.mpd'

const MASTER_TEXT = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080',
  MEDIA,
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
  'https://cdn.example/low.m3u8',
].join('\n')

const MEDIA_TEXT = [
  '#EXTM3U',
  '#EXT-X-MAP:URI="https://cdn.example/init.mp4"',
  '#EXTINF:4,',
  'https://cdn.example/seg.m4s',
  '#EXT-X-ENDLIST',
].join('\n')

const PICK_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate timescale="1" duration="4" initialization="i.mp4" media="$Number$.m4s"/>
      <Representation id="low" bandwidth="1000" width="320" height="180"/>
      <Representation id="high" bandwidth="9000" width="1920" height="1080"/>
    </AdaptationSet>
  </Period>
</MPD>`

const AV_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate timescale="1" duration="4" initialization="vinit.mp4" media="v$Number$.m4s"/>
      <Representation id="v" bandwidth="2000000" width="1280" height="720"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <SegmentTemplate timescale="1" duration="4" initialization="ainit.mp4" media="a$Number$.m4s"/>
      <Representation id="a" bandwidth="128000"/>
    </AdaptationSet>
  </Period>
</MPD>`

const PLAYLISTS = new Map<string, string>([
  [MASTER, MASTER_TEXT],
  [MEDIA, MEDIA_TEXT],
  [PICK, PICK_MPD],
  [AV, AV_MPD],
])

interface Sent {
  type?: string
  storageKey?: string
  key?: string
  filename?: string
  url?: string
  record?: { phase?: string; message?: string; epoch?: number; variants?: unknown[] }
}

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined

interface Harness {
  sent: Sent[]
  created: string[]
  revoked: string[]
  revokeDelays: number[]
  fetches: Array<{ url: string; init: RequestInit }>
  respond(message: Sent): unknown
  dispatch(message: unknown): Promise<unknown>
}

const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
const timers: number[] = []

function runtimeOnlyChrome(runtime: { onMessage: { addListener(listener: Listener): void }; sendMessage(message: unknown): Promise<unknown> }) {
  const api = { runtime }
  return new Proxy(api, {
    get(target, prop) {
      if (prop === 'runtime') return target.runtime
      if (prop === 'then') return undefined
      throw new Error(`offscreen 不能使用 chrome.${String(prop)}`)
    },
    set(_target, prop) {
      throw new Error(`offscreen 不能使用 chrome.${String(prop)}`)
    },
  })
}

async function setup(respond?: (message: Sent) => unknown, options?: { failFetch?: boolean }): Promise<Harness> {
  vi.resetModules()
  const sent: Sent[] = []
  const created: string[] = []
  const revoked: string[] = []
  const revokeDelays: number[] = []
  const fetches: Array<{ url: string; init: RequestInit }> = []
  const listeners: Listener[] = []
  let blobId = 0

  URL.createObjectURL = () => {
    blobId += 1
    const url = `blob:https://offscreen.local/${blobId}`
    created.push(url)
    return url
  }
  URL.revokeObjectURL = (url: string) => {
    revoked.push(String(url))
  }

  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 60_000) {
      revokeDelays.push(60_000)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    const id = realSetTimeout(handler, timeout, ...(args as []))
    timers.push(id as unknown as number)
    return id
  }) as typeof setTimeout)

  const answer =
    respond ??
    ((message: Sent) => {
      if (message.type === OFFSCREEN_BRIDGE.SAVE_BLOB) return { ok: true, downloadId: 11 }
      return { ok: true }
    })
  const runtime = {
    onMessage: {
      addListener(listener: Listener) {
        listeners.push(listener)
      },
    },
    sendMessage(message: unknown) {
      const record = message as Sent
      sent.push(record)
      return Promise.resolve().then(() => answer(record))
    },
  }
  vi.stubGlobal('chrome', runtimeOnlyChrome(runtime))
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options?.failFetch) throw new TypeError('Failed to fetch')
    const url = String(input)
    fetches.push({ url, init: init ?? {} })
    const text = PLAYLISTS.get(url)
    if (text !== undefined) return new Response(text, { status: 200 })
    return new Response(Uint8Array.of(1, 2, 3, 4), { status: 200 })
  })

  const mod = await import('../src/offscreen/main.ts')
  mod.startOffscreen()

  return {
    sent,
    created,
    revoked,
    revokeDelays,
    fetches,
    respond: answer,
    dispatch(message: unknown) {
      return new Promise((resolve, reject) => {
        const timer = realSetTimeout(() => reject(new Error('offscreen 没有回复')), 4000)
        let asyncReply = false
        const sendResponse = (response?: unknown) => {
          clearTimeout(timer)
          resolve(response)
        }
        for (const listener of listeners) {
          if (listener(message, {} as chrome.runtime.MessageSender, sendResponse) === true) asyncReply = true
        }
        if (!asyncReply) {
          clearTimeout(timer)
          resolve(undefined)
        }
      })
    },
  }
}

function writes(sent: Sent[], storageKey: string): Sent[] {
  return sent.filter((message) => message.type === OFFSCREEN_BRIDGE.WRITE_JOB && message.storageKey === storageKey)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 4000) throw new Error('等待 offscreen 流程超时')
    await new Promise((resolve) => realSetTimeout(resolve, 10))
  }
}

afterEach(() => {
  for (const id of timers) clearTimeout(id)
  timers.length = 0
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('清单失败文案', () => {
  it('解析异常和消息失败算内部错误，网络错误仍是网络连接失败', () => {
    expect(inspectFailureMessage(new SyntaxError('Unexpected token <'))).toBe(HLS_TEXT.internal)
    expect(inspectFailureMessage(new Error('Could not establish connection. Receiving end does not exist.'))).toBe(
      HLS_TEXT.internal,
    )
    expect(inspectFailureMessage(new TypeError('Failed to fetch'))).toBe(HLS_TEXT.network)
  })
})

describe('offscreen 源码', () => {
  it('不出现 chrome.storage / downloads / tabs', () => {
    const dir = join(process.cwd(), 'src/offscreen')
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text, name).not.toMatch(/chrome\.(storage|downloads|tabs)\b/)
    }
  })
})

describe('offscreen 只使用 chrome.runtime', () => {
  it('HLS 主清单和分片下载都把进度、Blob 地址发给后台', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const harness = await setup()
    expect(() => {
      void (chrome as unknown as { storage: { session: unknown } }).storage
    }).toThrow(/chrome\.storage/)
    expect(() => {
      void (chrome as unknown as { downloads: { download: unknown } }).downloads
    }).toThrow(/chrome\.downloads/)

    const inspected = await harness.dispatch({ type: 'HLS_OFFSCREEN_INSPECT', playlistUrl: MASTER })
    expect(inspected).toMatchObject({ ok: true, kind: 'master' })
    const picking = writes(harness.sent, HLS_JOB_STORAGE_KEY).find((message) => message.record?.phase === 'picking')
    expect(picking?.record?.variants).toHaveLength(2)
    expect(picking?.record?.epoch).toBeUndefined()

    const started = await harness.dispatch({
      type: 'HLS_OFFSCREEN_DOWNLOAD',
      playlistUrl: MASTER,
      mediaUrl: MEDIA,
      title: 'Big Buck Bunny',
      index: 1,
    })
    expect(started).toEqual({ ok: true })
    await waitFor(() =>
      writes(harness.sent, HLS_JOB_STORAGE_KEY).some((message) => message.record?.phase === 'complete'),
    )

    const saved = harness.sent.find((message) => message.type === OFFSCREEN_BRIDGE.SAVE_BLOB)
    expect(saved).toMatchObject({
      url: harness.created[0],
      filename: 'Big Buck Bunny-1.mp4',
    })
    expect(Object.keys(saved ?? {}).sort()).toEqual(['filename', 'type', 'url'])
    const jobWrites = writes(harness.sent, HLS_JOB_STORAGE_KEY)
    expect(jobWrites.some((message) => message.record?.phase === 'downloading')).toBe(true)
    const done = jobWrites.find((message) => message.record?.phase === 'complete')
    expect(done?.record?.epoch).toBeGreaterThan(0)
    expect(harness.revokeDelays).toEqual([60_000])
    expect(harness.revoked).toEqual([])
    expect(harness.fetches.every((call) => call.init.headers === undefined && call.init.credentials === 'include')).toBe(
      true,
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('DASH 音视频两个文件都交给后台保存', async () => {
    const harness = await setup()
    const inspected = await harness.dispatch({ type: 'DASH_OFFSCREEN_INSPECT', playlistUrl: PICK })
    expect(inspected).toMatchObject({ ok: true, kind: 'master' })
    expect(writes(harness.sent, DASH_JOB_STORAGE_KEY).some((message) => message.record?.phase === 'picking')).toBe(true)

    const started = await harness.dispatch({
      type: 'DASH_OFFSCREEN_DOWNLOAD',
      playlistUrl: AV,
      title: 'Big Buck Bunny',
      index: 2,
    })
    expect(started).toEqual({ ok: true })
    await waitFor(() => harness.sent.filter((message) => message.type === OFFSCREEN_BRIDGE.SAVE_BLOB).length >= 2)

    const saved = harness.sent.filter((message) => message.type === OFFSCREEN_BRIDGE.SAVE_BLOB)
    expect(saved.map((message) => message.filename)).toEqual(['Big Buck Bunny-2.mp4', 'Big Buck Bunny-2.m4a'])
    expect(saved.map((message) => message.url)).toEqual(harness.created)
    expect(harness.revokeDelays).toEqual([60_000, 60_000])
    expect(harness.revoked).toEqual([])
    expect(writes(harness.sent, DASH_JOB_STORAGE_KEY).some((message) => message.record?.phase === 'complete')).toBe(true)
    expect(writes(harness.sent, HLS_JOB_STORAGE_KEY)).toEqual([])
  })

  it('消息发不出去时，检查清单返回内部错误并留下原始异常', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cause = new Error('Could not establish connection. Receiving end does not exist.')
    const harness = await setup(() => {
      throw cause
    })
    const inspected = await harness.dispatch({ type: 'HLS_OFFSCREEN_INSPECT', playlistUrl: MASTER })
    expect(inspected).toEqual({ ok: false, error: HLS_TEXT.internal })
    expect(warn).toHaveBeenCalledWith('[media-grabber] 读取清单失败', cause)
  })

  it('拉清单的网络错误仍然说网络连接失败', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const harness = await setup(undefined, { failFetch: true })
    const inspected = await harness.dispatch({ type: 'HLS_OFFSCREEN_INSPECT', playlistUrl: MASTER })
    expect(inspected).toEqual({ ok: false, error: HLS_TEXT.network })
    expect(writes(harness.sent, HLS_JOB_STORAGE_KEY).map((message) => message.record?.message)).toContain(HLS_TEXT.network)
    expect(warn).not.toHaveBeenCalled()
  })

  it('runDownload 里写入失败状态失败时会再写一次，不会停在正在下载', async () => {
    let failedWrites = 0
    const harness = await setup((message) => {
      if (message.type === OFFSCREEN_BRIDGE.SAVE_BLOB) throw new Error('port closed')
      if (message.record?.phase === 'failed') {
        failedWrites += 1
        if (failedWrites === 1) throw new Error('写入任务状态失败')
      }
      return { ok: true }
    })
    const started = await harness.dispatch({
      type: 'HLS_OFFSCREEN_DOWNLOAD',
      playlistUrl: MEDIA,
      mediaUrl: MEDIA,
    })
    expect(started).toEqual({ ok: true })
    await waitFor(() => writes(harness.sent, HLS_JOB_STORAGE_KEY).filter((message) => message.record?.phase === 'failed').length >= 2)
    const failed = writes(harness.sent, HLS_JOB_STORAGE_KEY).filter((message) => message.record?.phase === 'failed')
    expect(failed[0]?.record?.message).toBe('下载失败')
    expect(failed[1]?.record?.message).toBe('下载失败')
    expect(harness.revokeDelays).toEqual([60_000])
  })
})
