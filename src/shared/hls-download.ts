/**
 * 按顺序下载分片。不访问 chrome。
 * 并发默认 4。每一片失败后再试 2 次。调用方用 AbortSignal 取消。
 * 完成顺序可以乱，返回的 parts 始终按 urls 的顺序排。
 */

import {
  HLS_DOWNLOAD_CONCURRENCY,
  HLS_HARD_BYTE_LIMIT,
  HLS_SEGMENT_RETRIES,
  HLS_TEXT,
  describeFetchFailure,
} from './hls'
import type { SegmentFetchResult } from './hls-fetch'

export interface SegmentProgress {
  completed: number
  total: number
  bytes: number
}

export type SegmentDownloadResult =
  | { ok: true; parts: Uint8Array[]; bytes: number }
  | { ok: false; cancelled: true; error: string }
  | { ok: false; cancelled?: false; error: string; index?: number; status?: number }

export interface SegmentDownloadOptions {
  urls: readonly string[]
  fetchSegment: (url: string, signal: AbortSignal) => Promise<SegmentFetchResult>
  concurrency?: number
  /** 失败后的额外尝试次数，默认 2。 */
  retries?: number
  signal?: AbortSignal
  maxBytes?: number
  /** 初始化段占 urls 开头的几项，用来写对错误文案。 */
  initCount?: number
  retryDelayMs?: number
  onProgress?: (progress: SegmentProgress) => void
}

function cancelled(): SegmentDownloadResult {
  return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

export async function downloadSegmentsInOrder(options: SegmentDownloadOptions): Promise<SegmentDownloadResult> {
  const urls = options.urls
  const total = urls.length
  if (total === 0) return { ok: false, error: HLS_TEXT.empty }
  if (options.signal?.aborted) return cancelled()

  const concurrency = Math.max(1, Math.min(options.concurrency ?? HLS_DOWNLOAD_CONCURRENCY, total))
  const retries = options.retries ?? HLS_SEGMENT_RETRIES
  const maxBytes = options.maxBytes ?? HLS_HARD_BYTE_LIMIT
  const initCount = options.initCount ?? 0
  const parent = options.signal
  const inner = new AbortController()
  if (parent) {
    if (parent.aborted) inner.abort()
    else parent.addEventListener('abort', () => inner.abort(), { once: true })
  }

  const describe =
    (info: { index: number; status: number }) =>
      describeFetchFailure({ index: info.index, initCount, status: info.status })

  const parts: Array<Uint8Array | undefined> = new Array(total)
  let next = 0
  let completed = 0
  let bytes = 0
  let mode: 'ok' | 'cancel' | 'fail' = 'ok'
  let failure: SegmentDownloadResult | undefined

  const fail = (result: SegmentDownloadResult) => {
    if (mode !== 'ok') return
    mode = 'fail'
    failure = result
    inner.abort()
  }

  async function fetchOne(index: number): Promise<void> {
    if (mode !== 'ok') return
    const url = urls[index] ?? ''
    let lastStatus = 0
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (parent?.aborted) {
        mode = 'cancel'
        return
      }
      if (mode !== 'ok') return
      let response: SegmentFetchResult
      try {
        response = await options.fetchSegment(url, inner.signal)
      } catch {
        if (parent?.aborted) {
          mode = 'cancel'
          return
        }
        if (mode !== 'ok' || inner.signal.aborted) return
        response = { ok: false, status: 0 }
      }
      if (parent?.aborted) {
        mode = 'cancel'
        return
      }
      if (mode !== 'ok') return
      if (response.ok) {
        const size = response.bytes.byteLength
        if (bytes + size > maxBytes) {
          fail({ ok: false, error: HLS_TEXT.tooBigActual, index })
          return
        }
        parts[index] = response.bytes
        bytes += size
        completed += 1
        try {
          options.onProgress?.({ completed, total, bytes })
        } catch {
          // 进度回调失败不取消已经下到的分片。
        }
        return
      }
      lastStatus = response.status
      if (attempt < retries) await wait(options.retryDelayMs ?? 0, parent)
    }
    fail({ ok: false, error: describe({ index, status: lastStatus }), index, status: lastStatus })
  }

  async function worker(): Promise<void> {
    while (mode === 'ok' && !parent?.aborted) {
      const index = next
      next += 1
      if (index >= total) return
      await fetchOne(index)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  // mode 会在 worker 里改。闭包赋值对控制流分析不可见，这里按运行时的值判断。
  const outcome = mode as 'ok' | 'cancel' | 'fail'
  if (parent?.aborted || outcome === 'cancel') return cancelled()
  if (failure) return failure

  const ordered: Uint8Array[] = []
  for (const part of parts) {
    if (!part) return { ok: false, error: HLS_TEXT.empty }
    ordered.push(part)
  }
  return { ok: true, parts: ordered, bytes }
}
