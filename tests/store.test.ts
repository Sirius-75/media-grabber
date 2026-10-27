import type { MediaItem, MediaItemDraft } from '../src/shared/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE } from '../src/shared/messages'

/**
 * 用内存里的 chrome.storage.session / tabs / runtime / action 代替浏览器。
 * 每个用例重新加载 store 模块，避免导航记忆和监听串到下一个用例。
 */

interface ListenerEvent<A extends unknown[]> {
  addListener(listener: (...args: A) => unknown): void
  dispatch(...args: A): void
  readonly size: number
  readonly listeners: Array<(...args: A) => unknown>
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
    listeners,
  }
}

interface BeforeRequestListener {
  addListener(
    listener: (details: chrome.webRequest.OnBeforeRequestDetails) => unknown,
    filter?: chrome.webRequest.RequestFilter,
    extra?: string[],
  ): void
  dispatch(details: chrome.webRequest.OnBeforeRequestDetails): unknown
  readonly size: number
  filter?: chrome.webRequest.RequestFilter
  extra?: string[]
}

interface Harness {
  storage: Map<string, unknown>
  badges: Map<number, string>
  badgeColors: Map<number, string>
  removed: ListenerEvent<[number, chrome.tabs.OnRemovedInfo]>
  updated: ListenerEvent<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>
  messages: ListenerEvent<
    [unknown, chrome.runtime.MessageSender, (response?: unknown) => void]
  >
  beforeRequest: BeforeRequestListener
}

function installChrome(): Harness {
  const storage = new Map<string, unknown>()
  const badges = new Map<number, string>()
  const badgeColors = new Map<number, string>()
  const removed = createEvent<[number, chrome.tabs.OnRemovedInfo]>()
  const updated = createEvent<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>()
  const messages = createEvent<
    [unknown, chrome.runtime.MessageSender, (response?: unknown) => void]
  >()
  const requests = createEvent<[chrome.webRequest.OnBeforeRequestDetails]>()
  const beforeRequest: BeforeRequestListener = {
    addListener(listener, filter, extra) {
      requests.addListener(listener)
      beforeRequest.filter = filter
      beforeRequest.extra = extra
    },
    dispatch(details) {
      let result: unknown
      for (const listener of requests.listeners) result = listener(details)
      return result
    },
    get size() {
      return requests.size
    },
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
          const names =
            typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
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
    },
    action: {
      setBadgeText(details: { text?: string; tabId?: number }) {
        badges.set(details.tabId ?? -1, details.text ?? '')
        return Promise.resolve()
      },
      setBadgeBackgroundColor(details: { color: string; tabId?: number }) {
        badgeColors.set(details.tabId ?? -1, details.color)
        return Promise.resolve()
      },
      setBadgeTextColor() {
        return Promise.resolve()
      },
    },
    tabs: { onRemoved: removed, onUpdated: updated },
    runtime: { onMessage: messages },
    webRequest: { onBeforeRequest: beforeRequest },
  }

  ;(globalThis as unknown as { chrome: typeof chrome }).chrome = mock as unknown as typeof chrome
  return { storage, badges, badgeColors, removed, updated, messages, beforeRequest }
}

async function loadStore() {
  vi.resetModules()
  const harness = installChrome()
  const store = await import('../src/background/store')
  const blocklist = await import('../src/shared/blocklist')
  return { ...harness, ...store, blocklist }
}

type Context = Awaited<ReturnType<typeof loadStore>>

let ctx: Context

afterEach(() => {
  vi.restoreAllMocks()
})

async function setup(): Promise<Context> {
  ctx = await loadStore()
  ctx.initStore()
  return ctx
}

function draft(url: string, extra: Partial<MediaItemDraft> = {}): MediaItemDraft {
  return { url, sources: ['network'], ...extra }
}

function page(url: string, pendingUrl?: string): chrome.tabs.Tab {
  return { url, pendingUrl } as chrome.tabs.Tab
}

function request(
  tabId: number,
  type: 'main_frame' | 'sub_frame',
  url: string,
): chrome.webRequest.OnBeforeRequestDetails {
  return {
    url,
    tabId,
    type,
    method: 'GET',
    frameId: type === 'main_frame' ? 0 : 1,
    parentFrameId: type === 'main_frame' ? -1 : 0,
    requestId: `${type}-${url}`,
    timeStamp: 1,
  } as chrome.webRequest.OnBeforeRequestDetails
}

function urlsOf(items: MediaItem[]): string[] {
  return items.map((item) => item.url)
}

/** 等消息监听里的 sendResponse。存储读写都是微任务，一个宏任务足够排空。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('去重与合并', () => {
  it('同一 URL 只留一条，hash 和主机名大小写不算不同资源', async () => {
    const { addItems, getItems } = await setup()
    await addItems(1, [
      draft('https://CDN.Example/a.mp4#t=1', { sources: ['dom', 'dom'], firstSeen: 10 }),
    ])
    const items = await addItems(1, [
      draft('https://cdn.example/a.mp4', { sources: ['network', 'dom'], size: 2048, firstSeen: 30 }),
    ])

    expect(items).toHaveLength(1)
    expect(await getItems(1)).toEqual([
      {
        url: 'https://cdn.example/a.mp4',
        kind: 'video',
        ext: 'mp4',
        size: 2048,
        sources: ['dom', 'network'],
        downloadable: true,
        firstSeen: 10,
      },
    ])
  })

  it('query 不同视为不同资源，后到的字段只补空缺', async () => {
    const { addMedia, getItems } = await setup()
    await addMedia(1, draft('https://cdn.example/file?x=1', { kind: 'audio', downloadable: false, firstSeen: 5 }))
    await addMedia(
      1,
      draft('https://cdn.example/file?x=1#t=2', {
        kind: 'video',
        ext: 'mp3',
        mime: 'Audio/MPEG; charset=binary',
        size: 9,
        note: '后来的说明',
        frameUrl: ' https://example.com/frame ',
        sources: ['dom'],
        downloadable: true,
        firstSeen: 1,
      }),
    )
    await addMedia(1, draft('https://cdn.example/file.mp4?x=2', { size: 3, firstSeen: 8 }))

    const items = await getItems(1)
    expect(urlsOf(items)).toEqual([
      'https://cdn.example/file?x=1',
      'https://cdn.example/file.mp4?x=2',
    ])
    expect(items[0]).toEqual({
      url: 'https://cdn.example/file?x=1',
      kind: 'audio',
      ext: 'mp3',
      mime: 'audio/mpeg',
      size: 9,
      note: '后来的说明',
      frameUrl: 'https://example.com/frame',
      sources: ['network', 'dom'],
      downloadable: false,
      firstSeen: 1,
    })
    expect(items[1]).toMatchObject({ kind: 'video', ext: 'mp4', size: 3, downloadable: true })
  })

  it('已有的 size 不被后来的值覆盖，0 也算已经拿到', async () => {
    const { addItems, getItems } = await setup()
    await addItems(1, [draft('https://cdn.example/a.mp4', { size: 0, firstSeen: 1 })])
    await addItems(1, [draft('https://cdn.example/a.mp4', { size: 99, mime: 'video/mp4' })])
    const [item] = await getItems(1)
    expect(item.size).toBe(0)
    expect(item.mime).toBe('video/mp4')
  })

  it('负数大小会忽略，下一次有效大小仍能补上', async () => {
    const { addItems, getItems } = await setup()
    await addItems(1, [draft('https://cdn.example/a.mp4', { size: -1 })])
    expect((await getItems(1))[0].size).toBeUndefined()
    await addItems(1, [draft('https://cdn.example/a.mp4', { size: 12 })])
    expect((await getItems(1))[0].size).toBe(12)
  })

  it('fillMediaSize 只补已有条目，不新建，也不覆盖', async () => {
    const { addMedia, fillMediaSize, getItems, badges } = await setup()
    await addMedia(1, draft('https://cdn.example/a.mp4'))
    expect(badges.get(1)).toBe('1')
    expect(await fillMediaSize(1, 'https://cdn.example/a.mp4#t=1', 42)).toBe(true)
    expect(await fillMediaSize(1, 'https://cdn.example/a.mp4', 99)).toBe(false)
    expect(await fillMediaSize(1, 'https://cdn.example/missing.mp4', 5)).toBe(false)
    expect(await fillMediaSize(1, 'https://cdn.example/a.mp4', Number.NaN)).toBe(false)
    const items = await getItems(1)
    expect(items).toHaveLength(1)
    expect(items[0].size).toBe(42)
    expect(badges.get(1)).toBe('1')
  })

  it('并发写入同一个 URL 不会互相覆盖', async () => {
    const { addMedia, getItems } = await setup()
    await Promise.all([
      addMedia(1, draft('https://cdn.example/a.mp4', { sources: ['dom'] })),
      addMedia(1, draft('https://cdn.example/a.mp4#t=1', { sources: ['network'], size: 10 })),
    ])
    const items = await getItems(1)
    expect(items).toHaveLength(1)
    expect(items[0].sources).toEqual(['dom', 'network'])
    expect(items[0].size).toBe(10)
  })

  it('判断不出种类的地址、空地址和别的 tab 互不影响', async () => {
    const { addItems, getItems, badges } = await setup()
    await addItems(1, [
      draft('https://cdn.example/note.txt'),
      draft('   '),
      draft('https://cdn.example/a.mp4'),
    ])
    await addItems(2, [draft('https://cdn.example/b.mp3', { firstSeen: 2 })])
    expect(urlsOf(await getItems(1))).toEqual(['https://cdn.example/a.mp4'])
    expect(await getItems(2)).toMatchObject([{ url: 'https://cdn.example/b.mp3', kind: 'audio' }])
    expect(badges.get(1)).toBe('1')
    expect(badges.get(2)).toBe('1')
    expect(await getItems(-1)).toEqual([])
    expect(await addItems(1.5, [draft('https://cdn.example/c.mp4')])).toEqual([])
  })

  it('HLS 地址不可下载，并带上清单说明', async () => {
    const { addMedia, getItems } = await setup()
    await addMedia(3, draft('https://cdn.example/a.m3u8'))
    expect(await getItems(3)).toMatchObject([
      {
        kind: 'hls',
        ext: 'm3u8',
        downloadable: false,
        note: 'HLS 清单，可下载未加密的点播',
      },
    ])
  })
})

describe('200 条上限', () => {
  it('刚好 200 条都保留，再来新 URL 丢掉最早写入的', async () => {
    const { addItems, getItems, badges, MAX_ITEMS_PER_TAB } = await setup()
    expect(MAX_ITEMS_PER_TAB).toBe(200)
    const firstBatch = Array.from({ length: MAX_ITEMS_PER_TAB }, (_, index) =>
      draft(`https://cdn.example/f/${index}.mp4`, { firstSeen: index + 1 }),
    )
    await addItems(1, firstBatch)
    expect(urlsOf(await getItems(1))[0]).toBe('https://cdn.example/f/0.mp4')

    await addItems(1, [draft('https://cdn.example/f/200.mp4', { firstSeen: 1 })])
    const urls = urlsOf(await getItems(1))
    expect(urls).toHaveLength(200)
    expect(urls[0]).toBe('https://cdn.example/f/1.mp4')
    expect(urls.at(-1)).toBe('https://cdn.example/f/200.mp4')
    expect(urls).not.toContain('https://cdn.example/f/0.mp4')
    expect(badges.get(1)).toBe('200')
  })

  it('达到上限后再次合并最早的那条，不会把它挤掉', async () => {
    const { addItems, getItems, MAX_ITEMS_PER_TAB } = await setup()
    const firstBatch = Array.from({ length: MAX_ITEMS_PER_TAB }, (_, index) =>
      draft(`https://cdn.example/f/${index}.mp4`),
    )
    await addItems(1, firstBatch)
    await addItems(1, [draft('https://cdn.example/f/0.mp4', { size: 7, sources: ['dom'] })])
    const items = await getItems(1)
    expect(items).toHaveLength(200)
    expect(items[0].url).toBe('https://cdn.example/f/0.mp4')
    expect(items[0].size).toBe(7)
    expect(items[0].sources).toEqual(['network', 'dom'])
  })
})

describe('清理', () => {
  async function seed(tabId: number, url = 'https://cdn.example/a.mp4'): Promise<void> {
    await ctx.addMedia(tabId, draft(url, { firstSeen: 1 }))
  }

  it('clearTab 删掉 session 里的列表并隐藏角标', async () => {
    const { clearTab, getItems, badges, storage } = await setup()
    await seed(1)
    expect(storage.has('tab:1')).toBe(true)
    await clearTab(1)
    expect(await getItems(1)).toEqual([])
    expect(storage.has('tab:1')).toBe(false)
    expect(badges.get(1)).toBe('')
    expect(badges.has(-1)).toBe(false)
  })

  it('关闭标签页时清掉该 tab', async () => {
    const { removed, getItems, storage } = await setup()
    await seed(1)
    await seed(2)
    removed.dispatch(1, { windowId: 1, isWindowClosing: false })
    expect(await getItems(1)).toEqual([])
    expect(storage.has('tab:1')).toBe(false)
    expect(await getItems(2)).toHaveLength(1)
  })

  it('顶层进入 loading（含刷新和跳转）时清空，SPA 和标题变化不清空', async () => {
    const { updated, addMedia, getItems } = await setup()
    const tabId = 4
    const start = 'https://example.com/watch'
    updated.dispatch(tabId, { status: 'loading', url: start }, page(start))
    await getItems(tabId)
    await addMedia(tabId, draft('https://cdn.example/a.mp4'))

    // 同一轮加载里再来一次 loading，不能把刚收来的条目清掉。
    updated.dispatch(tabId, { status: 'loading' }, page(start))
    expect(await getItems(tabId)).toHaveLength(1)

    updated.dispatch(tabId, { status: 'complete' }, page(start))
    await getItems(tabId)
    updated.dispatch(tabId, { url: 'https://example.com/watch/2' }, page('https://example.com/watch/2'))
    updated.dispatch(tabId, { title: '新标题' }, page('https://example.com/watch/2'))
    expect(await getItems(tabId)).toHaveLength(1)

    // 刷新：status 回到 loading，URL 可以不变。
    updated.dispatch(tabId, { status: 'loading' }, page(start))
    expect(await getItems(tabId)).toEqual([])

    await addMedia(tabId, draft('https://cdn.example/b.mp4'))
    updated.dispatch(tabId, { status: 'complete' }, page(start))
    await getItems(tabId)
    updated.dispatch(
      tabId,
      { status: 'loading', url: 'https://example.com/other' },
      page('https://example.com/other'),
    )
    expect(await getItems(tabId)).toEqual([])
  })

  it('加载过程中的跳转（pendingUrl 变了）会再清一次', async () => {
    const { updated, addMedia, getItems } = await setup()
    const tabId = 5
    updated.dispatch(tabId, { status: 'loading', url: 'https://example.com/a' }, page('https://example.com/a'))
    await getItems(tabId)
    await addMedia(tabId, draft('https://cdn.example/a.mp4'))
    updated.dispatch(
      tabId,
      { status: 'loading' },
      page('https://example.com/a', 'https://example.com/b'),
    )
    expect(await getItems(tabId)).toEqual([])
  })

  it('顶层文档请求比 loading 更早清空，之后嗅探到的条目不会被提交阶段的 loading 删掉', async () => {
    const { beforeRequest, updated, addMedia, getItems } = await setup()
    const tabId = 9
    const pageUrl = 'https://example.com/watch'
    await addMedia(tabId, draft('https://cdn.example/old.mp4'))

    expect(beforeRequest.filter).toEqual({ urls: ['<all_urls>'], types: ['main_frame'] })
    expect(beforeRequest.extra).toBeUndefined()

    const cleared = beforeRequest.dispatch(request(tabId, 'main_frame', pageUrl))
    expect(cleared).toBeUndefined()
    expect(await getItems(tabId)).toEqual([])

    // 新页面的媒体响应头先到，随后 tabs.onUpdated 才带上提交后的 URL。
    await addMedia(tabId, draft('https://cdn.example/flower.mp4', { size: 100 }))
    updated.dispatch(tabId, { status: 'loading', url: pageUrl }, page(pageUrl))
    updated.dispatch(
      tabId,
      { status: 'loading' },
      page(pageUrl, 'https://example.com/watch/'),
    )
    expect(urlsOf(await getItems(tabId))).toEqual(['https://cdn.example/flower.mp4'])

    // 子框架和扩展自己的请求（tabId < 0）不能把顶层列表清掉。
    beforeRequest.dispatch(request(tabId, 'sub_frame', 'https://embed.example/player'))
    beforeRequest.dispatch(request(-1, 'main_frame', 'https://cdn.example/other.mp4'))
    expect(urlsOf(await getItems(tabId))).toEqual(['https://cdn.example/flower.mp4'])

    // 这一轮结束后，没有 webRequest 的 loading 仍然会清空。
    updated.dispatch(tabId, { status: 'complete' }, page(pageUrl))
    await getItems(tabId)
    updated.dispatch(tabId, { status: 'loading', url: pageUrl }, page(pageUrl))
    expect(await getItems(tabId)).toEqual([])
  })

  it('initStore 重复调用不会注册两套监听', async () => {
    const current = await setup()
    const removedBefore = current.removed.size
    const updatedBefore = current.updated.size
    const messagesBefore = current.messages.size
    const requestsBefore = current.beforeRequest.size
    current.initStore()
    expect(current.removed.size).toBe(removedBefore)
    expect(current.updated.size).toBe(updatedBefore)
    expect(current.messages.size).toBe(messagesBefore)
    expect(current.beforeRequest.size).toBe(requestsBefore)
    expect(removedBefore).toBe(1)
    expect(requestsBefore).toBe(1)
  })
})

describe('黑名单', () => {
  it('存储入口忽略被屏蔽的域名及其子域名', async () => {
    const { addItems, getItems, badges, blocklist } = await setup()
    expect(blocklist.BLOCKED_DOMAINS).toEqual([])
    blocklist.BLOCKED_DOMAINS.push('ads.example')
    await addItems(1, [
      draft('https://ads.example/a.mp4'),
      draft('https://CDN.Ads.Example/b.mp4#t=1'),
      draft('https://cdn.example/ok.mp4'),
      draft('https://ads.example.evil.test/c.mp4'),
    ])
    expect(urlsOf(await getItems(1))).toEqual([
      'https://cdn.example/ok.mp4',
      'https://ads.example.evil.test/c.mp4',
    ])
    expect(badges.get(1)).toBe('2')
  })

  it('屏蔽之后不再补全已经存在的条目', async () => {
    const { addItems, fillMediaSize, getItems, blocklist } = await setup()
    await addItems(1, [draft('https://cdn.example/a.mp4', { firstSeen: 4 })])
    blocklist.BLOCKED_DOMAINS.push('cdn.example')
    await addItems(1, [draft('https://cdn.example/a.mp4', { size: 100, sources: ['dom'] })])
    expect(await fillMediaSize(1, 'https://cdn.example/a.mp4', 100)).toBe(false)
    const [item] = await getItems(1)
    expect(item.size).toBeUndefined()
    expect(item.sources).toEqual(['network'])
  })
})

describe('消息', () => {
  it('GET_MEDIA 返回该 tab 的列表，CLEAR_MEDIA 清空', async () => {
    const { messages, addMedia, getItems, storage } = await setup()
    await addMedia(1, draft('https://cdn.example/a.mp4', { firstSeen: 2 }))
    const listener = messages.listeners[0]
    let response: unknown
    const pending = listener({ type: MESSAGE_TYPE.GET_MEDIA, tabId: 1 }, {}, (value) => {
      response = value
    })
    expect(pending).toBe(true)
    await settle()
    expect(response).toMatchObject([{ url: 'https://cdn.example/a.mp4', kind: 'video' }])

    response = '未回复'
    listener({ type: MESSAGE_TYPE.CLEAR_MEDIA, tabId: 1 }, {}, (value) => {
      response = value
    })
    await settle()
    expect(response).toBeUndefined()
    expect(await getItems(1)).toEqual([])
    expect(storage.has('tab:1')).toBe(false)
  })

  it('MEDIA_FOUND 用 sender.tab.id 入库，没有 tab 或 DOWNLOAD 消息则不动存储', async () => {
    const { messages, getItems } = await setup()
    const listener = messages.listeners[0]
    const handled = listener(
      { type: MESSAGE_TYPE.MEDIA_FOUND, items: [draft('https://cdn.example/from-dom.mp4')] },
      { tab: { id: 8 } as chrome.tabs.Tab },
      () => undefined,
    )
    expect(handled).toBe(true)
    expect(await getItems(8)).toMatchObject([{ url: 'https://cdn.example/from-dom.mp4', kind: 'video' }])

    listener(
      { type: MESSAGE_TYPE.MEDIA_FOUND, items: [draft('https://cdn.example/ignored.mp4')] },
      {},
      () => undefined,
    )
    listener(
      { type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/a.mp4' },
      { tab: { id: 8 } as chrome.tabs.Tab },
      () => undefined,
    )
    await settle()
    expect(urlsOf(await getItems(8))).toEqual(['https://cdn.example/from-dom.mp4'])
  })
})

describe('持久化', () => {
  it('列表只放在 storage.session，返回值改了也不会写回去', async () => {
    const { addItems, getItems } = await setup()
    await addItems(1, [draft('https://cdn.example/a.mp4', { sources: ['network'], firstSeen: 1 })])
    const stored = (await chrome.storage.session.get('tab:1')) as { 'tab:1': MediaItem[] }
    expect(stored['tab:1']).toHaveLength(1)

    const items = await getItems(1)
    items[0].sources.push('dom')
    items.pop()
    expect(await getItems(1)).toHaveLength(1)
    expect((await getItems(1))[0].sources).toEqual(['network'])

    await chrome.storage.session.set({ 'tab:1': [] })
    expect(await getItems(1)).toEqual([])
  })

  it('重新加载模块后仍能读到 session 里的数据', async () => {
    const { addMedia } = await setup()
    await addMedia(1, draft('https://cdn.example/a.mp4'))
    vi.resetModules()
    const reloaded = await import('../src/background/store')
    expect(await reloaded.getItems(1)).toMatchObject([{ url: 'https://cdn.example/a.mp4' }])
  })

  it('initStore 按 session 里已有的列表恢复角标', async () => {
    const current = await loadStore()
    const stored: MediaItem = {
      url: 'https://cdn.example/a.mp4',
      kind: 'video',
      ext: 'mp4',
      sources: ['network'],
      downloadable: true,
      firstSeen: 1,
    }
    await chrome.storage.session.set({ 'tab:4': [stored], 'nav:4': { loading: true } })
    current.initStore()
    await vi.waitFor(() => {
      expect(current.badges.get(4)).toBe('1')
    })
    expect(current.badgeColors.get(4)).toBeTruthy()
    expect(current.badges.has(-1)).toBe(false)
    expect(await current.getItems(4)).toEqual([stored])
  })

  it('session 里的坏数据当成空列表', async () => {
    const { getItems, badges } = await setup()
    await chrome.storage.session.set({
      'tab:6': { nope: true },
      'tab:7': [null, { url: 'https://cdn.example/a.mp4' }, 'x'],
    })
    expect(await getItems(6)).toEqual([])
    expect(await getItems(7)).toEqual([])
    expect(badges.has(6)).toBe(false)
  })
})
