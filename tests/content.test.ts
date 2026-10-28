/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE, isMediaFoundMessage } from '../src/shared/messages'
import type { MediaItemDraft, MediaKind } from '../src/shared/types'
import {
  DOM_SCAN_DEBOUNCE_MS,
  deliverMediaFound,
  startScanner,
  whenDocumentElementReady,
  type ScannerHandle,
} from '../src/content/scanner'

const FRAME = 'https://example.com/page'
const T0 = 1_700_000_000_000

let handle: ScannerHandle | undefined

function draft(
  overrides: Partial<MediaItemDraft> & { url: string; kind: MediaKind },
): MediaItemDraft {
  return {
    sources: ['dom'],
    downloadable: true,
    frameUrl: FRAME,
    firstSeen: T0,
    ...overrides,
  }
}

function boot(send: (items: MediaItemDraft[]) => void, doc: Document = document) {
  handle = startScanner({
    document: doc,
    send,
    now: () => T0,
    frameUrl: FRAME,
  })
}

/** 空页面先扫完一轮，后面的变化才算动态插入。 */
async function bootIdle(send: (items: MediaItemDraft[]) => void) {
  boot(send)
  await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)
  expect(send).not.toHaveBeenCalled()
}

/** MutationObserver 走 microtask，防抖走 setTimeout。先把观察者回调放出来。 */
async function flushMutations() {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
}

afterEach(() => {
  handle?.stop()
  handle = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Content Script DOM 扫描', () => {
  it('防抖不超过 1 秒，结果才能在 1 秒内出现', () => {
    expect(DOM_SCAN_DEBOUNCE_MS).toBeGreaterThan(0)
    expect(DOM_SCAN_DEBOUNCE_MS).toBeLessThanOrEqual(1000)
  })

  describe('收集 video / audio', () => {
    it('收集全部 source 子元素，并带上 type', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      document.body.innerHTML = `
        <video>
          <source src="https://cdn.example/clip.webm" type="video/webm">
          <source src="https://cdn.example/clip.mp4" type='video/mp4; codecs="avc1.42E01E"'>
        </video>
        <audio>
          <source src="https://cdn.example/song.mp3" type="audio/mpeg">
        </audio>
      `
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)

      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS - 1)
      expect(send).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(send).toHaveBeenCalledTimes(1)
      const items = send.mock.calls[0][0]
      expect(items).toEqual([
        draft({
          url: 'https://cdn.example/clip.webm',
          kind: 'video',
          ext: 'webm',
          mime: 'video/webm',
        }),
        draft({
          url: 'https://cdn.example/clip.mp4',
          kind: 'video',
          ext: 'mp4',
          mime: 'video/mp4',
        }),
        draft({
          url: 'https://cdn.example/song.mp3',
          kind: 'audio',
          ext: 'mp3',
          mime: 'audio/mpeg',
        }),
      ])
      expect(isMediaFoundMessage({ type: MESSAGE_TYPE.MEDIA_FOUND, items })).toBe(true)
    })

    it('同时读取 currentSrc、元素 src 和 source，相同地址只留一条', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const video = document.createElement('video')
      video.src = 'https://cdn.example/fallback.mp4#t=1'
      video.innerHTML = '<source src="https://cdn.example/fallback.mp4" type="video/mp4">'
      Object.defineProperty(video, 'currentSrc', {
        configurable: true,
        get: () => 'blob:https://example.com/played',
      })
      document.body.append(video)

      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)

      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: 'blob:https://example.com/played',
          kind: 'video',
          downloadable: false,
          note: 'blob 地址，无法直接下载',
        }),
        draft({
          url: 'https://cdn.example/fallback.mp4',
          kind: 'video',
          ext: 'mp4',
          mime: 'video/mp4',
        }),
      ])
    })

    it('空 src 不会把文档地址当成媒体', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const blank = document.createElement('video')
      blank.setAttribute('src', '')
      const spaces = document.createElement('video')
      spaces.setAttribute('src', '   ')
      const audio = document.createElement('audio')
      audio.src = 'https://cdn.example/real.mp3'
      document.body.append(blank, spaces, audio)

      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)

      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: 'https://cdn.example/real.mp3',
          kind: 'audio',
          ext: 'mp3',
        }),
      ])
      const page = new URL(document.location.href)
      page.hash = ''
      expect(JSON.stringify(send.mock.calls[0][0])).not.toContain(page.href)
    })

    it('相对地址解析成绝对地址，hash 不同视为同一条', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const video = document.createElement('video')
      video.setAttribute('src', 'media/clip.mp4#t=3')
      const audio = document.createElement('audio')
      audio.setAttribute('src', 'media/clip.mp4#t=9')
      document.body.append(video, audio)

      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)

      const expected = new URL('media/clip.mp4', document.baseURI).href
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: expected,
          kind: 'video',
          ext: 'mp4',
        }),
      ])
    })

    it('blob 和 data 用 classify 标成不可下载', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const video = document.createElement('video')
      video.src = 'blob:https://www.youtube.com/11111111-1111-1111-1111-111111111111'
      const audio = document.createElement('audio')
      audio.src = 'data:audio/mpeg;base64,SUQz'
      document.body.append(video, audio)

      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)

      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: 'blob:https://www.youtube.com/11111111-1111-1111-1111-111111111111',
          kind: 'video',
          downloadable: false,
          note: 'blob 地址，无法直接下载',
        }),
        draft({
          url: 'data:audio/mpeg;base64,SUQz',
          kind: 'audio',
          ext: 'mp3',
          mime: 'audio/mpeg',
          downloadable: false,
          note: 'data 地址，无法直接下载',
        }),
      ])
    })

    it('清单地址按 classify 标成不可下载，分片和无后缀直链分别处理', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const playlist = document.createElement('video')
      playlist.src = 'https://cdn.example/list.m3u8'
      const segment = document.createElement('video')
      segment.src = 'https://cdn.example/seg/1.ts'
      const init = document.createElement('video')
      init.src = 'https://cdn.example/seg/1.m4s'
      const stream = document.createElement('audio')
      stream.src = 'https://cdn.example/stream?id=1'
      document.body.append(playlist, segment, init, stream)

      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)

      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: 'https://cdn.example/list.m3u8',
          kind: 'hls',
          ext: 'm3u8',
          downloadable: false,
          note: 'HLS 清单，可下载未加密或 AES-128 点播',
        }),
        draft({
          url: 'https://cdn.example/stream?id=1',
          kind: 'audio',
          downloadable: true,
        }),
      ])
    })
  })

  describe('防抖和动态 DOM', () => {
    it('动态插入的 video 在 1 秒内上报', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      await bootIdle(send)

      const video = document.createElement('video')
      video.src = 'https://cdn.example/dynamic.mp4'
      document.body.append(video)
      expect(send).not.toHaveBeenCalled()

      await flushMutations()
      await vi.advanceTimersByTimeAsync(1000)

      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: 'https://cdn.example/dynamic.mp4',
          kind: 'video',
          ext: 'mp4',
        }),
      ])
    })

    it('后插入的 source 子元素也会被扫到', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const video = document.createElement('video')
      document.body.append(video)
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      await bootIdle(send)

      const source = document.createElement('source')
      source.src = 'https://cdn.example/added.webm'
      source.type = 'video/webm'
      video.append(source)

      await flushMutations()
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)

      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: 'https://cdn.example/added.webm',
          kind: 'video',
          ext: 'webm',
          mime: 'video/webm',
        }),
      ])
    })

    it('连续插入合并成一次发送', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      await bootIdle(send)

      const first = document.createElement('video')
      first.src = 'https://cdn.example/a.mp4'
      document.body.append(first)
      await flushMutations()
      await vi.advanceTimersByTimeAsync(200)

      const second = document.createElement('audio')
      second.src = 'https://cdn.example/b.mp3'
      document.body.append(second)
      await flushMutations()
      await vi.advanceTimersByTimeAsync(200)
      expect(send).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(100)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0].map((item) => item.url)).toEqual([
        'https://cdn.example/a.mp4',
        'https://cdn.example/b.mp3',
      ])
    })

    it('src 变化后只发送新地址', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const video = document.createElement('video')
      video.src = 'https://cdn.example/old.mp4'
      document.body.append(video)
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)
      expect(send).toHaveBeenCalledTimes(1)

      video.src = 'https://cdn.example/next.webm'
      await flushMutations()
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)

      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toEqual([
        draft({
          url: 'https://cdn.example/next.webm',
          kind: 'video',
          ext: 'webm',
        }),
      ])
    })

    it('loadedmetadata / loadstart 之后才读得到后设置的 currentSrc', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const video = document.createElement('video')
      document.body.append(video)
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      await bootIdle(send)

      Object.defineProperty(video, 'currentSrc', {
        configurable: true,
        get: () => 'blob:https://example.com/late',
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(send).not.toHaveBeenCalled()

      video.dispatchEvent(new Event('loadedmetadata'))
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS - 1)
      expect(send).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: 'blob:https://example.com/late',
          kind: 'video',
          downloadable: false,
          note: 'blob 地址，无法直接下载',
        }),
      ])
    })

    it('loadstart 同样会触发再扫描', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const audio = document.createElement('audio')
      document.body.append(audio)
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      await bootIdle(send)

      Object.defineProperty(audio, 'currentSrc', {
        configurable: true,
        get: () => 'https://cdn.example/late.m4a',
      })
      audio.dispatchEvent(new Event('loadstart'))
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)

      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: 'https://cdn.example/late.m4a',
          kind: 'audio',
          ext: 'm4a',
        }),
      ])
    })
  })

  describe('只在结果变化时发送', () => {
    it('相同结果不重复发送', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const video = document.createElement('video')
      video.src = 'https://cdn.example/once.mp4'
      document.body.append(video)
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)
      expect(send).toHaveBeenCalledTimes(1)

      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('loadstart'))
      video.dispatchEvent(new Event('emptied'))
      video.className = 'player'
      video.poster = 'https://cdn.example/poster.jpg'
      document.body.append(document.createElement('div'))
      const again = document.createElement('video')
      again.src = 'https://cdn.example/once.mp4#t=2'
      document.body.append(again)

      await flushMutations()
      await vi.advanceTimersByTimeAsync(1000)
      expect(send).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(send.mock.calls)).not.toContain('poster.jpg')
    })

    it('发送失败时不记成已发送，下一轮会重试', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const video = document.createElement('video')
      video.src = 'https://cdn.example/retry.mp4'
      document.body.append(video)

      let fail = true
      const send = vi.fn<(items: MediaItemDraft[]) => void>(() => {
        if (fail) throw new Error('端口已断开')
      })
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)
      expect(send).toHaveBeenCalledTimes(1)

      fail = false
      video.dispatchEvent(new Event('loadedmetadata'))
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0][0]?.url).toBe('https://cdn.example/retry.mp4')
    })

    it('stop 之后不再发送', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)
      handle?.stop()

      const video = document.createElement('video')
      video.src = 'https://cdn.example/after-stop.mp4'
      document.body.append(video)
      video.dispatchEvent(new Event('loadedmetadata'))
      await flushMutations()
      await vi.advanceTimersByTimeAsync(1000)
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('document_start', () => {
    it('documentElement 出现之前不回调，出现后只回调一次', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const doc = document.implementation.createDocument(null, '', null)
      expect(doc.documentElement).toBeNull()
      const ready = vi.fn()
      whenDocumentElementReady(doc, ready)

      doc.dispatchEvent(new Event('DOMContentLoaded'))
      await flushMutations()
      expect(ready).not.toHaveBeenCalled()

      doc.appendChild(doc.createElement('html'))
      doc.dispatchEvent(new Event('DOMContentLoaded'))
      await flushMutations()
      expect(ready).toHaveBeenCalledTimes(1)
    })

    it('取消等待后，晚出现的 documentElement 不会再触发扫描', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const doc = document.implementation.createDocument(null, '', null)
      const ready = vi.fn()
      const cancel = whenDocumentElementReady(doc, ready)
      cancel()
      doc.appendChild(doc.createElement('html'))
      await flushMutations()
      expect(ready).not.toHaveBeenCalled()
    })

    it('还没有 documentElement 时不发送，节点进来后再发', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const doc = document.implementation.createDocument(null, '', null)
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send, doc)
      await vi.advanceTimersByTimeAsync(1000)
      expect(send).not.toHaveBeenCalled()

      const html = doc.createElement('html')
      const body = doc.createElement('body')
      const video = doc.createElement('video')
      video.setAttribute('src', 'https://cdn.example/deferred.mp4')
      body.appendChild(video)
      html.appendChild(body)
      doc.appendChild(html)

      await flushMutations()
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toEqual([
        draft({
          url: 'https://cdn.example/deferred.mp4',
          kind: 'video',
          ext: 'mp4',
        }),
      ])
    })
  })

  describe('页面里的 playinfo（示例数据）', () => {
    it('只解析 script 文本，不执行脚本，坏掉的赋值直接忽略', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const playinfo = {
        data: {
          accept_quality: [80],
          accept_description: ['1080P'],
          dash: {
            video: [
              {
                id: 80,
                baseUrl: 'https://cdn.example.test/example-data/v.m4s',
                backupUrl: ['https://cdn.example.test/example-data/backup.m4s'],
                codecs: 'avc1.640028',
                width: 1920,
                height: 1080,
              },
            ],
            audio: [
              {
                id: 1,
                baseUrl: 'https://cdn.example.test/example-data/a.m4s',
                bandwidth: 192000,
              },
            ],
          },
        },
      }
      const script = document.createElement('script')
      // text/plain 让测试环境不要执行这段脚本。扩展只读文本。
      script.type = 'text/plain'
      script.textContent = `window.__playinfo__ = ${JSON.stringify(playinfo)};`
      const broken = document.createElement('script')
      broken.type = 'text/plain'
      broken.textContent = 'window.__playinfo__ = { "data": '
      document.body.append(script, broken)
      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[0]).toEqual([
        draft({
          url: 'https://cdn.example.test/example-data/v.m4s',
          kind: 'video',
          ext: 'm4s',
          downloadable: false,
          note: '只下载页面当前能播放的内容，不支持会员专享。「下载视频」默认合并成一个 mp4，也可以勾选「分开保存视频和音频」。视频行的「下载音频」保存码率最高的音轨，音频行保存这一条。链接有有效期，失效后请先刷新页面再下载。',
          bilibili: {
            role: 'video',
            label: 'B站视频 1080P · AVC',
            qualityId: 80,
            width: 1920,
            height: 1080,
            codecs: 'avc1.640028',
          },
        }),
        draft({
          url: 'https://cdn.example.test/example-data/a.m4s',
          kind: 'audio',
          ext: 'm4s',
          downloadable: false,
          note: '只下载页面当前能播放的内容，不支持会员专享。「下载视频」默认合并成一个 mp4，也可以勾选「分开保存视频和音频」。视频行的「下载音频」保存码率最高的音轨，音频行保存这一条。链接有有效期，失效后请先刷新页面再下载。',
          bilibili: {
            role: 'audio',
            label: 'B站音频 192kbps',
            qualityId: 1,
            bandwidth: 192000,
          },
        }),
      ])
    })
  })

  describe('隔离环境', () => {
    it('扫描时不改 fetch、XHR、JSON.parse，也不注入脚本', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const fetchBefore = globalThis.fetch
      const xhrBefore = globalThis.XMLHttpRequest
      const parseBefore = JSON.parse
      const mediaSourceBefore = (globalThis as { MediaSource?: unknown }).MediaSource
      const scriptsBefore = document.scripts.length

      const send = vi.fn<(items: MediaItemDraft[]) => void>()
      const video = document.createElement('video')
      video.src = 'https://cdn.example/plain.mp4'
      document.body.append(video)
      boot(send)
      await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS)

      expect(globalThis.fetch).toBe(fetchBefore)
      expect(globalThis.XMLHttpRequest).toBe(xhrBefore)
      expect(JSON.parse).toBe(parseBefore)
      expect((globalThis as { MediaSource?: unknown }).MediaSource).toBe(mediaSourceBefore)
      expect(document.scripts.length).toBe(scriptsBefore)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('源码不注入主世界，也不挂钩网络和解析函数', () => {
      const source = ['scanner.ts', 'index.ts']
        .map((name) => readFileSync(resolve('src/content', name), 'utf8'))
        .join('\n')
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code).not.toMatch(/['"]MAIN['"]/)
      expect(code).not.toMatch(/executeScript/)
      expect(code).not.toMatch(/contentDocument/)
      expect(code).not.toMatch(/XMLHttpRequest/)
      expect(code).not.toMatch(/MediaSource/)
      expect(code).not.toMatch(/JSON\.parse\s*=/)
      expect(code).not.toMatch(/\bfetch\s*=/)
    })
  })

  describe('deliverMediaFound', () => {
    const sample = [
      draft({
        url: 'https://cdn.example/a.mp4',
        kind: 'video',
        ext: 'mp4',
      }),
    ]

    it('包成 MEDIA_FOUND', () => {
      const sendMessage = vi.fn<(message: unknown) => Promise<void>>(() => Promise.resolve())
      vi.stubGlobal('chrome', { runtime: { sendMessage } })
      deliverMediaFound(sample)
      expect(sendMessage).toHaveBeenCalledTimes(1)
      const message = sendMessage.mock.calls[0]?.[0]
      expect(isMediaFoundMessage(message)).toBe(true)
      expect(message).toEqual({ type: MESSAGE_TYPE.MEDIA_FOUND, items: sample })
    })

    it('空列表不发', () => {
      const sendMessage = vi.fn()
      vi.stubGlobal('chrome', { runtime: { sendMessage } })
      deliverMediaFound([])
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('接收端不存在或同步抛错时不往页面抛', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const sendMessage = vi
        .fn()
        .mockReturnValueOnce(Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')))
        .mockImplementationOnce(() => {
          throw new Error('Extension context invalidated.')
        })
      vi.stubGlobal('chrome', { runtime: { sendMessage } })

      expect(() => deliverMediaFound(sample)).not.toThrow()
      expect(() => deliverMediaFound(sample)).not.toThrow()
      await Promise.resolve()
      await Promise.resolve()
      expect(error).not.toHaveBeenCalled()
    })
  })
})
