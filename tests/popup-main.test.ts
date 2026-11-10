/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_RETRY_STORAGE_KEY } from '../src/shared/download-retry'
import { DOWNLOAD_STATUS_STORAGE_KEY } from '../src/shared/download-status'
import { HLS_JOB_STORAGE_KEY } from '../src/shared/hls-job'
import type { MediaItem } from '../src/shared/types'

/**
 * 打开 popup 的主流程：读 session 里的最近状态，点击下载后把原因留在对应条目上。
 */

const video: MediaItem = {
  url: 'https://cdn.example/videos/clip.mp4',
  kind: 'video',
  ext: 'mp4',
  size: 100,
  sources: ['dom'],
  downloadable: true,
  firstSeen: 1,
}

const dash: MediaItem = {
  url: 'https://cdn.example/manifest.mpd',
  kind: 'dash',
  ext: 'mpd',
  sources: ['network'],
  downloadable: false,
  firstSeen: 2,
}

const hls: MediaItem = {
  url: 'https://cdn.example/master.m3u8',
  kind: 'hls',
  ext: 'm3u8',
  sources: ['network'],
  downloadable: false,
  firstSeen: 3,
}

interface StorageListener {
  (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ): void
}

let sent: unknown[]
let downloadResponse: unknown
let stored: unknown
let sessionExtra: Record<string, unknown>
let mediaItems: MediaItem[]
let storageListeners: StorageListener[]

function installChrome(): void {
  sent = []
  downloadResponse = { ok: false, error: '服务器拒绝访问（403）' }
  stored = undefined
  sessionExtra = {}
  mediaItems = [video]
  storageListeners = []
  const mock = {
    tabs: {
      async query() {
        return [{ id: 5, title: '示例' }]
      },
    },
    runtime: {
      async sendMessage(message: unknown) {
        sent.push(message)
        if (typeof message === 'object' && message !== null && 'type' in message) {
          if (message.type === 'GET_MEDIA') return mediaItems
          if (message.type === 'DOWNLOAD') return downloadResponse
        }
        return undefined
      },
    },
    storage: {
      session: {
        async get() {
          return { [DOWNLOAD_STATUS_STORAGE_KEY]: stored, ...sessionExtra }
        },
      },
      onChanged: {
        addListener(listener: StorageListener) {
          storageListeners.push(listener)
        },
      },
    },
  }
  ;(globalThis as unknown as { chrome: typeof chrome }).chrome = mock as unknown as typeof chrome
}

async function openPopup(): Promise<void> {
  document.body.innerHTML = `
    <header class="bar">
      <div class="titles">
        <h1>Media Grabber</h1>
        <p id="count">正在读取…</p>
      </div>
      <button id="clear" type="button" disabled>清空</button>
    </header>
    <p id="banner" class="banner" hidden></p>
    <p id="page-title" class="page-title" hidden></p>
    <p id="empty" class="empty" hidden>当前页面还没有发现音视频。播放一下，或刷新后再打开看看。</p>
    <ul id="list" class="list"></ul>
  `
  vi.resetModules()
  await import('../src/popup/main.ts')
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.item')).toHaveLength(1)
  })
}

beforeEach(() => {
  installChrome()
})

describe('popup 下载状态', () => {
  it('列表上方显示当前页面标题', async () => {
    await openPopup()
    const title = document.querySelector('#page-title')
    expect(title?.hasAttribute('hidden')).toBe(false)
    expect(title?.textContent).toBe('示例')
  })

  it('重开时显示 session 里的最近失败原因', async () => {
    stored = {
      [video.url]: { phase: 'failed', message: '网络连接失败', updatedAt: 1 },
    }
    await openPopup()
    expect(document.querySelector('.status')?.textContent).toBe('网络连接失败')
    expect(document.querySelector('.status-failed')).toBeTruthy()
  })

  it('失败后用同一地址重试，只改这一条并去掉重试按钮', async () => {
    stored = {
      [video.url]: { phase: 'failed', message: '网络连接失败', updatedAt: 1 },
    }
    await openPopup()
    const retry = document.querySelector<HTMLButtonElement>('[data-action="retry"]')
    expect(retry?.textContent).toBe('重试')
    downloadResponse = { ok: true, downloadId: 12 }
    retry?.click()
    await vi.waitFor(() => {
      expect(document.querySelector('.status')?.textContent).toBe('已开始下载')
    })
    expect(sent.at(-1)).toEqual({
      type: 'DOWNLOAD',
      url: video.url,
      tabId: 5,
    })
    expect(document.querySelector('[data-action="retry"]')).toBeNull()
  })

  it('HLS 失败后用记下的清晰度重试，不再重新选一遍', async () => {
    mediaItems = [hls]
    const mediaUrl = 'https://cdn.example/high.m3u8'
    sessionExtra = {
      [HLS_JOB_STORAGE_KEY]: {
        [hls.url]: {
          phase: 'failed',
          message: '服务器拒绝访问（403）',
          completed: 0,
          total: 1,
          updatedAt: 1,
        },
      },
      [DOWNLOAD_RETRY_STORAGE_KEY]: {
        [hls.url]: { kind: 'hls', mode: 'download', mediaUrl },
      },
    }
    await openPopup()
    document.querySelector<HTMLButtonElement>('[data-action="retry"]')?.click()
    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: 'HLS_DOWNLOAD',
        url: hls.url,
        mediaUrl,
        tabId: 5,
      })
    })
  })

  it('点击下载后把回复写在这一条上，随后完成状态也能更新', async () => {
    downloadResponse = { ok: true, downloadId: 9 }
    await openPopup()
    const button = document.querySelector<HTMLButtonElement>('.download')
    expect(button).toBeTruthy()
    button?.click()
    await vi.waitFor(() => {
      expect(document.querySelector('.status')?.textContent).toBe('已开始下载')
    })
    expect(sent.at(-1)).toEqual({
      type: 'DOWNLOAD',
      url: video.url,
      tabId: 5,
    })
    expect(button?.textContent).toBe('已开始下载')

    storageListeners[0]?.(
      {
        [DOWNLOAD_STATUS_STORAGE_KEY]: {
          newValue: {
            [video.url]: { phase: 'complete', message: '已完成', downloadId: 9, updatedAt: 2 },
          },
        },
      },
      'session',
    )
    expect(document.querySelector('.status')?.textContent).toBe('已完成')
    expect(document.querySelector('.status-complete')).toBeTruthy()
  })

  it('拒绝原因显示在条目上，按钮不会一直停在下载中', async () => {
    downloadResponse = { ok: false, error: '服务器拒绝访问（403）' }
    await openPopup()
    document.querySelector<HTMLButtonElement>('.download')?.click()
    await vi.waitFor(() => {
      expect(document.querySelector('.status')?.textContent).toBe('服务器拒绝访问（403）')
    })
    expect(document.querySelector('.status-failed')).toBeTruthy()
    expect(document.querySelector('.download')?.textContent).toBe('服务器拒绝访问（403）')
  })
})

describe('popup 字幕检查', () => {
  const track = { id: 'https://cdn.example/zh.m3u8', label: '中文', format: 'vtt' as const }

  async function openHlsPopup(): Promise<void> {
    mediaItems = [hls]
    document.body.innerHTML = `
      <header class="bar">
        <div class="titles"><h1>Media Grabber</h1><p id="count">正在读取…</p></div>
        <button id="clear" type="button" disabled>清空</button>
      </header>
      <p id="banner" class="banner" hidden></p>
      <p id="page-title" class="page-title" hidden></p>
      <p id="empty" class="empty" hidden>当前页面还没有发现音视频。</p>
      <ul id="list" class="list"></ul>
    `
    vi.resetModules()
    await import('../src/popup/main.ts')
    await vi.waitFor(() => expect(document.querySelectorAll('.item')).toHaveLength(1))
  }

  it('进度更新重画后仍保留选过的 .srt', async () => {
    const mock = chrome.runtime.sendMessage as (message: unknown) => Promise<unknown>
    chrome.runtime.sendMessage = async (message: unknown) => {
      sent.push(message)
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'SUBTITLE_INSPECT') {
        return { ok: true, tracks: [track] }
      }
      return mock(message)
    }
    chrome.storage.session.set = async () => undefined
    await openHlsPopup()
    await vi.waitFor(() => expect(document.querySelector('select.subtitle-format')).toBeTruthy())
    const select = document.querySelector('select.subtitle-format')
    if (!(select instanceof HTMLSelectElement)) throw new Error('缺少格式选择')
    select.value = 'srt'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    storageListeners[0]?.(
      {
        [DOWNLOAD_STATUS_STORAGE_KEY]: {
          newValue: { [hls.url]: { phase: 'started', message: '正在下载 1/2', updatedAt: 2 } },
        },
      },
      'session',
    )
    const again = document.querySelector('select.subtitle-format')
    if (!(again instanceof HTMLSelectElement)) throw new Error('重画后缺少格式选择')
    expect(again.value).toBe('srt')
  })

  it('直播这类拒绝不显示，也不缓存，重开还会再查', async () => {
    const cache: Record<string, unknown> = {}
    chrome.storage.session.get = async () => ({ ...cache })
    chrome.storage.session.set = async (value: Record<string, unknown>) => {
      Object.assign(cache, value)
    }
    chrome.runtime.sendMessage = async (message: unknown) => {
      sent.push(message)
      if (typeof message === 'object' && message !== null && 'type' in message) {
        if (message.type === 'GET_MEDIA') return mediaItems
        if (message.type === 'SUBTITLE_INSPECT') return { ok: false, error: '这是直播流（MPD type=dynamic），暂不支持下载' }
      }
      return undefined
    }
    await openHlsPopup()
    await vi.waitFor(() => expect(sent.filter((message) => isInspect(message)).length).toBe(1))
    expect(document.body.textContent).not.toContain('暂不支持下载')
    expect(cache['media-grabber-subtitle-inspect']).toBeUndefined()
    await openHlsPopup()
    await vi.waitFor(() => expect(sent.filter((message) => isInspect(message)).length).toBe(2))
  })

  it('网络失败不缓存；DRM 结果会缓存，重开不再请求', async () => {
    const cache: Record<string, unknown> = {}
    let mode: 'fail' | 'drm' = 'fail'
    chrome.storage.session.get = async () => ({ ...cache })
    chrome.storage.session.set = async (value: Record<string, unknown>) => {
      Object.assign(cache, value)
    }
    chrome.runtime.sendMessage = async (message: unknown) => {
      sent.push(message)
      if (typeof message === 'object' && message !== null && 'type' in message) {
        if (message.type === 'GET_MEDIA') return mediaItems
        if (message.type === 'SUBTITLE_INSPECT') {
          if (mode === 'fail') return undefined
          return { ok: false, error: '清单含有 DRM（Widevine、PlayReady 或 FairPlay），不支持' }
        }
      }
      return undefined
    }
    await openHlsPopup()
    await vi.waitFor(() => expect(sent.filter((message) => isInspect(message)).length).toBe(1))
    expect(cache['media-grabber-subtitle-inspect']).toBeUndefined()
    await openHlsPopup()
    await vi.waitFor(() => expect(sent.filter((message) => isInspect(message)).length).toBe(2))

    mode = 'drm'
    await openHlsPopup()
    await vi.waitFor(() => expect(document.body.textContent).toContain('DRM'))
    const inspects = sent.filter((message) => isInspect(message)).length
    await openHlsPopup()
    await vi.waitFor(() => expect(document.body.textContent).toContain('DRM'))
    expect(sent.filter((message) => isInspect(message)).length).toBe(inspects)
  })

  it('两份清单同时写缓存时都还在', async () => {
    const hls2: MediaItem = { ...hls, url: 'https://cdn.example/other.m3u8' }
    mediaItems = [hls, hls2]
    const cache: Record<string, unknown> = {}
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let setCalls = 0
    chrome.storage.session.get = async () => ({ ...cache })
    chrome.storage.session.set = async (value: Record<string, unknown>) => {
      setCalls += 1
      if (setCalls === 1) await gate
      Object.assign(cache, value)
    }
    chrome.runtime.sendMessage = async (message: unknown) => {
      sent.push(message)
      if (typeof message === 'object' && message !== null && 'type' in message) {
        if (message.type === 'GET_MEDIA') return mediaItems
        if (message.type === 'SUBTITLE_INSPECT' && 'url' in message && typeof message.url === 'string') {
          return { ok: true, tracks: [{ id: `${message.url}/zh.vtt`, label: '中文', format: 'vtt' }] }
        }
      }
      return undefined
    }
    document.body.innerHTML = `
      <header class="bar">
        <div class="titles"><h1>Media Grabber</h1><p id="count">正在读取…</p></div>
        <button id="clear" type="button" disabled>清空</button>
      </header>
      <p id="banner" class="banner" hidden></p>
      <p id="page-title" class="page-title" hidden></p>
      <p id="empty" class="empty" hidden>当前页面还没有发现音视频。</p>
      <ul id="list" class="list"></ul>
    `
    vi.resetModules()
    await import('../src/popup/main.ts')
    await vi.waitFor(() => expect(sent.filter((message) => isInspect(message)).length).toBe(2))
    release()
    await vi.waitFor(() => {
      const saved = cache['media-grabber-subtitle-inspect']
      expect(saved && typeof saved === 'object' && hls.url in saved && hls2.url in saved).toBe(true)
    })
  })
})

function isInspect(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'SUBTITLE_INSPECT'
}

describe('popup DASH 按钮', () => {
  async function openDashPopup(): Promise<void> {
    mediaItems = [dash]
    document.body.innerHTML = `
      <header class="bar">
        <div class="titles"><h1>Media Grabber</h1><p id="count">正在读取…</p></div>
        <button id="clear" type="button" disabled>清空</button>
      </header>
      <p id="banner" class="banner" hidden></p>
      <p id="page-title" class="page-title" hidden></p>
      <p id="empty" class="empty" hidden>当前页面还没有发现音视频。</p>
      <ul id="list" class="list"></ul>
    `
    vi.resetModules()
    await import('../src/popup/main.ts')
    await vi.waitFor(() => expect(document.querySelectorAll('.item')).toHaveLength(1))
  }

  it('下载音频和下载视频分别发 audioOnly 为 true / false', async () => {
    await openDashPopup()
    document.querySelector<HTMLButtonElement>('[data-action="dash-audio"]')?.click()
    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: 'DASH_INSPECT',
        url: dash.url,
        separate: false,
        audioOnly: true,
        tabId: 5,
      })
    })

    sent.length = 0
    document.querySelector<HTMLButtonElement>('[data-action="dash-download"]')?.click()
    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: 'DASH_INSPECT',
        url: dash.url,
        separate: false,
        audioOnly: false,
        tabId: 5,
      })
    })
  })
})
