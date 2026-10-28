/**
 * 并行分段用假的 fetch。正文是示例字节，不是真实的 B 站文件。
 */
import { describe, expect, it, vi } from 'vitest'
import { BILIBILI_TEXT } from '../src/shared/bilibili'
import { fetchBilibiliFile } from '../src/shared/bilibili-file'
import { HLS_TEXT, hlsWarnBytesText } from '../src/shared/hls'

const url = 'https://upos-example.bilivideo.com/example-data/video.m4s?token=sample'
const file = Uint8Array.from({ length: 10 }, (_, index) => index + 1)

const parallel = {
  retries: 2,
  retryDelayMs: 0,
  parallelMinBytes: 8,
  parallelChunkBytes: 4,
  parallelConcurrency: 4,
  role: 'video' as const,
}

function responseOf(status: number, bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Response(copy.buffer, { status, headers })
}

function onlyRange(init?: RequestInit): string | null {
  expect(init?.credentials).toBe('include')
  expect(init?.redirect).toBe('follow')
  if (init?.headers === undefined) return null
  const headers = new Headers(init.headers)
  expect([...headers.keys()]).toEqual(['range'])
  return headers.get('range')
}

function full(bytes: Uint8Array, extra: Record<string, string> = {}): Response {
  return responseOf(200, bytes, {
    'Content-Type': 'video/mp4',
    'Content-Length': String(bytes.byteLength),
    'Accept-Ranges': 'bytes',
    ...extra,
  })
}

function ranged(bytes: Uint8Array, start: number, end: number, total = bytes.byteLength): Response {
  const slice = bytes.slice(start, end + 1)
  return responseOf(206, slice, {
    'Content-Type': 'video/mp4',
    'Content-Length': String(slice.byteLength),
    'Content-Range': `bytes ${start}-${end}/${total}`,
  })
}

function spanOf(range: string): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range)
  if (!match) return undefined
  return { start: Number(match[1]), end: Number(match[2]) }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('B 站大文件并行分段（示例数据）', () => {
  it('多段乱序完成，按偏移拼回，进度单调', async () => {
    const finished: string[] = []
    const seen: number[] = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) return full(file)
      const span = spanOf(range)
      expect(span).toBeTruthy()
      if (!span) return responseOf(400, new Uint8Array())
      if (range !== 'bytes=0-0') {
        await wait(range === 'bytes=0-3' ? 40 : 5)
        finished.push(range)
      }
      return ranged(file, span.start, span.end)
    })
    const result = await fetchBilibiliFile(url, new AbortController().signal, {
      ...parallel,
      fetchImpl,
      warnBytes: 1,
      onProgress(received, total) {
        seen.push(received)
        expect(total).toBe(file.byteLength)
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.bytes).toEqual(file)
    expect(result.file.ext).toBe('mp4')
    expect(result.file.warning).toBe(hlsWarnBytesText(file.byteLength))
    expect(finished[0]).not.toBe('bytes=0-3')
    expect(finished).toEqual(expect.arrayContaining(['bytes=0-3', 'bytes=4-7', 'bytes=8-9']))
    expect(seen.length).toBeGreaterThan(0)
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1] ?? 0)
    }
    expect(seen.at(-1)).toBe(file.byteLength)
  })

  it('没有 Accept-Ranges 时，探测成功仍会分段', async () => {
    const ranges: string[] = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) {
        return responseOf(200, file, {
          'Content-Type': 'audio/mp4',
          'Content-Length': String(file.byteLength),
        })
      }
      ranges.push(range)
      const span = spanOf(range)
      if (!span) return responseOf(400, new Uint8Array())
      return ranged(file, span.start, span.end)
    })
    const result = await fetchBilibiliFile(url, new AbortController().signal, {
      ...parallel,
      fetchImpl,
      role: 'unknown',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.ext).toBe('m4a')
    expect(result.file.bytes).toEqual(file)
    expect(ranges).toEqual(expect.arrayContaining(['bytes=0-0', 'bytes=0-3', 'bytes=4-7', 'bytes=8-9']))
  })

  it('某一段 500 后按原规则重试，成功后字节完整', async () => {
    const attempts = new Map<string, number>()
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) return full(file)
      const span = spanOf(range)
      if (!span) return responseOf(400, new Uint8Array())
      if (range === 'bytes=4-7') {
        const count = (attempts.get(range) ?? 0) + 1
        attempts.set(range, count)
        if (count === 1) return responseOf(500, new Uint8Array())
      }
      return ranged(file, span.start, span.end)
    })
    const result = await fetchBilibiliFile(url, new AbortController().signal, { ...parallel, fetchImpl })
    expect(attempts.get('bytes=4-7')).toBe(2)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.bytes).toEqual(file)
  })

  it('Content-Range 和请求不一致时失败，且这一段不重试', async () => {
    const attempts = new Map<string, number>()
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) return full(file)
      const span = spanOf(range)
      if (!span) return responseOf(400, new Uint8Array())
      const count = (attempts.get(range) ?? 0) + 1
      attempts.set(range, count)
      if (range === 'bytes=0-3') {
        return responseOf(206, file.slice(0, 4), {
          'Content-Type': 'video/mp4',
          'Content-Length': '4',
          'Content-Range': `bytes 0-1/${file.byteLength}`,
        })
      }
      return ranged(file, span.start, span.end)
    })
    const result = await fetchBilibiliFile(url, new AbortController().signal, { ...parallel, fetchImpl })
    expect(result).toEqual({ ok: false, error: BILIBILI_TEXT.rangeMismatch, status: 416 })
    expect(attempts.get('bytes=0-3')).toBe(1)
  })

  it('明确不支持 Range 时不探测，直接读已打开的连接', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(onlyRange(init)).toBeNull()
      return full(file, { 'Accept-Ranges': 'none' })
    })
    const result = await fetchBilibiliFile(url, new AbortController().signal, { ...parallel, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.bytes).toEqual(file)
  })

  it('探测失败或探测拿到整文件时，退回单连接', async () => {
    const thrown = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) return full(file)
      if (range === 'bytes=0-0') throw new Error('probe failed')
      throw new Error('探测失败后不应再发分段')
    })
    const recovered = await fetchBilibiliFile(url, new AbortController().signal, {
      ...parallel,
      fetchImpl: thrown,
      retries: 0,
    })
    expect(thrown).toHaveBeenCalledTimes(2)
    expect(recovered.ok).toBe(true)
    if (!recovered.ok) return
    expect(recovered.file.bytes).toEqual(file)

    const whole = new Uint8Array(file.byteLength).fill(0xff)
    const ignored = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) return full(file)
      if (range === 'bytes=0-0') return responseOf(200, whole)
      return responseOf(200, whole)
    })
    const fallback = await fetchBilibiliFile(url, new AbortController().signal, {
      ...parallel,
      fetchImpl: ignored,
      retries: 0,
    })
    expect(fallback.ok).toBe(true)
    if (!fallback.ok) return
    expect(fallback.file.bytes).toEqual(file)
    expect(ignored.mock.calls.some((call) => onlyRange(call[1] as RequestInit | undefined) !== null)).toBe(true)
  })

  it('分段请求返回 200 整文件时退回单连接，不用这份正文当一段', async () => {
    let plain = 0
    const decoy = new Uint8Array(file.byteLength).fill(0xff)
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) {
        plain += 1
        return full(file)
      }
      const span = spanOf(range)
      if (!span) return responseOf(400, new Uint8Array())
      if (range === 'bytes=0-0') return ranged(file, 0, 0)
      return responseOf(200, decoy, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(decoy.byteLength),
      })
    })
    const result = await fetchBilibiliFile(url, new AbortController().signal, {
      ...parallel,
      fetchImpl,
      retries: 0,
    })
    expect(plain).toBe(2)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.bytes).toEqual(file)
    expect(result.file.bytes).not.toEqual(decoy)
  })

  it('取消会立刻停掉所有分段', async () => {
    let segments = 0
    let opened!: () => void
    const gate = new Promise<void>((resolve) => {
      opened = resolve
    })
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) return full(file)
      const span = spanOf(range)
      if (!span) return responseOf(400, new Uint8Array())
      if (range === 'bytes=0-0') return ranged(file, 0, 0)
      segments += 1
      if (segments >= 2) opened()
      await new Promise<void>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('分段没有在取消时停下')), 3000)
        const stop = (): void => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        if (init?.signal?.aborted) stop()
        else init?.signal?.addEventListener('abort', stop, { once: true })
      })
      return ranged(file, span.start, span.end)
    })
    const controller = new AbortController()
    const pending = fetchBilibiliFile(url, controller.signal, { ...parallel, fetchImpl, retries: 0 })
    await gate
    controller.abort()
    const started = Date.now()
    const result = await pending
    expect(Date.now() - started).toBeLessThan(1000)
    expect(result).toEqual({ ok: false, error: HLS_TEXT.cancelled, cancelled: true })
  })

  it('401 和 403 不重试，并停掉其它分段', async () => {
    let denied = 0
    let aborted = 0
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) return full(file)
      const span = spanOf(range)
      if (!span) return responseOf(400, new Uint8Array())
      if (range === 'bytes=0-0') return ranged(file, 0, 0)
      if (range === 'bytes=0-3') {
        denied += 1
        return responseOf(401, new Uint8Array())
      }
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(ranged(file, span.start, span.end)), 3000)
        const stop = (): void => {
          clearTimeout(timer)
          aborted += 1
          reject(new DOMException('Aborted', 'AbortError'))
        }
        if (init?.signal?.aborted) stop()
        else init?.signal?.addEventListener('abort', stop, { once: true })
      })
    })
    const deniedResult = await fetchBilibiliFile(url, new AbortController().signal, { ...parallel, fetchImpl })
    expect(denied).toBe(1)
    expect(aborted).toBeGreaterThan(0)
    expect(deniedResult).toEqual({ ok: false, error: HLS_TEXT.unauthorized, status: 401 })

    const forbidden = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) return full(file)
      if (range === 'bytes=0-0') return ranged(file, 0, 0)
      return responseOf(403, new Uint8Array())
    })
    const forbiddenResult = await fetchBilibiliFile(url, new AbortController().signal, {
      ...parallel,
      fetchImpl: forbidden,
    })
    expect(forbiddenResult).toEqual({ ok: false, error: HLS_TEXT.forbidden, status: 403 })
    const forbiddenRanges = forbidden.mock.calls
      .map((call) => onlyRange(call[1] as RequestInit | undefined))
      .filter((range) => range && range !== 'bytes=0-0')
    expect(new Set(forbiddenRanges).size).toBe(forbiddenRanges.length)
  })

  it('超过上限时直接失败，不发 Range', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(onlyRange(init)).toBeNull()
      return full(file)
    })
    const result = await fetchBilibiliFile(url, new AbortController().signal, {
      fetchImpl,
      retries: 0,
      maxBytes: 4,
      role: 'video',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: false, error: HLS_TEXT.tooBigActual })
  })

  it('总大小未知或文件较小时保持单连接', async () => {
    const unknown = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(onlyRange(init)).toBeNull()
      return responseOf(200, file, { 'Content-Type': 'video/mp4' })
    })
    const unknownResult = await fetchBilibiliFile(url, new AbortController().signal, {
      ...parallel,
      fetchImpl: unknown,
      retries: 0,
    })
    expect(unknown).toHaveBeenCalledTimes(1)
    expect(unknownResult.ok).toBe(true)
    if (!unknownResult.ok) return
    expect(unknownResult.file.bytes).toEqual(file)

    const small = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(onlyRange(init)).toBeNull()
      return full(file)
    })
    const smallResult = await fetchBilibiliFile(url, new AbortController().signal, {
      fetchImpl: small,
      retries: 0,
      role: 'video',
    })
    expect(small).toHaveBeenCalledTimes(1)
    expect(smallResult.ok).toBe(true)
    if (!smallResult.ok) return
    expect(smallResult.file.bytes).toEqual(file)
  })

  it('同时连接数不超过设定的并发', async () => {
    let current = 0
    let peak = 0
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = onlyRange(init)
      if (range === null) return full(file)
      const span = spanOf(range)
      if (!span) return responseOf(400, new Uint8Array())
      if (range === 'bytes=0-0') return ranged(file, 0, 0)
      current += 1
      peak = Math.max(peak, current)
      await wait(30)
      current -= 1
      return ranged(file, span.start, span.end)
    })
    const result = await fetchBilibiliFile(url, new AbortController().signal, {
      ...parallel,
      fetchImpl,
      parallelConcurrency: 2,
    })
    expect(result.ok).toBe(true)
    expect(peak).toBe(2)
  })
})
