import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaItemDraft } from '../src/shared/types'
import { MESSAGE_TYPE } from '../src/shared/messages'
import { DOWNLOAD_STATUS_STORAGE_KEY } from '../src/shared/download-status'

/**
 * 用内存里的 chrome.downloads / storage / tabs 代替浏览器。
 * 每个用例重新加载模块，避免下载队列和监听串到下一个用例。
 */

interface ListenerEvent<A extends unknown[]> {
  addListener(listener: (...args: A) => unknown): void
  dispatch(...args: A): void
  readonly size: number
}

function createEvent<A extends unknown[]>(): ListenerEvent<A> {
  const listeners: Array<(...args: A) => unknown> = []
  return {
    addListener(listener) {
      if (!listeners.includes(listener)) listeners.push(listener)
    },
    dispatch(...args) {
      for (const listener of [...listeners]) listener(...args)
    },
    get size() {
      return listeners.length
    },
  }
}

interface DownloadCall {
  options: chrome.downloads.DownloadOptions
}

interface Harness {
  storage: Map<string, unknown>
  tabs: Map<number, chrome.tabs.Tab>
  calls: DownloadCall[]
  changed: ListenerEvent<[chrome.downloads.DownloadDelta]>
  messages: ListenerEvent<[unknown, chrome.runtime.MessageSender, (response?: unknown) => void]>
  records: chrome.downloads.DownloadItem[]
  failWith: Error | undefined
  nextId: number
}

function installChrome(): Harness {
  const storage = new Map<string, unknown>()
  const tabs = new Map<number, chrome.tabs.Tab>()
  const calls: DownloadCall[] = []
  const changed = createEvent<[chrome.downloads.DownloadDelta]>()
  const messages = createEvent<[unknown, chrome.runtime.MessageSender, (response?: unknown) => void]>()
  const records: chrome.downloads.DownloadItem[] = []
  const harness: Harness = {
    storage,
    tabs,
    calls,
    changed,
    messages,
    records,
    failWith: undefined,
    nextId: 7,
  }

  const mock = {
    storage: {
      session: {
        get(keys?: string | string[] | Record<string, unknown> | null) {
          const result: Record<string, unknown> = {}
          if (keys == null) {
            for (const [key, value] of storage) result[key] = structuredClone(value)
            return Promise.resolve(result)
          }
          const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
          for (const name of names) {
            if (storage.has(name)) result[name] = structuredClone(storage.get(name))
          }
          return Promise.resolve(result)
        },
        set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) storage.set(key, structuredClone(value))
          return Promise.resolve()
        },
        remove(keys: string | string[]) {
          const names = typeof keys === 'string' ? [keys] : keys
          for (const name of names) storage.delete(name)
          return Promise.resolve()
        },
      },
      onChanged: createEvent<[Record<string, chrome.storage.StorageChange>, string]>(),
    },
    tabs: {
      async get(id: number) {
        const tab = tabs.get(id)
        if (!tab) throw new Error('no tab')
        return tab
      },
      async query() {
        return [...tabs.values()]
      },
      onRemoved: createEvent<[number]>(),
      onUpdated: createEvent<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>(),
    },
    runtime: {
      lastError: undefined as chrome.runtime.LastError | undefined,
      onMessage: messages,
    },
    downloads: {
      async download(options: chrome.downloads.DownloadOptions) {
        calls.push({ options })
        if (harness.failWith) throw harness.failWith
        return harness.nextId
      },
      async search(query: chrome.downloads.DownloadQuery) {
        return records.filter((item) => query.id === undefined || item.id === query.id)
      },
      onChanged: changed,
    },
    action: {
      setBadgeText() {
        return Promise.resolve()
      },
      setBadgeBackgroundColor() {
        return Promise.resolve()
      },
      setBadgeTextColor() {
        return Promise.resolve()
      },
    },
    webRequest: {
      onBeforeRequest: { addListener() {} },
    },
  }

  ;(globalThis as unknown as { chrome: typeof chrome }).chrome = mock as unknown as typeof chrome
  return harness
}

async function setup() {
  vi.resetModules()
  const harness = installChrome()
  const store = await import('../src/background/store')
  const download = await import('../src/background/download')
  // 挂回同一个 harness，测试里改 failWith / nextId 才能被 download() 看到。
  return Object.assign(harness, store, download)
}

afterEach(() => {
  vi.restoreAllMocks()
})

function draft(url: string, extra: Partial<MediaItemDraft> = {}): MediaItemDraft {
  return { url, sources: ['network'], ...extra }
}

function request(
  handle: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => boolean | undefined,
  message: unknown,
): Promise<unknown> {
  return new Promise((resolve) => {
    const handled = handle(message, {} as chrome.runtime.MessageSender, resolve)
    if (handled !== true) resolve(handled)
  })
}

async function statusesOf(): Promise<Record<string, { message?: string; phase?: string; downloadId?: number }>> {
  const data = (await chrome.storage.session.get(DOWNLOAD_STATUS_STORAGE_KEY)) as Record<string, unknown>
  return (data[DOWNLOAD_STATUS_STORAGE_KEY] ?? {}) as Record<
    string,
    { message?: string; phase?: string; downloadId?: number }
  >
}

describe('DOWNLOAD', () => {
  it('直链用 chrome.downloads.download，不传请求头，重名交给 uniquify', async () => {
    const { addMedia, handleDownloadMessage, tabs, calls } = await setup()
    await addMedia(3, draft('https://cdn.example/videos/clip.mp4'))
    tabs.set(3, { id: 3, title: '直播/:*?"<>|\\回放' } as chrome.tabs.Tab)

    const response = await request(handleDownloadMessage, {
      type: MESSAGE_TYPE.DOWNLOAD,
      url: 'https://cdn.example/videos/clip.mp4#t=1',
      tabId: 3,
    })

    expect(response).toEqual({ ok: true, downloadId: 7 })
    expect(calls).toHaveLength(1)
    expect(calls[0].options).toEqual({
      url: 'https://cdn.example/videos/clip.mp4',
      filename: '直播回放-1.mp4',
      saveAs: false,
      conflictAction: 'uniquify',
    })
    expect(calls[0].options).not.toHaveProperty('headers')
    expect(calls[0].options).not.toHaveProperty('method')
    expect(calls[0].options).not.toHaveProperty('body')
    const stored = await statusesOf()
    expect(stored['https://cdn.example/videos/clip.mp4']).toMatchObject({
      phase: 'started',
      message: '已开始下载',
      downloadId: 7,
    })
  })

  it('标题不可用时用 URL 文件名，并避开保留名', async () => {
    const { addMedia, handleDownloadMessage, tabs, calls } = await setup()
    await addMedia(2, draft('https://cdn.example/audio/NUL.mp3'))
    tabs.set(2, { id: 2, title: '***' } as chrome.tabs.Tab)

    const response = await request(handleDownloadMessage, {
      type: MESSAGE_TYPE.DOWNLOAD,
      url: 'https://cdn.example/audio/NUL.mp3',
      tabId: 2,
    })

    expect(response).toMatchObject({ ok: true })
    expect(calls[0].options.filename).toBe('NUL_.mp3')
    expect(calls[0].options.conflictAction).toBe('uniquify')
  })

  it('消息里的 filename 也会清洗，但不覆盖扩展名', async () => {
    const { addMedia, handleDownloadMessage, tabs, calls } = await setup()
    await addMedia(1, draft('https://cdn.example/a.mp4'))
    tabs.set(1, { id: 1, title: '页面' } as chrome.tabs.Tab)

    await request(handleDownloadMessage, {
      type: MESSAGE_TYPE.DOWNLOAD,
      url: 'https://cdn.example/a.mp4',
      tabId: 1,
      filename: 'dir\\a:b?.webm',
    })

    expect(calls[0].options.filename).toBe('ab.mp4')
  })

  it('不在列表里的直链仍可下载，序号只在列表里的标题上出现', async () => {
    const { handleDownloadMessage, tabs, calls } = await setup()
    tabs.set(8, { id: 8, title: '页面' } as chrome.tabs.Tab)

    const response = await request(handleDownloadMessage, {
      type: MESSAGE_TYPE.DOWNLOAD,
      url: 'https://cdn.example/a.mp4',
    })

    expect(response).toMatchObject({ ok: true })
    expect(calls[0].options.filename).toBe('页面.mp4')
  })

  it('HLS、DASH、blob、data 和 downloadable 为 false 直接拒绝', async () => {
    const ctx = await setup()
    await ctx.addMedia(1, draft('https://cdn.example/locked.mp4', { downloadable: false, note: '需要登录才能下载' }))
    ctx.tabs.set(1, { id: 1, title: '页面' } as chrome.tabs.Tab)

    const cases: Array<{ message: unknown; error: string }> = [
      {
        message: { type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/live/index.m3u8', tabId: 1 },
        error: 'HLS 清单不能当直链保存，请用列表里的下载',
      },
      {
        message: { type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/manifest.mpd', tabId: 1 },
        error: 'DASH 清单，仅支持复制链接',
      },
      {
        message: { type: MESSAGE_TYPE.DOWNLOAD, url: 'blob:https://example.com/1', tabId: 1 },
        error: 'blob 地址，无法直接下载',
      },
      {
        message: { type: MESSAGE_TYPE.DOWNLOAD, url: 'data:video/mp4;base64,AAAA', tabId: 1 },
        error: 'data 地址，无法直接下载',
      },
      {
        message: { type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/locked.mp4', tabId: 1 },
        error: '需要登录才能下载',
      },
    ]

    for (const entry of cases) {
      const response = await request(ctx.handleDownloadMessage, entry.message)
      expect(response).toEqual({ ok: false, error: entry.error })
    }
    expect(ctx.calls).toHaveLength(0)

    const ignored = ctx.handleDownloadMessage(
      { type: MESSAGE_TYPE.GET_MEDIA, tabId: 1 },
      {} as chrome.runtime.MessageSender,
      () => undefined,
    )
    expect(ignored).toBeUndefined()
  })

  it('download() 抛出的 SERVER_FORBIDDEN 记成中文原因', async () => {
    const ctx = await setup()
    await ctx.addMedia(1, draft('https://cdn.example/a.mp4'))
    ctx.tabs.set(1, { id: 1, title: '页面' } as chrome.tabs.Tab)
    ctx.failWith = new Error('SERVER_FORBIDDEN')

    const response = await request(ctx.handleDownloadMessage, {
      type: MESSAGE_TYPE.DOWNLOAD,
      url: 'https://cdn.example/a.mp4',
      tabId: 1,
    })

    expect(response).toEqual({ ok: false, error: '服务器拒绝访问（403）' })
    const stored = await statusesOf()
    expect(stored['https://cdn.example/a.mp4']?.message).toBe('服务器拒绝访问（403）')
  })
})

describe('downloads.onChanged', () => {
  it('403 和网络失败写回中文原因，完成后写已完成', async () => {
    const ctx = await setup()
    await ctx.addMedia(3, draft('https://cdn.example/videos/clip.mp4'))
    ctx.tabs.set(3, { id: 3, title: '片段' } as chrome.tabs.Tab)
    ctx.listenForDownload()
    ctx.listenForDownload()
    expect(ctx.changed.size).toBe(1)

    await request(ctx.handleDownloadMessage, {
      type: MESSAGE_TYPE.DOWNLOAD,
      url: 'https://cdn.example/videos/clip.mp4',
      tabId: 3,
    })

    ctx.changed.dispatch({
      id: 7,
      state: { current: 'interrupted', previous: 'in_progress' },
      error: { current: 'SERVER_FORBIDDEN', previous: '' },
    })
    await vi.waitFor(async () => {
      const stored = await statusesOf()
      expect(stored['https://cdn.example/videos/clip.mp4']).toMatchObject({
        phase: 'failed',
        message: '服务器拒绝访问（403）',
      })
    })

    ctx.changed.dispatch({
      id: 7,
      error: { current: 'NETWORK_FAILED' },
    })
    await vi.waitFor(async () => {
      const stored = await statusesOf()
      expect(stored['https://cdn.example/videos/clip.mp4']?.message).toBe('网络连接失败')
    })

    ctx.nextId = 8
    await request(ctx.handleDownloadMessage, {
      type: MESSAGE_TYPE.DOWNLOAD,
      url: 'https://cdn.example/videos/clip.mp4',
      tabId: 3,
    })
    ctx.changed.dispatch({
      id: 8,
      state: { current: 'complete', previous: 'in_progress' },
    })
    await vi.waitFor(async () => {
      const stored = await statusesOf()
      expect(stored['https://cdn.example/videos/clip.mp4']).toMatchObject({
        phase: 'complete',
        message: '已完成',
        downloadId: 8,
      })
    })

    const before = structuredClone(await statusesOf())
    ctx.changed.dispatch({
      id: 99,
      state: { current: 'interrupted' },
      error: { current: 'NETWORK_FAILED' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await statusesOf()).toEqual(before)
  })

  it('service worker 重新起来后，能把已经完成的下载对上', async () => {
    const ctx = await setup()
    await chrome.storage.session.set({
      [DOWNLOAD_STATUS_STORAGE_KEY]: {
        'https://cdn.example/a.mp4': {
          phase: 'started',
          message: '已开始下载',
          downloadId: 4,
          updatedAt: 1,
        },
      },
    })
    ctx.records.push({ id: 4, state: 'complete' } as chrome.downloads.DownloadItem)
    ctx.listenForDownload()
    await vi.waitFor(async () => {
      const stored = await statusesOf()
      expect(stored['https://cdn.example/a.mp4']).toMatchObject({
        phase: 'complete',
        message: '已完成',
      })
    })
  })
})
