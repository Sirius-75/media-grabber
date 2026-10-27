import { describe, expect, it } from 'vitest'
import { HLS_DOWNLOAD_CONCURRENCY, HLS_SEGMENT_RETRIES, HLS_TEXT } from '../src/shared/hls'
import { downloadSegmentsInOrder } from '../src/shared/hls-download'
import type { SegmentFetchResult } from '../src/shared/hls-fetch'

describe('分片调度', () => {
  it(`默认同时 ${HLS_DOWNLOAD_CONCURRENCY} 个，完成一个再补下一个`, async () => {
    const started: string[] = []
    let releaseFirst: ((value: SegmentFetchResult) => void) | undefined
    const urls = ['0', '1', '2', '3', '4', '5']
    const task = downloadSegmentsInOrder({
      urls,
      fetchSegment(url) {
        started.push(url)
        if (url === '0') {
          return new Promise((resolve) => {
            releaseFirst = resolve
          })
        }
        return new Promise(() => undefined)
      },
    })

    expect(started).toEqual(['0', '1', '2', '3'])
    releaseFirst?.({ ok: true, bytes: Uint8Array.of(1) })
    await viWaitUntil(() => started.includes('4'))
    expect(started).toEqual(['0', '1', '2', '3', '4'])
    // 后面的请求一直挂着，这里只确认没有一次把 6 个都发出去。
    expect(started).not.toContain('5')
    void task
  })

  it(`失败后再试 ${HLS_SEGMENT_RETRIES} 次，第三次成功就按原顺序返回`, async () => {
    const attempts = new Map<string, number>()
    const result = await downloadSegmentsInOrder({
      urls: ['bad', 'ok'],
      concurrency: 1,
      fetchSegment: async (url) => {
        const count = (attempts.get(url) ?? 0) + 1
        attempts.set(url, count)
        if (url === 'bad' && count <= HLS_SEGMENT_RETRIES) return { ok: false, status: 503 }
        return { ok: true, bytes: Uint8Array.of(count) }
      },
    })
    expect(attempts.get('bad')).toBe(HLS_SEGMENT_RETRIES + 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Array.from(result.parts[0] ?? [])).toEqual([HLS_SEGMENT_RETRIES + 1])
    expect(Array.from(result.parts[1] ?? [])).toEqual([1])
  })

  it('重试耗尽后报告 404 或 403，并且不再拉后面的分片', async () => {
    const calls: string[] = []
    const missing = await downloadSegmentsInOrder({
      urls: ['missing', 'later'],
      concurrency: 1,
      fetchSegment: async (url) => {
        calls.push(url)
        return { ok: false, status: url === 'missing' ? 404 : 200 }
      },
    })
    expect(calls.filter((url) => url === 'missing')).toHaveLength(HLS_SEGMENT_RETRIES + 1)
    expect(calls).not.toContain('later')
    expect(missing).toMatchObject({ ok: false, error: '第 1 个分片缺失（404）' })

    const forbidden = await downloadSegmentsInOrder({
      urls: ['secret'],
      fetchSegment: async () => ({ ok: false, status: 403 }),
    })
    expect(forbidden).toMatchObject({ ok: false, error: '服务器拒绝访问（403）' })
  })

  it('初始化段 404 和网络错误用不同的中文', async () => {
    const init = await downloadSegmentsInOrder({
      urls: ['init'],
      initCount: 1,
      retries: 0,
      fetchSegment: async () => ({ ok: false, status: 404 }),
    })
    expect(init).toMatchObject({ ok: false, error: '初始化段缺失（404）' })

    const network = await downloadSegmentsInOrder({
      urls: ['a'],
      retries: 0,
      fetchSegment: async () => {
        throw new Error('boom')
      },
    })
    expect(network).toMatchObject({ ok: false, error: '第 1 个分片下载失败：网络连接失败' })
  })

  it('完成顺序可以乱，拼回去仍按清单顺序', async () => {
    const result = await downloadSegmentsInOrder({
      urls: ['a', 'b', 'c'],
      concurrency: 3,
      fetchSegment: async (url) => {
        const wait = url === 'a' ? 30 : url === 'b' ? 10 : 0
        await new Promise((resolve) => setTimeout(resolve, wait))
        return { ok: true, bytes: Uint8Array.of(url.charCodeAt(0)) }
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.parts.map((part) => part[0])).toEqual(['a'.charCodeAt(0), 'b'.charCodeAt(0), 'c'.charCodeAt(0)])
  })

  it('取消后不再开始新的分片', async () => {
    const controller = new AbortController()
    let calls = 0
    const task = downloadSegmentsInOrder({
      urls: ['a', 'b', 'c', 'd', 'e', 'f'],
      signal: controller.signal,
      fetchSegment(_url, signal) {
        calls += 1
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      },
    })
    expect(calls).toBe(HLS_DOWNLOAD_CONCURRENCY)
    controller.abort()
    await expect(task).resolves.toEqual({ ok: false, cancelled: true, error: HLS_TEXT.cancelled })
    expect(calls).toBe(HLS_DOWNLOAD_CONCURRENCY)
  })

  it('开始前就已经取消，或列表是空的', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const cancelled = await downloadSegmentsInOrder({
      urls: ['a'],
      signal: controller.signal,
      fetchSegment: async () => {
        calls += 1
        return { ok: true, bytes: Uint8Array.of(1) }
      },
    })
    expect(cancelled.ok).toBe(false)
    expect(calls).toBe(0)
    const empty = await downloadSegmentsInOrder({
      urls: [],
      fetchSegment: async () => ({ ok: true, bytes: Uint8Array.of(1) }),
    })
    expect(empty).toMatchObject({ ok: false, error: HLS_TEXT.empty })
  })

  it('超过字节上限就停，并给出进度', async () => {
    const seen: number[] = []
    const result = await downloadSegmentsInOrder({
      urls: ['a', 'b'],
      concurrency: 1,
      maxBytes: 10,
      fetchSegment: async () => ({ ok: true, bytes: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }),
      onProgress(progress) {
        seen.push(progress.completed)
      },
    })
    expect(seen).toEqual([1])
    expect(result).toMatchObject({ ok: false, error: HLS_TEXT.tooBigActual })
  })
})

async function viWaitUntil(check: () => boolean): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
