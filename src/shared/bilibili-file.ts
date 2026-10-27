/**
 * 把一条 B 站 fMP4 拉进内存，并决定存成 .mp4 还是 .m4a。
 * fetch 不设置 headers。Referer 由 service worker 的会话规则补上，不在这里写。
 */

import type { BilibiliRole } from './types'
import { BILIBILI_TEXT, bilibiliStatusText } from './bilibili'
import { HLS_HARD_BYTE_LIMIT, HLS_TEXT, HLS_WARN_BYTE_LIMIT, hlsWarnBytesText } from './hls'
import type { FetchLike } from './hls-fetch'

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

async function fetchOnce(
  url: string,
  signal: AbortSignal,
  options: FetchBilibiliOptions,
  maxBytes: number,
  warnBytes: number,
): Promise<BilibiliFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  // 故意不放 headers。加了就会变成在这里伪造 Referer。
  const init: RequestInit = {
    signal,
    credentials: 'include',
    redirect: 'follow',
  }
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    if (signal.aborted) return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
    throw error
  }
  if (response.status !== 200) return statusError(response.status)
  const declared = declaredLength(response)
  if (declared !== undefined && declared > maxBytes) return { ok: false, error: HLS_TEXT.tooBigActual }
  const body = await readBody(response, maxBytes, signal, options.onProgress, declared)
  if (!body.ok) return body
  const type = contentType(response)
  const decided = decideSaveExt(options.role, type, body.bytes)
  const size = declared ?? body.bytes.byteLength
  const file: BilibiliFetchedFile = { bytes: body.bytes, ext: decided.ext, mime: decided.mime }
  if (decided.note) file.note = decided.note
  if (size >= warnBytes) file.warning = hlsWarnBytesText(size)
  return { ok: true, file }
}

/** 拉完整文件。401 / 403 立即失败，不换请求头再试。 */
export async function fetchBilibiliFile(
  url: string,
  signal: AbortSignal,
  options: FetchBilibiliOptions = {},
): Promise<BilibiliFetchResult> {
  const maxBytes = options.maxBytes ?? HLS_HARD_BYTE_LIMIT
  const warnBytes = options.warnBytes ?? HLS_WARN_BYTE_LIMIT
  const retries = options.retries ?? 2
  const retryDelayMs = options.retryDelayMs ?? 200
  let last: BilibiliFetchResult = { ok: false, error: HLS_TEXT.network, status: 0 }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal.aborted) return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
    try {
      last = await fetchOnce(url, signal, options, maxBytes, warnBytes)
    } catch (error) {
      if (signal.aborted) return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
      last = { ok: false, error: HLS_TEXT.network, status: 0 }
      void error
    }
    if (last.ok || last.cancelled) return last
    if (!canRetry(last.status) || attempt === retries) return last
    try {
      await delay(retryDelayMs, signal)
    } catch {
      return { ok: false, error: HLS_TEXT.cancelled, cancelled: true }
    }
  }
  return last
}
