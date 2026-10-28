/**
 * 把一条 B 站 fMP4 拉进内存，并决定存成 .mp4 还是 .m4a。
 * 平时不设置 headers。大文件分段时只加 Range。
 * Referer 由 service worker 的会话规则补上，不在这里写。
 * 同一条规则按主机匹配，并发的 Range 请求打到同一主机就会一起命中，不用再加规则。
 */

import type { BilibiliRole } from './types'
import { BILIBILI_TEXT, bilibiliStatusText } from './bilibili'
import { HLS_HARD_BYTE_LIMIT, HLS_TEXT, HLS_WARN_BYTE_LIMIT, hlsWarnBytesText } from './hls'
import type { FetchLike } from './hls-fetch'

/** 达到这个大小才尝试并行分段。再小的文件一条连接就够。 */
export const BILIBILI_PARALLEL_MIN_BYTES = 16 * 1024 * 1024

/** 每一段大约这么大。最后一段可以更短。改这个常量即可调整段长。 */
export const BILIBILI_PARALLEL_CHUNK_BYTES = 8 * 1024 * 1024

/** 同时打开的连接数。改这个常量即可调整并发。 */
export const BILIBILI_PARALLEL_CONCURRENCY = 4

export interface BilibiliFetchedFile {
  bytes: Uint8Array
  ext: 'mp4' | 'm4a'
  mime: string
  /** 没能从类型或文件头判断时，仍然存成 .mp4，并用这句话说明。 */
  note?: string
  warning?: string
}

export type BilibiliFetchResult =
  | { ok: true; file: BilibiliFetchedFile }
  | { ok: false; error: string; cancelled?: boolean; status?: number }

export interface FetchBilibiliOptions {
  fetchImpl?: FetchLike
  /** 测试时把上限调小。缺省是 2GB。 */
  maxBytes?: number
  warnBytes?: number
  /** 失败后的额外次数。401 / 403 不重试。 */
  retries?: number
  retryDelayMs?: number
  /** 已知是视频或音频时，扩展名以这个为准，不再猜。 */
  role?: BilibiliRole
  onProgress?: (received: number, total: number | undefined) => void
  /** 测试时把并行阈值调小。缺省见 BILIBILI_PARALLEL_MIN_BYTES。 */
  parallelMinBytes?: number
  /** 测试时把段长调小。缺省见 BILIBILI_PARALLEL_CHUNK_BYTES。 */
  parallelChunkBytes?: number
  /** 测试时把并发调小。缺省见 BILIBILI_PARALLEL_CONCURRENCY。 */
  parallelConcurrency?: number
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function declaredLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length')
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined
  const value = Number(raw.trim())
  if (!Number.isSafeInteger(value)) return undefined
  return value
}

function contentType(response: Response): string | undefined {
  const raw = response.headers.get('content-type')
  if (!raw) return undefined
  const media = raw.split(';')[0]?.trim().toLowerCase() ?? ''
  return media || undefined
}

function readU32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.length) return undefined
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function ascii(bytes: Uint8Array, offset: number, length: number): string | undefined {
  if (offset < 0 || offset + length > bytes.length) return undefined
  let text = ''
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0)
  }
  return text
}

/**
 * 在 moov 里找 hdlr 的 handler。
 * vide 是视频轨，soun 是音频轨。mdat 按盒子长度跳过，不在里面搜。
 */
export function handlerKind(bytes: Uint8Array): 'video' | 'audio' | 'unknown' {
  let video = false
  let audio = false

  const walk = (start: number, end: number, depth: number): void => {
    if (depth > 8) return
    let offset = start
    while (offset + 8 <= end) {
      const size32 = readU32(bytes, offset)
      const type = ascii(bytes, offset + 4, 4)
      if (size32 === undefined || !type) return
      let size = size32
      let header = 8
      if (size32 === 1) {
        const high = readU32(bytes, offset + 8)
        const low = readU32(bytes, offset + 12)
        if (high === undefined || low === undefined || high > 0) return
        size = low
        header = 16
      }
      if (size === 0) size = end - offset
      if (size < header || offset + size > end) return
      const bodyStart = offset + header
      const bodyEnd = offset + size
      if (type === 'hdlr') {
        const handler = ascii(bytes, bodyStart + 8, 4)
        if (handler === 'vide') video = true
        if (handler === 'soun') audio = true
      } else if (type === 'moov' || type === 'trak' || type === 'mdia') {
        walk(bodyStart, bodyEnd, depth + 1)
      }
      offset += size
    }
  }

  walk(0, bytes.length, 0)
  if (video) return 'video'
  if (audio) return 'audio'
  return 'unknown'
}

/** 已知轨道直接定扩展名。未知时先看 Content-Type，再看 handler。 */
export function decideSaveExt(
  role: BilibiliRole | undefined,
  content: string | undefined,
  bytes: Uint8Array,
): { ext: 'mp4' | 'm4a'; mime: string; note?: string } {
  if (role === 'audio') return { ext: 'm4a', mime: 'audio/mp4' }
  if (role === 'video' || role === 'file') return { ext: 'mp4', mime: 'video/mp4' }
  if (content?.startsWith('audio/')) return { ext: 'm4a', mime: 'audio/mp4' }
  if (content?.startsWith('video/')) return { ext: 'mp4', mime: 'video/mp4' }
  const kind = handlerKind(bytes)
  if (kind === 'audio') return { ext: 'm4a', mime: 'audio/mp4' }
  if (kind === 'video') return { ext: 'mp4', mime: 'video/mp4' }
  return { ext: 'mp4', mime: 'video/mp4', note: BILIBILI_TEXT.uncertain }
}

function statusError(status: number): { ok: false; error: string; status: number } {
  if (status === 401) return { ok: false, error: HLS_TEXT.unauthorized, status }
  if (status === 403) return { ok: false, error: HLS_TEXT.forbidden, status }
  if (status === 404) return { ok: false, error: BILIBILI_TEXT.missing, status }
  if (status === 206) return { ok: false, error: BILIBILI_TEXT.partial, status }
  if (status === 0) return { ok: false, error: HLS_TEXT.network, status }
  return { ok: false, error: bilibiliStatusText(status), status }
}

function canRetry(status: number | undefined): boolean {
  if (status === undefined || status === 0) return true
  return status === 408 || status === 429 || status >= 500
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  onProgress: FetchBilibiliOptions['onProgress'],
  declared: number | undefined,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string; cancelled?: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (signal.aborted) return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
    if (bytes.byteLength > maxBytes) return { ok: false, error: HLS_TEXT.tooBigActual }
    onProgress?.(bytes.byteLength, declared)
    return { ok: true, bytes }
  }
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel()
        return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
      }
      const step = await reader.read()
      if (step.done) break
      const chunk = step.value
      if (!chunk || chunk.byteLength === 0) continue
      if (received + chunk.byteLength > maxBytes) {
        await reader.cancel()
        return { ok: false, error: HLS_TEXT.tooBigActual }
      }
      chunks.push(chunk)
      received += chunk.byteLength
      onProgress?.(received, declared)
    }
  } catch (error) {
    if (signal.aborted) return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
    throw error
  }
  return { ok: true, bytes: received === 0 ? new Uint8Array() : concatBytes(chunks, received) }
}

interface ChunkSpan {
  start: number
  end: number
}

interface ParallelPlan {
  kind: 'parallel'
  total: number
  type: string | undefined
}

type FetchStep = { kind: 'result'; result: BilibiliFetchResult } | ParallelPlan

function cancelledResult(): BilibiliFetchResult {
  return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
}

function networkResult(): BilibiliFetchResult {
  return { ok: false, error: HLS_TEXT.network, status: 0 }
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) return fallback
  return value
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) return fallback
  return value
}

/** 进度只往前走。分段重试或退回单连接时，不把已经显示过的字节数减回去。 */
function monotonicProgress(
  onProgress: FetchBilibiliOptions['onProgress'],
): (received: number, total: number | undefined) => void {
  let high = 0
  return (received, total) => {
    if (!Number.isFinite(received) || received < high) return
    high = received
    onProgress?.(received, total)
  }
}

function plainInit(signal: AbortSignal): RequestInit {
  // 故意不放 headers。加了就会变成在这里伪造 Referer。
  return { signal, credentials: 'include', redirect: 'follow' }
}

function rangeInit(signal: AbortSignal, start: number, end: number): RequestInit {
  // 只允许这一个头。Referer、Cookie、UA、Origin 都不在这里写。
  return {
    signal,
    credentials: 'include',
    redirect: 'follow',
    headers: { Range: `bytes=${start}-${end}` },
  }
}

async function safeCancel(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // 连接已经断了就不用再取消。
  }
}

/** Content-Range 形如 bytes 0-99/1000。星号表示总长未知。 */
function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number | undefined } | undefined {
  if (!header) return undefined
  const match = /^bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+|\*)\s*$/i.exec(header.trim())
  if (!match) return undefined
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined
  if (match[3] === '*') return { start, end, total: undefined }
  const total = Number(match[3])
  if (!Number.isSafeInteger(total) || total < end + 1) return undefined
  return { start, end, total }
}

/** Accept-Ranges 明确写 none 时不再探测。缺省或 bytes 都再发一次 Range 确认。 */
function shouldProbeRange(response: Response): boolean {
  const raw = response.headers.get('accept-ranges')
  if (!raw) return true
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '')
  if (parts.includes('bytes')) return true
  if (parts.includes('none')) return false
  return true
}

function buildChunks(total: number, chunkBytes: number): ChunkSpan[] {
  const spans: ChunkSpan[] = []
  for (let start = 0; start < total; start += chunkBytes) {
    spans.push({ start, end: Math.min(total - 1, start + chunkBytes - 1) })
  }
  return spans
}

function finishFile(
  bytes: Uint8Array,
  type: string | undefined,
  role: BilibiliRole | undefined,
  size: number,
  warnBytes: number,
): BilibiliFetchResult {
  const decided = decideSaveExt(role, type, bytes)
  const file: BilibiliFetchedFile = { bytes, ext: decided.ext, mime: decided.mime }
  if (decided.note) file.note = decided.note
  if (size >= warnBytes) file.warning = hlsWarnBytesText(size)
  return { ok: true, file }
}

/**
 * 用 1 个字节确认对方真的按 Range 回答。
 * 失败、返回 200，或总长对不上时，调用方继续读已经打开的那条连接。
 */
async function probeRangeSupport(
  url: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  expectedTotal: number,
): Promise<boolean> {
  if (signal.aborted) return false
  let response: Response
  try {
    response = await fetchImpl(url, rangeInit(signal, 0, 0))
  } catch {
    return false
  }
  try {
    if (signal.aborted || response.status !== 206) return false
    const parsed = parseContentRange(response.headers.get('content-range'))
    return parsed?.start === 0 && parsed.end === 0 && parsed.total === expectedTotal
  } finally {
    await safeCancel(response)
  }
}

async function readExact(
  response: Response,
  target: Uint8Array,
  offset: number,
  expected: number,
  signal: AbortSignal,
  onReceived: (got: number) => void,
): Promise<{ ok: true } | { ok: false; error: string; cancelled?: boolean; status?: number }> {
  if (offset < 0 || expected < 0 || offset + expected > target.byteLength) {
    return { ok: false, error: BILIBILI_TEXT.rangeMismatch, status: 416 }
  }
  const mismatch = { ok: false as const, error: BILIBILI_TEXT.rangeMismatch, status: 0 }
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (signal.aborted) return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
    if (bytes.byteLength !== expected) return mismatch
    target.set(bytes, offset)
    onReceived(expected)
    return { ok: true }
  }
  let got = 0
  try {
    while (got < expected) {
      if (signal.aborted) {
        await reader.cancel()
        return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
      }
      const step = await reader.read()
      if (step.done) break
      const chunk = step.value
      if (!chunk || chunk.byteLength === 0) continue
      if (got + chunk.byteLength > expected) {
        await reader.cancel()
        return mismatch
      }
      target.set(chunk, offset + got)
      got += chunk.byteLength
      onReceived(got)
    }
  } catch (error) {
    if (signal.aborted) return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
    throw error
  }
  if (got !== expected) return mismatch
  return { ok: true }
}

/**
 * 分段写进预先分配的 total 字节，避免再留一份完整副本。
 * 某一段返回 200 整文件时，kind 为 fallback，调用方改走单连接。
 */
async function fetchParallel(
  url: string,
  signal: AbortSignal,
  options: FetchBilibiliOptions,
  total: number,
  type: string | undefined,
  warnBytes: number,
): Promise<{ kind: 'result'; result: BilibiliFetchResult } | { kind: 'fallback' }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const chunkBytes = positiveInt(options.parallelChunkBytes, BILIBILI_PARALLEL_CHUNK_BYTES)
  const concurrency = positiveInt(options.parallelConcurrency, BILIBILI_PARALLEL_CONCURRENCY)
  const retries = options.retries ?? 2
  const retryDelayMs = options.retryDelayMs ?? 200
  const chunks = buildChunks(total, chunkBytes)
  if (chunks.length === 0) return { kind: 'fallback' }
  let buffer: Uint8Array
  try {
    buffer = new Uint8Array(total)
  } catch {
    return { kind: 'result', result: { ok: false, error: HLS_TEXT.tooBigActual } }
  }
  const received = new Array<number>(chunks.length).fill(0)
  const done = new Array<boolean>(chunks.length).fill(false)
  let reported = 0
  const report = options.onProgress
  const note = (index: number, got: number): void => {
    received[index] = got
    let sum = 0
    for (const value of received) sum += value
    if (sum <= reported) return
    reported = sum
    report?.(reported, total)
  }

  const inner = new AbortController()
  let mode: 'run' | 'fail' | 'fallback' | 'cancel' = 'run'
  let failure: BilibiliFetchResult | undefined
  let cursor = 0
  const onParentAbort = (): void => {
    mode = 'cancel'
    inner.abort()
  }
  if (signal.aborted) onParentAbort()
  else signal.addEventListener('abort', onParentAbort, { once: true })

  const fail = (result: BilibiliFetchResult): void => {
    if (mode !== 'run') return
    mode = 'fail'
    failure = result
    inner.abort()
  }

  const pause = async (): Promise<boolean> => {
    if (mode !== 'run' || signal.aborted) return false
    try {
      await delay(retryDelayMs, inner.signal)
    } catch {
      return false
    }
    return mode === 'run' && !signal.aborted
  }

  const fetchChunk = async (index: number): Promise<void> => {
    const chunk = chunks[index]
    if (!chunk) return
    const expected = chunk.end - chunk.start + 1
    let last: BilibiliFetchResult = networkResult()
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (signal.aborted) {
        if (mode === 'run') mode = 'cancel'
        return
      }
      if (mode !== 'run') return
      received[index] = 0
      try {
        const response = await fetchImpl(url, rangeInit(inner.signal, chunk.start, chunk.end))
        if (mode !== 'run' || signal.aborted) {
          await safeCancel(response)
          if (signal.aborted && mode === 'run') mode = 'cancel'
          return
        }
        // 服务器忽略 Range、把整文件以 200 丢回来时，不能把这份正文当成其中一段。
        if (response.status === 200) {
          await safeCancel(response)
          if (mode === 'run') {
            mode = 'fallback'
            inner.abort()
          }
          return
        }
        if (response.status === 401 || response.status === 403) {
          await safeCancel(response)
          fail(statusError(response.status))
          return
        }
        if (response.status !== 206) {
          await safeCancel(response)
          last = statusError(response.status)
          if (!canRetry(response.status) || attempt === retries || !(await pause())) {
            if (signal.aborted && mode === 'run') mode = 'cancel'
            else fail(last)
            return
          }
          continue
        }
        const parsed = parseContentRange(response.headers.get('content-range'))
        const aligned =
          parsed !== undefined &&
          parsed.start === chunk.start &&
          parsed.end === chunk.end &&
          (parsed.total === undefined || parsed.total === total)
        if (!aligned) {
          await safeCancel(response)
          fail({ ok: false, error: BILIBILI_TEXT.rangeMismatch, status: 416 })
          return
        }
        const read = await readExact(response, buffer, chunk.start, expected, inner.signal, (got) => note(index, got))
        if (mode !== 'run') return
        if (signal.aborted || (!read.ok && read.cancelled)) {
          mode = 'cancel'
          return
        }
        if (!read.ok) {
          last = { ok: false, error: read.error, status: read.status ?? 0 }
          if (!canRetry(last.status) || attempt === retries || !(await pause())) {
            if (signal.aborted && mode === 'run') mode = 'cancel'
            else fail(last)
            return
          }
          continue
        }
        note(index, expected)
        done[index] = true
        return
      } catch (error) {
        if (mode !== 'run') return
        if (signal.aborted) {
          mode = 'cancel'
          return
        }
        last = networkResult()
        void error
        if (attempt === retries || !(await pause())) {
          if (signal.aborted && mode === 'run') mode = 'cancel'
          else fail(last)
          return
        }
      }
    }
    if (mode === 'run') fail(last)
  }

  const worker = async (): Promise<void> => {
    while (mode === 'run' && !signal.aborted) {
      const index = cursor
      cursor += 1
      if (index >= chunks.length) return
      await fetchChunk(index)
    }
  }

  try {
    const workers = Math.max(1, Math.min(concurrency, chunks.length))
    await Promise.all(Array.from({ length: workers }, () => worker()))
  } finally {
    signal.removeEventListener('abort', onParentAbort)
  }

  // mode 会在分段任务里改。闭包赋值跨过 await 之后，控制流分析看不到。
  const outcome = mode as 'run' | 'fail' | 'fallback' | 'cancel'
  if (signal.aborted || outcome === 'cancel') return { kind: 'result', result: cancelledResult() }
  if (outcome === 'fallback') return { kind: 'fallback' }
  if (outcome === 'fail' || failure) return { kind: 'result', result: failure ?? networkResult() }
  if (done.some((item) => !item)) return { kind: 'result', result: networkResult() }
  return { kind: 'result', result: finishFile(buffer, type, options.role, total, warnBytes) }
}

async function fetchOnce(
  url: string,
  signal: AbortSignal,
  options: FetchBilibiliOptions,
  maxBytes: number,
  warnBytes: number,
  allowParallel: boolean,
): Promise<FetchStep> {
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url, plainInit(signal))
  } catch (error) {
    if (signal.aborted) return { kind: 'result', result: cancelledResult() }
    throw error
  }
  if (response.status !== 200) return { kind: 'result', result: statusError(response.status) }
  const declared = declaredLength(response)
  if (declared !== undefined && declared > maxBytes) {
    await safeCancel(response)
    return { kind: 'result', result: { ok: false, error: HLS_TEXT.tooBigActual } }
  }
  const minBytes = nonNegativeInt(options.parallelMinBytes, BILIBILI_PARALLEL_MIN_BYTES)
  if (
    allowParallel &&
    declared !== undefined &&
    declared > 0 &&
    declared >= minBytes &&
    declared <= maxBytes &&
    shouldProbeRange(response)
  ) {
    const supported = await probeRangeSupport(url, signal, fetchImpl, declared)
    if (signal.aborted) {
      await safeCancel(response)
      return { kind: 'result', result: cancelledResult() }
    }
    if (supported) {
      const type = contentType(response)
      await safeCancel(response)
      return { kind: 'parallel', total: declared, type }
    }
  }
  const body = await readBody(response, maxBytes, signal, options.onProgress, declared)
  if (!body.ok) return { kind: 'result', result: body }
  const size = declared ?? body.bytes.byteLength
  return { kind: 'result', result: finishFile(body.bytes, contentType(response), options.role, size, warnBytes) }
}

async function fetchWithRetries(
  url: string,
  signal: AbortSignal,
  options: FetchBilibiliOptions,
  maxBytes: number,
  warnBytes: number,
  allowParallel: boolean,
): Promise<FetchStep> {
  const retries = options.retries ?? 2
  const retryDelayMs = options.retryDelayMs ?? 200
  let last: BilibiliFetchResult = networkResult()
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal.aborted) return { kind: 'result', result: cancelledResult() }
    try {
      const step = await fetchOnce(url, signal, options, maxBytes, warnBytes, allowParallel)
      if (step.kind === 'parallel') return step
      last = step.result
    } catch (error) {
      if (signal.aborted) return { kind: 'result', result: cancelledResult() }
      last = networkResult()
      void error
    }
    if (last.ok || last.cancelled) return { kind: 'result', result: last }
    if (!canRetry(last.status) || attempt === retries) return { kind: 'result', result: last }
    try {
      await delay(retryDelayMs, signal)
    } catch {
      return { kind: 'result', result: cancelledResult() }
    }
  }
  return { kind: 'result', result: last }
}

/** 拉完整文件。401 / 403 立即失败，不换请求头再试。大文件在支持 Range 时并行分段。 */
export async function fetchBilibiliFile(
  url: string,
  signal: AbortSignal,
  options: FetchBilibiliOptions = {},
): Promise<BilibiliFetchResult> {
  const maxBytes = options.maxBytes ?? HLS_HARD_BYTE_LIMIT
  const warnBytes = options.warnBytes ?? HLS_WARN_BYTE_LIMIT
  const tuned: FetchBilibiliOptions = { ...options, onProgress: monotonicProgress(options.onProgress) }
  const first = await fetchWithRetries(url, signal, tuned, maxBytes, warnBytes, true)
  if (first.kind === 'result') return first.result
  const parallel = await fetchParallel(url, signal, tuned, first.total, first.type, warnBytes)
  if (parallel.kind === 'result') return parallel.result
  // 分段请求拿到了整文件。丢掉那份正文，改回单连接，避免拼坏。
  const single = await fetchWithRetries(url, signal, tuned, maxBytes, warnBytes, false)
  return single.kind === 'result' ? single.result : networkResult()
}
