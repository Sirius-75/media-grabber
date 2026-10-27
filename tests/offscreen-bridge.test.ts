import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HLS_TEXT } from '../src/shared/hls'
import { DASH_JOB_STORAGE_KEY } from '../src/shared/dash-job'
import { HLS_JOB_STORAGE_KEY, type HlsJobMap, type HlsJobRecord } from '../src/shared/hls-job'
import { MESSAGE_TYPE } from '../src/shared/messages'
import { OFFSCREEN_BRIDGE } from '../src/shared/offscreen-bridge'

/**
 * service worker 收到 offscreen 的消息后写会话存储，并调用 downloads.download。
 * 每个用例重新加载模块，避免写入队列串到下一个用例。
 */

interface Harness {
  storage: Map<string, unknown>
  calls: chrome.downloads.DownloadOptions[]
  failWith: Error | undefined
  downloadId: number | undefined
  getDelayMs: number
  offscreenReply: unknown
}

function job(partial: Partial<HlsJobRecord> & Pick<HlsJobRecord, 'phase' | 'message'>): HlsJobRecord {
  return {
    completed: 1,
    total: 2,
    updatedAt: 10,
    ...partial,
  }
}

function installChrome(): Harness {
  const harness: Harness = {
    storage: new Map<string, unknown>(),
    calls: [],
    failWith: undefined,
    downloadId: 4,
    getDelayMs: 0,
    offscreenReply: { ok: true },
  }

  const mock = {
    storage: {
      session: {
        async get(keys?: string | string[] | Record<string, unknown> | null) {
          if (harness.getDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, harness.getDelayMs))
          const result: Record<string, unknown> = {}
          if (keys == null) {
            for (const [key, value] of harness.storage) result[key] = structuredClone(value)
            return result
          }
          const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
          for (const name of names) {
            if (harness.storage.has(name)) result[name] = structuredClone(harness.storage.get(name))
          }
          return result
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) harness.storage.set(key, structuredClone(value))
        },
      },
    },
    downloads: {
      async download(options: chrome.downloads.DownloadOptions) {
        harness.calls.push({ ...options })
        if (harness.failWith) throw harness.failWith
        if (harness.downloadId === undefined) return undefined as unknown as number
        return harness.downloadId
      },
    },
    runtime: {
      sendMessage: async () => harness.offscreenReply,
      onMessage: { addListener() {} },
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
    },
    offscreen: {
      Reason: { BLOBS: 'BLOBS' },
      async hasDocument() {
        return true
      },
      async createDocument() {
        return undefined
      },
    },
  }

  vi.stubGlobal('chrome', mock)
  return harness
}

async function load() {
  vi.resetModules()
  const harness = installChrome()
  const jobs = await import('../src/background/offscreen-jobs')
  const hls = await import('../src/background/hls')
  return { harness, ...jobs, ...hls }
}

function request(
  handle: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => boolean | undefined,
  message: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('后台没有回复')), 4000)
    const handled = handle(message, {} as chrome.runtime.MessageSender, (response) => {
      clearTimeout(timer)
      resolve(response)
    })
    if (handled !== true) {
      clearTimeout(timer)
      resolve(handled)
    }
  })
}

function storedJobs(harness: Harness, key: string): HlsJobMap {
  return (harness.storage.get(key) ?? {}) as HlsJobMap
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('service worker 处理 offscreen 消息', () => {
  it('入口会接上进度和保存文件的监听', () => {
    const source = readFileSync(new URL('../src/background/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('listenForOffscreenJobs()')
  })

  it('串行写入 HLS / DASH 进度，旧序号不能盖住新任务', async () => {
    const { harness, handleOffscreenBridgeMessage } = await load()
    harness.getDelayMs = 20
    const first = request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.WRITE_JOB,
      storageKey: HLS_JOB_STORAGE_KEY,
      key: 'https://cdn.example/a.m3u8',
      record: job({ phase: 'downloading', message: '已下载 1/2', epoch: 2, updatedAt: 2 }),
    })
    const second = request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.WRITE_JOB,
      storageKey: DASH_JOB_STORAGE_KEY,
      key: 'https://cdn.example/b.mpd',
      record: job({ phase: 'downloading', message: '已下载 1/4', epoch: 1, updatedAt: 3 }),
    })
    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ ok: true })
    expect(storedJobs(harness, HLS_JOB_STORAGE_KEY)['https://cdn.example/a.m3u8']?.message).toBe('已下载 1/2')
    expect(storedJobs(harness, DASH_JOB_STORAGE_KEY)['https://cdn.example/b.mpd']?.message).toBe('已下载 1/4')

    const stale = await request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.WRITE_JOB,
      storageKey: HLS_JOB_STORAGE_KEY,
      key: 'https://cdn.example/a.m3u8',
      record: job({ phase: 'downloading', message: '已下载 0/2', epoch: 1, updatedAt: 4 }),
    })
    expect(stale).toEqual({ ok: true })
    expect(storedJobs(harness, HLS_JOB_STORAGE_KEY)['https://cdn.example/a.m3u8']).toMatchObject({
      message: '已下载 1/2',
      epoch: 2,
    })

    await request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.WRITE_JOB,
      storageKey: HLS_JOB_STORAGE_KEY,
      key: 'https://cdn.example/a.m3u8',
      record: job({ phase: 'failed', message: '清晰度不在这个清单里', updatedAt: 5 }),
    })
    expect(storedJobs(harness, HLS_JOB_STORAGE_KEY)['https://cdn.example/a.m3u8']).toMatchObject({
      phase: 'failed',
      epoch: 2,
    })
    const late = await request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.WRITE_JOB,
      storageKey: HLS_JOB_STORAGE_KEY,
      key: 'https://cdn.example/a.m3u8',
      record: job({ phase: 'downloading', message: '已下载 9/9', epoch: 1, updatedAt: 6 }),
    })
    expect(late).toEqual({ ok: true })
    expect(storedJobs(harness, HLS_JOB_STORAGE_KEY)['https://cdn.example/a.m3u8']?.phase).toBe('failed')
  })

  it('取消只改还在进行的阶段，并保留已下载片数', async () => {
    const { harness, handleOffscreenBridgeMessage } = await load()
    harness.storage.set(HLS_JOB_STORAGE_KEY, {
      'https://cdn.example/a.m3u8': job({ phase: 'downloading', message: '已下载 3/8', completed: 3, total: 8 }),
      'https://cdn.example/done.m3u8': job({ phase: 'complete', message: '已完成', completed: 8, total: 8 }),
    })
    const cancelled = await request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.CANCEL_JOB,
      storageKey: HLS_JOB_STORAGE_KEY,
      key: 'https://cdn.example/a.m3u8',
      phases: ['downloading', 'inspecting', 'picking', 'remuxing'],
    })
    expect(cancelled).toEqual({ ok: true })
    expect(storedJobs(harness, HLS_JOB_STORAGE_KEY)['https://cdn.example/a.m3u8']).toMatchObject({
      phase: 'cancelled',
      message: HLS_TEXT.cancelled,
      completed: 3,
      total: 8,
    })
    await request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.CANCEL_JOB,
      storageKey: HLS_JOB_STORAGE_KEY,
      key: 'https://cdn.example/done.m3u8',
      phases: ['downloading', 'inspecting', 'picking', 'remuxing'],
    })
    expect(storedJobs(harness, HLS_JOB_STORAGE_KEY)['https://cdn.example/done.m3u8']?.phase).toBe('complete')
  })

  it('用 blob 地址调用 downloads.download，不传请求头', async () => {
    const { harness, handleOffscreenBridgeMessage } = await load()
    const saved = await request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.SAVE_BLOB,
      url: 'blob:https://offscreen.local/1',
      filename: 'Big Buck Bunny-1.mp4',
      headers: { Referer: 'https://evil.example' },
      saveAs: true,
      conflictAction: 'overwrite',
    })
    expect(saved).toEqual({ ok: true, downloadId: 4 })
    expect(harness.calls).toEqual([
      {
        url: 'blob:https://offscreen.local/1',
        filename: 'Big Buck Bunny-1.mp4',
        saveAs: false,
        conflictAction: 'uniquify',
      },
    ])
    expect(harness.calls[0] && 'headers' in harness.calls[0]).toBe(false)

    const rejected = await request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.SAVE_BLOB,
      url: 'https://cdn.example/file.mp4',
      filename: 'nope.mp4',
    })
    expect(rejected).toEqual({ ok: false, error: '保存文件失败' })
    expect(harness.calls).toHaveLength(1)

    harness.failWith = new Error('FILE_NO_SPACE')
    const failed = await request(handleOffscreenBridgeMessage, {
      type: OFFSCREEN_BRIDGE.SAVE_BLOB,
      url: 'blob:https://offscreen.local/2',
      filename: 'Big Buck Bunny-2.m4a',
    })
    expect(failed).toEqual({ ok: false, error: '磁盘空间不足' })
  })

  it('同步时跳过还在下载的那一条，其余进行中的标成中断', async () => {
    const { harness, handleHlsMessage } = await load()
    const activeKey = 'https://cdn.example/keep.m3u8'
    harness.offscreenReply = { ok: true, activeKey }
    harness.storage.set(HLS_JOB_STORAGE_KEY, {
      [activeKey]: job({ phase: 'downloading', message: '已下载 1/4' }),
      'https://cdn.example/stale.m3u8': job({ phase: 'remuxing', message: '正在转成 mp4…' }),
      'https://cdn.example/done.m3u8': job({ phase: 'complete', message: '已完成', completed: 4, total: 4 }),
    })
    harness.storage.set(DASH_JOB_STORAGE_KEY, {
      'https://cdn.example/stale.mpd': job({ phase: 'downloading', message: '已下载 1/4' }),
    })

    const response = await request(handleHlsMessage, { type: MESSAGE_TYPE.HLS_SYNC })
    expect(response).toEqual({ ok: true })
    expect(storedJobs(harness, HLS_JOB_STORAGE_KEY)[activeKey]?.phase).toBe('downloading')
    expect(storedJobs(harness, HLS_JOB_STORAGE_KEY)['https://cdn.example/stale.m3u8']).toMatchObject({
      phase: 'failed',
      message: HLS_TEXT.interrupted,
    })
    expect(storedJobs(harness, HLS_JOB_STORAGE_KEY)['https://cdn.example/done.m3u8']?.phase).toBe('complete')
    expect(storedJobs(harness, DASH_JOB_STORAGE_KEY)['https://cdn.example/stale.mpd']).toMatchObject({
      phase: 'failed',
      message: HLS_TEXT.interrupted,
    })
    expect(harness.calls).toEqual([])
  })
})
