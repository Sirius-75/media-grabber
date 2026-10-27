/**
 * 按扩展名和 Content-Type 判断媒体类型。规则见 PLAN.md 第 5 节。
 *
 * 两条规则任意命中一条即视为媒体。都命中但不一致时，以 Content-Type 为准。
 * 未列入名单的 Content-Type（例如 application/octet-stream）不算命中，仍按扩展名判断。
 * .ts / .m4s 是分片，即使 Content-Type 看起来像媒体也不收录。
 * 状态码 ≥ 400，以及 206 只更新大小，属于嗅探层，不在这里处理。
 */

import type { MediaKind } from './types'

/**
 * 一次分类的结果。
 * 普通地址不是媒体，或是 .ts / .m4s 分片时，函数返回 null。
 * blob / data 总会返回结果，并且 downloadable 为 false。
 */
export interface MediaClassification {
  /** blob / data 在缺少 MIME 时可能无法判断种类。 */
  kind?: MediaKind
  /** 不带点：mp4 / webm / mp3 / m4a / m3u8 / mpd。 */
  ext?: string
  /** 参与判断的 MIME，小写且去掉参数。 */
  mime?: string
  downloadable: boolean
  note?: string
}

interface RecognizedMedia {
  kind: MediaKind
  ext: string
  downloadable: boolean
  note?: string
}

const BLOB_NOTE = 'blob 地址，无法直接下载'
const DATA_NOTE = 'data 地址，无法直接下载'
const HLS_NOTE = 'HLS 清单，可下载未加密的点播'
const DASH_NOTE = 'DASH 清单，仅支持复制链接'

/** 看 pathname 的后缀，不看 query 和 hash。 */
const EXTENSIONS: Record<string, RecognizedMedia> = {
  mp4: { kind: 'video', ext: 'mp4', downloadable: true },
  webm: { kind: 'video', ext: 'webm', downloadable: true },
  mp3: { kind: 'audio', ext: 'mp3', downloadable: true },
  m4a: { kind: 'audio', ext: 'm4a', downloadable: true },
  m3u8: { kind: 'hls', ext: 'm3u8', downloadable: false, note: HLS_NOTE },
  mpd: { kind: 'dash', ext: 'mpd', downloadable: false, note: DASH_NOTE },
}

/** HLS / DASH 的媒体分片，不作为可展示条目。 */
const SEGMENT_EXTENSIONS = new Set(['ts', 'm4s'])

const MIME_TYPES: Record<string, RecognizedMedia> = {
  'video/mp4': { kind: 'video', ext: 'mp4', downloadable: true },
  'video/webm': { kind: 'video', ext: 'webm', downloadable: true },
  'audio/mpeg': { kind: 'audio', ext: 'mp3', downloadable: true },
  'audio/mp4': { kind: 'audio', ext: 'm4a', downloadable: true },
  'audio/x-m4a': { kind: 'audio', ext: 'm4a', downloadable: true },
  'application/vnd.apple.mpegurl': {
    kind: 'hls',
    ext: 'm3u8',
    downloadable: false,
    note: HLS_NOTE,
  },
  'application/x-mpegurl': {
    kind: 'hls',
    ext: 'm3u8',
    downloadable: false,
    note: HLS_NOTE,
  },
  'audio/mpegurl': {
    kind: 'hls',
    ext: 'm3u8',
    downloadable: false,
    note: HLS_NOTE,
  },
  'application/dash+xml': {
    kind: 'dash',
    ext: 'mpd',
    downloadable: false,
    note: DASH_NOTE,
  },
}

function schemeOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:/i.exec(url.trim())
  if (!match) return ''
  return match[0].slice(0, -1).toLowerCase()
}

function stripHash(value: string): string {
  const hashAt = value.indexOf('#')
  return hashAt === -1 ? value : value.slice(0, hashAt)
}

function stripQueryAndHash(value: string): string {
  const noHash = stripHash(value)
  const queryAt = noHash.indexOf('?')
  return queryAt === -1 ? noHash : noHash.slice(0, queryAt)
}

/** 绝对 URL 用 pathname；相对地址手动去掉 query 和 hash，避免被当成扩展名。 */
function pathWithoutQueryAndHash(url: string): string {
  const trimmed = url.trim()
  try {
    return new URL(trimmed).pathname
  } catch {
    return stripQueryAndHash(trimmed)
  }
}

function lastPathSegment(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

function fileExtension(url: string): string | null {
  const rawSegment = lastPathSegment(pathWithoutQueryAndHash(url))
  if (rawSegment === '') return null

  // pathname 不会把 %2E 解成点，分类前再解一次，只解最后一段。
  let name = rawSegment
  try {
    name = decodeURIComponent(rawSegment)
  } catch {
    name = rawSegment
  }

  // %2F 解出来之后才是真正的文件名。
  const base = lastPathSegment(name)
  const dot = base.lastIndexOf('.')
  // 「.mp4」是隐藏文件名，不是扩展名；末尾的点也没有扩展名。
  if (dot <= 0 || dot === base.length - 1) return null
  return base.slice(dot + 1).toLowerCase()
}

function isSegmentUrl(url: string): boolean {
  const ext = fileExtension(url)
  return ext !== null && SEGMENT_EXTENSIONS.has(ext)
}

function toClassification(media: RecognizedMedia, mime?: string): MediaClassification {
  const result: MediaClassification = {
    kind: media.kind,
    ext: media.ext,
    downloadable: media.downloadable,
  }
  if (mime) result.mime = mime
  if (media.note) result.note = media.note
  return result
}

/**
 * 只取 data: 头部的 MIME，不扫描逗号后的载荷。
 * 没有逗号时最多看前 256 个字符，避免超长 data URL 被整段拿去解析。
 */
function mimeFromDataUrl(url: string): string | null {
  const trimmed = url.trim()
  const commaAt = trimmed.indexOf(',')
  const header = (commaAt === -1 ? trimmed.slice(5, 256) : trimmed.slice(5, commaAt)).trim()
  const type = header.split(';')[0].trim()
  return type || null
}

/** 去掉参数并小写。不是 type/subtype 形式则视为未命中。 */
function normalizeMime(mime: string): string | null {
  const mediaType = mime.trim().toLowerCase().split(';')[0].trim()
  if (!mediaType.includes('/')) return null
  return mediaType
}

/** 只按 Content-Type 判断。无法识别时返回 null。 */
export function classifyByMime(mime: string): MediaClassification | null {
  const normalized = normalizeMime(mime)
  if (!normalized) return null
  const media = MIME_TYPES[normalized]
  if (!media) return null
  return toClassification(media, normalized)
}

function extensionClassification(url: string): MediaClassification | null {
  if (isSegmentUrl(url)) return null
  const ext = fileExtension(url)
  if (!ext) return null
  const media = EXTENSIONS[ext]
  if (!media) return null
  return toClassification(media)
}

function undownloadable(
  scheme: 'blob' | 'data',
  mime: string | null | undefined,
  url: string,
): MediaClassification {
  const note = scheme === 'blob' ? BLOB_NOTE : DATA_NOTE
  const fromArgument = typeof mime === 'string' ? classifyByMime(mime) : null
  let fromEmbedded: MediaClassification | null = null
  if (scheme === 'data') {
    const embedded = mimeFromDataUrl(url)
    if (embedded) fromEmbedded = classifyByMime(embedded)
  }
  const recognized = fromArgument ?? fromEmbedded
  if (!recognized) return { downloadable: false, note }
  return { ...recognized, downloadable: false, note }
}

/** 只按 URL 判断。blob / data 一律不可直接下载。 */
export function classifyByUrl(url: string): MediaClassification | null {
  const scheme = schemeOf(url)
  if (scheme === 'blob' || scheme === 'data') return undownloadable(scheme, undefined, url)
  return extensionClassification(url)
}

/**
 * 综合 URL 和 Content-Type。
 * mime 省略、空白或无法识别时，退回扩展名。
 * 分片链接返回 null，不因为 MIME 被重新放进列表。
 */
export function classify(url: string, mime?: string | null): MediaClassification | null {
  const scheme = schemeOf(url)
  if (scheme === 'blob' || scheme === 'data') return undownloadable(scheme, mime, url)
  if (isSegmentUrl(url)) return null
  if (typeof mime === 'string') {
    const fromMime = classifyByMime(mime)
    if (fromMime) return fromMime
  }
  return extensionClassification(url)
}

/**
 * 去重用的 URL。去掉 hash，保留 query（签名不同视为不同资源）。
 * 能被 URL 解析时，顺带把协议和主机名小写，并去掉默认端口。
 * 解析失败时只去掉 hash，不改路径大小写，也不删 query。
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    parsed.hash = ''
    return parsed.href
  } catch {
    return stripHash(trimmed)
  }
}
