import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HLS_JOB_STORAGE_KEY, readHlsJobMap } from '../src/shared/hls-job'
import type { DownloadQueueState } from '../src/shared/download-queue'

interface SentMessage {
  type?: string
  playlistUrl?: string
}

function installChrome() {
  const storage = new Map<string, unknown>()
  const sent: SentMessage[] = []

  const clone = <T>(value: T): T => structuredClone(value)
  const mock = {
    storage: {
      session: {
        async get(keys?: string | string[] | Record<string, unknown> | null) {
          const result: Record<string, unknown> = {}
          if (keys == null) {
            for (const [key, value] of storage) result[key] = clone(value)
            return result
          }
          const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
          for (const name of names) {
            if (storage.has(name)) result[name] = clone(storage.get(name))
          }
          return result
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) storage.set(key, clone(value))
        },
      },
      onChanged: {
        addListener() {
          return undefined
        },
      },
    },
    runtime: {
      async sendMessage(message: SentMessage) {
        sent.push(message)
        return { ok: true }
      },
      onMessage: { addListener() {} },
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
    tabs: {
      async query() {
        return []
      },
      async get() {
        return { title: undefined }
      },
    },
    declarativeNetRequest: {
      async getSessionRules() {
        return []
      },
      async updateSessionRules() {
        return undefined
      },
    },
  }

  vi.stubGlobal('chrome', mock)
  return { storage, sent }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error('等待后台队列超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function queued(storage: Map<string, unknown>): DownloadQueueState {
  return (storage.get('download-queue') ?? { running: [], waiting: [] }) as DownloadQueueState
}

describe('后台下载队列', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('第三条先写排队状态，取消排队后不再交给 offscreen', async () => {
    const { storage, sent } = installChrome()
    const queue = await import('../src/background/queue')
    const result = await Promise.all([
      queue.enqueueHlsJob({ key: 'https://cdn.example/a.m3u8', mediaUrl: 'https://cdn.example/a.m3u8' }),
      queue.enqueueHlsJob({ key: 'https://cdn.example/b.m3u8', mediaUrl: 'https://cdn.example/b.m3u8' }),
      queue.enqueueHlsJob({ key: 'https://cdn.example/c.m3u8', mediaUrl: 'https://cdn.example/c.m3u8' }),
    ])
    expect(result).toEqual([{ ok: true }, { ok: true }, { ok: true }])
    await waitFor(() => sent.filter((message) => message.type === 'HLS_OFFSCREEN_DOWNLOAD').length === 2)
    const state = queued(storage)
    expect(state.running).toHaveLength(2)
    expect(state.waiting).toHaveLength(1)
    expect(state.waiting[0]?.key).toBe('https://cdn.example/c.m3u8')

    const jobs = readHlsJobMap(storage.get(HLS_JOB_STORAGE_KEY))
    expect(jobs['https://cdn.example/c.m3u8']).toMatchObject({
      phase: 'queued',
      message: '排队中（第 1 位）',
    })

    expect(await queue.cancelQueuedJob('hls', 'https://cdn.example/c.m3u8')).toBe(true)
    expect(queued(storage).waiting).toHaveLength(0)
    expect(readHlsJobMap(storage.get(HLS_JOB_STORAGE_KEY))['https://cdn.example/c.m3u8']?.phase).toBe('cancelled')
    expect(sent.filter((message) => message.playlistUrl === 'https://cdn.example/c.m3u8')).toEqual([])
    expect(await queue.cancelQueuedJob('hls', 'https://cdn.example/c.m3u8')).toBe(false)
  })

  it('完成一条后自动启动下一条', async () => {
    const { storage, sent } = installChrome()
    const queue = await import('../src/background/queue')
    await queue.enqueueHlsJob({ key: 'https://cdn.example/a.m3u8', mediaUrl: 'https://cdn.example/a.m3u8' })
    await queue.enqueueHlsJob({ key: 'https://cdn.example/b.m3u8', mediaUrl: 'https://cdn.example/b.m3u8' })
    await queue.enqueueHlsJob({ key: 'https://cdn.example/c.m3u8', mediaUrl: 'https://cdn.example/c.m3u8' })
    await waitFor(() => sent.filter((message) => message.type === 'HLS_OFFSCREEN_DOWNLOAD').length === 2)
    const first = queued(storage).running.find((job) => job.key === 'https://cdn.example/a.m3u8')
    expect(first).toBeDefined()
    if (!first) return
    await queue.finishQueueJob(first.id)
    await waitFor(() => sent.filter((message) => message.type === 'HLS_OFFSCREEN_DOWNLOAD').length === 3)
    const state = queued(storage)
    expect(state.running.map((job) => job.key)).toEqual([
      'https://cdn.example/b.m3u8',
      'https://cdn.example/c.m3u8',
    ])
    expect(state.waiting).toHaveLength(0)
  })
})
