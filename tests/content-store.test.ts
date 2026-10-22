/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DOM_SCAN_DEBOUNCE_MS,
  deliverMediaFound,
  startScanner,
  type ScannerHandle,
} from '../src/content/scanner'
import { MESSAGE_TYPE, isMediaFoundMessage } from '../src/shared/messages'
import type { MediaItem } from '../src/shared/types'

/**
 * content script 的 sendMessage 接到 initStore 注册的 onMessage。
 * 消息里不带 tabId，入库用 sender.tab.id，和扩展运行时一样。
 */

const TAB_ID = 4
const FRAME = 'https://example.com/watch'
const T0 = 1_700_000_000_000

interface Listener {
  (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void):
    | boolean
    | undefined
}

interface Harness {
  sent: unknown[]
  outbound: Promise<unknown>[]
  getItems(tabId: number): Promise<MediaItem[]>
}

let handle: ScannerHandle | undefined
let harness: Harness

function installChrome(): { sent: unknown[]; outbound: Promise<unknown>[] } {
  const storage = new Map<string, unknown>()
  const listeners: Listener[] = []
  const sent: unknown[] = []
  const outbound: Promise<unknown>[] = []

  const sendMessage = (message: unknown) => {
    sent.push(message)
    const task = new Promise<unknown>((resolve, reject) => {
      const sender = { tab: { id: TAB_ID } } as chrome.runtime.MessageSender
      let replied = false
      let asyncResponse = false
      const sendResponse = (response?: unknown) => {
        if (replied) return
        replied = true
        resolve(response)
      }
      try {
        for (const listener of listeners) {
          if (listener(message, sender, sendResponse) === true) asyncResponse = true
        }
      } catch (error) {
        reject(error)
        return
      }
      if (!asyncResponse && !replied) resolve(undefined)
    })
    outbound.push(task)
    return task
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
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    webRequest: {
      onBeforeRequest: { addListener() {} },
    },
    runtime: {
      onMessage: {
        addListener(listener: Listener) {
          listeners.push(listener)
        },
      },
      sendMessage,
    },
  }

  ;(globalThis as unknown as { chrome: typeof chrome }).chrome = mock as unknown as typeof chrome
  return { sent, outbound }
}

beforeEach(async () => {
  vi.resetModules()
  const chromeHarness = installChrome()
  const store = await import('../src/background/store')
  store.initStore()
  harness = { ...chromeHarness, getItems: store.getItems }
  await new Promise((resolve) => setTimeout(resolve, 0))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  handle?.stop()
  handle = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('MEDIA_FOUND 从扫描到入库', () => {
  it('消息不带 tabId，store 按 sender.tab.id 存下 currentSrc 和全部 source', async () => {
    const video = document.createElement('video')
    const webm = document.createElement('source')
    webm.src = 'https://cdn.example/clip.webm'
    webm.type = 'video/webm'
    const mp4 = document.createElement('source')
    mp4.src = 'https://cdn.example/clip.mp4'
    mp4.type = 'video/mp4'
    video.append(webm, mp4)
    Object.defineProperty(video, 'currentSrc', {
      configurable: true,
      get: () => 'blob:https://example.com/mse',
    })
    const audio = document.createElement('audio')
    audio.src = 'https://cdn.example/stream?id=1'
    document.body.append(video, audio)

    handle = startScanner({
      document,
      send: deliverMediaFound,
      now: () => T0,
      frameUrl: FRAME,
    })
    await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)
    expect(harness.outbound).toHaveLength(1)
    await harness.outbound[0]

    const sent = harness.sent[0]
    expect(isMediaFoundMessage(sent)).toBe(true)
    if (!isMediaFoundMessage(sent)) return
    expect(Object.keys(sent)).toEqual(['type', 'items'])
    expect(sent).toEqual({
      type: MESSAGE_TYPE.MEDIA_FOUND,
      items: [
        {
          url: 'blob:https://example.com/mse',
          kind: 'video',
          sources: ['dom'],
          downloadable: false,
          note: 'blob 地址，无法直接下载',
          frameUrl: FRAME,
          firstSeen: T0,
        },
        {
          url: 'https://cdn.example/clip.webm',
          kind: 'video',
          ext: 'webm',
          mime: 'video/webm',
          sources: ['dom'],
          downloadable: true,
          frameUrl: FRAME,
          firstSeen: T0,
        },
        {
          url: 'https://cdn.example/clip.mp4',
          kind: 'video',
          ext: 'mp4',
          mime: 'video/mp4',
          sources: ['dom'],
          downloadable: true,
          frameUrl: FRAME,
          firstSeen: T0,
        },
        {
          url: 'https://cdn.example/stream?id=1',
          kind: 'audio',
          sources: ['dom'],
          downloadable: true,
          frameUrl: FRAME,
          firstSeen: T0,
        },
      ],
    })

    expect(await harness.getItems(TAB_ID)).toEqual(sent.items)
    expect(await harness.getItems(1)).toEqual([])

    video.dispatchEvent(new Event('loadedmetadata'))
    await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)
    expect(harness.sent).toHaveLength(1)
    expect(await harness.getItems(TAB_ID)).toHaveLength(sent.items.length)
  })
})
