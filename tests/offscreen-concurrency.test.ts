/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HLS_TEXT } from '../src/shared/hls'
import type { HlsJobRecord } from '../src/shared/hls-job'

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined

function dispatch(listener: Listener, message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const handled = listener(message, {} as chrome.runtime.MessageSender, (response) => resolve(response))
    if (handled !== true) resolve(handled)
  })
}

function installRuntime(): { getListener: () => Listener; writes: Array<{ record?: HlsJobRecord }> } {
  const writes: Array<{ record?: HlsJobRecord }> = []
  let listener: Listener | undefined
  const runtime = {
    onMessage: {
      addListener(entry: Listener) {
        listener = entry
      },
    },
    async sendMessage(message: { type?: string; record?: HlsJobRecord }) {
      writes.push(message)
      return { ok: true }
    },
  }
  vi.stubGlobal('chrome', { runtime })
  return {
    writes,
    getListener() {
      if (!listener) throw new Error('没有接上 offscreen 监听')
      return listener
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('offscreen 同时跑两条下载', () => {
  it('最多接受两条，第三条返回已有下载在进行，同步带回全部 activeKeys', async () => {
    vi.resetModules()
    // 清单一直不返回，任务会停在读取清单阶段，正好用来观察两个槽位。
    vi.stubGlobal('fetch', () => new Promise(() => undefined))
    const runtime = installRuntime()
    const mod = await import('../src/offscreen/main')
    mod.startOffscreen()
    const listener = runtime.getListener()

    const first = await dispatch(listener, {
      type: 'HLS_OFFSCREEN_DOWNLOAD',
      playlistUrl: 'https://cdn.example/a.m3u8',
      mediaUrl: 'https://cdn.example/a.m3u8',
    })
    const second = await dispatch(listener, {
      type: 'HLS_OFFSCREEN_DOWNLOAD',
      playlistUrl: 'https://cdn.example/b.m3u8',
      mediaUrl: 'https://cdn.example/b.m3u8',
    })
    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })

    const third = await dispatch(listener, {
      type: 'HLS_OFFSCREEN_DOWNLOAD',
      playlistUrl: 'https://cdn.example/c.m3u8',
      mediaUrl: 'https://cdn.example/c.m3u8',
    })
    expect(third).toEqual({ ok: false, error: HLS_TEXT.busy })

    const sync = await dispatch(listener, { type: 'HLS_OFFSCREEN_SYNC' })
    expect(sync).toMatchObject({
      ok: true,
      activeKeys: ['https://cdn.example/a.m3u8', 'https://cdn.example/b.m3u8'],
    })
  })
})
