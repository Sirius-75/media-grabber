/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_STATUS_STORAGE_KEY } from '../src/shared/download-status'
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

interface StorageListener {
  (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ): void
}

let sent: unknown[]
let downloadResponse: unknown
let stored: unknown
let storageListeners: StorageListener[]

function installChrome(): void {
  sent = []
  downloadResponse = { ok: false, error: '服务器拒绝访问（403）' }
  stored = undefined
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
          if (message.type === 'GET_MEDIA') return [video]
          if (message.type === 'DOWNLOAD') return downloadResponse
        }
        return undefined
      },
    },
    storage: {
      session: {
        async get() {
          return { [DOWNLOAD_STATUS_STORAGE_KEY]: stored }
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
  it('重开时显示 session 里的最近失败原因', async () => {
    stored = {
      [video.url]: { phase: 'failed', message: '网络连接失败', updatedAt: 1 },
    }
    await openPopup()
    expect(document.querySelector('.status')?.textContent).toBe('网络连接失败')
    expect(document.querySelector('.status-failed')).toBeTruthy()
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
