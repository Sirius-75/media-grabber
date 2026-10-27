/**
 * HLS 清单解析。不访问 chrome，也不发请求。
 *
 * 只接受点播（有 EXT-X-ENDLIST）、未加密的清单。
 * 直播、任何 EXT-X-KEY / EXT-X-SESSION-KEY 加密、字节范围、缺失分片都直接拒绝。
 * EXT-X-DISCONTINUITY 允许：分片仍按出现顺序拼接，不在这里切文件。
 * 相对地址用浏览器的 URL 规则拼到清单地址上，不会把清单 query 里的 token 抄到分片上。
 */

import { formatBytes } from './format'

/** 下载进内存的字节上限。超过就拒绝，避免把扩展页面撑满。 */
export const HLS_HARD_BYTE_LIMIT = 2 * 1024 * 1024 * 1024

/** 还没到上限，但已经值得提醒用户会占很多内存。 */
export const HLS_WARN_BYTE_LIMIT = 512 * 1024 * 1024

/** 分片条数达到这个数就提醒。条数多，拼接时一样占内存。 */
export const HLS_WARN_SEGMENT_COUNT = 300

/** 同时拉取的分片数。调度器默认值，和产品约定一致。 */
export const HLS_DOWNLOAD_CONCURRENCY = 4

/** 每一片失败后的额外尝试次数。加上第一次，一共 3 次。 */
export const HLS_SEGMENT_RETRIES = 2

const FMP4_EXTENSIONS = new Set(['m4s', 'mp4', 'm4v', 'm4a', 'cmfv', 'cmfa'])

export const HLS_TEXT = {
  notPlaylist: '这不是有效的 HLS 清单',
  badPlaylistUrl: '只支持 http 或 https 清单',
  live: '这是直播流（没有 EXT-X-ENDLIST），暂不支持下载',
  sessionKey: '清单使用了加密（EXT-X-SESSION-KEY），不支持加密或 DRM 内容',
  byterange: '暂不支持按字节范围截取的分片（EXT-X-BYTERANGE）',
  mapByterange: '暂不支持带字节范围的初始化段（EXT-X-MAP）',
  gap: '清单里有缺失的分片（EXT-X-GAP），无法下完整文件',
  skip: '清单跳过了部分分片（EXT-X-SKIP），无法下完整文件',
  iframesOnly: '这是关键帧预览清单（EXT-X-I-FRAMES-ONLY），不是完整音视频',
  imagesOnly: '这是图片清单，不是音视频',
  iframeOnlyMaster: '主清单里只有关键帧预览，没有完整清晰度',
  empty: '清单里没有可下载的分片',
  noVariants: '主清单里没有可选的清晰度',
  multipleMap: '清单中途更换了初始化段（EXT-X-MAP），无法拼成一个文件',
  missingUri: '清单里有一条分片缺少地址',
  badUrl: '清单里有不是 http 或 https 的地址',
  variables: '清单使用了变量替换，暂不支持',
  nestedMaster: '选中的地址仍是主清单，请先选择清晰度',
  variantMissing: '清晰度不在这个清单里',
  fmp4NoMap: '这些分片像是 fMP4，但清单里没有 EXT-X-MAP 初始化段，无法拼成可播放文件',
  tooBigActual: '下载内容超过 2GB，为避免占满内存已停止，没有保存文件',
  cancelled: '下载已取消',
  forbidden: '服务器拒绝访问（403）',
  unauthorized: '需要登录或未授权（401）',
  network: '网络连接失败',
  internal: '内部错误，请刷新扩展后重试',
  playlistTooLarge: '清单文件过大，无法解析',
  playlistMissing: '找不到清单（404）',
  busy: '已有下载在进行，请先取消或等待结束',
  offscreen: '无法打开后台下载页，请重试',
  picking: '请选择清晰度',
  inspecting: '正在读取清单…',
  started: '正在下载分片…',
  remuxing: '正在转成 mp4…',
  remuxFallback: '转封装失败，已保存为 .ts，可用 VLC 播放',
  remuxTooBig: '文件较大，转封装可能占满内存，已保存为 .ts，可用 VLC 播放',
  complete: '已完成',
  interrupted: '下载已中断，请重试',
  separateAudio: '这条清晰度的声音在单独的音轨清单里，本次只下载这一路，文件里可能没有声音',
  directBlock: 'HLS 清单不能当直链保存，请用列表里的下载',
} as const

export function hlsEncryptedText(method?: string): string {
  const label = method?.trim()
  if (label) return `清单使用了加密（EXT-X-KEY ${label}），不支持加密或 DRM 内容`
  return '清单使用了加密（EXT-X-KEY），不支持加密或 DRM 内容'
}

export function hlsTooBigEstimateText(bytes: number): string {
  return `预计约 ${formatBytes(bytes)}，超过 2GB 内存上限，已拒绝下载`
}

export function hlsWarnBytesText(bytes: number): string {
  return `预计约 ${formatBytes(bytes)}，拼接时会占用较多内存`
}

export function hlsWarnCountText(count: number): string {
  return `共 ${count} 个分片，拼接时会占用较多内存`
}

export function hlsProgressText(completed: number, total: number): string {
  return `已下载 ${completed}/${total}`
}

export function describePlaylistStatus(status: number, reason?: 'network' | 'too-large'): string {
  if (reason === 'too-large') return HLS_TEXT.playlistTooLarge
  if (status === 401) return HLS_TEXT.unauthorized
  if (status === 403) return HLS_TEXT.forbidden
  if (status === 404) return HLS_TEXT.playlistMissing
  if (status === 0 || reason === 'network') return HLS_TEXT.network
  return `读取清单失败（${status}）`
}

/**
 * 把某一片的 HTTP 状态翻成中文。
 * index 是下载列表里的下标。initCount 大于 0 时，前面几片是初始化段。
 */
export function describeFetchFailure(input: { index: number; initCount: number; status: number }): string {
  const isInit = input.index < input.initCount
  const segmentNo = input.index - input.initCount + 1
  if (input.status === 403) return HLS_TEXT.forbidden
  if (input.status === 401) return HLS_TEXT.unauthorized
  if (input.status === 404) {
    return isInit ? '初始化段缺失（404）' : `第 ${segmentNo} 个分片缺失（404）`
  }
  if (input.status === 0) {
    return isInit ? `初始化段下载失败：${HLS_TEXT.network}` : `第 ${segmentNo} 个分片下载失败：${HLS_TEXT.network}`
  }
  return isInit ? `初始化段下载失败（${input.status}）` : `第 ${segmentNo} 个分片下载失败（${input.status}）`
}

export interface HlsVariant {
  url: string
  bandwidth: number
  width?: number
  height?: number
  label: string
  /** STREAM-INF 写了 AUDIO 组。声音可能不在这一路分片里。 */
  separateAudio: boolean
}

export interface HlsSegment {
  url: string
  duration?: number
}

export interface HlsMedia {
  segments: HlsSegment[]
  /** 有 EXT-X-MAP 时这是初始化段。输出用 mp4，并且拼在分片前面。 */
  initUrl?: string
  /** 有初始化段就是 mp4，否则按 TS 保存。 */
  container: 'ts' | 'mp4'
  durationSeconds: number
  /** 媒体分片数，不含初始化段。 */
  segmentCount: number
}

export type HlsPlaylist =
  | { ok: true; kind: 'master'; variants: HlsVariant[] }
  | { ok: true; kind: 'media'; media: HlsMedia }
  | { ok: false; error: string }

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function variantLabel(input: { bandwidth: number; width?: number; height?: number }): string {
  const parts: string[] = []
  if (input.width && input.height) parts.push(`${input.width}×${input.height}`)
  if (input.bandwidth > 0) parts.push(`${Math.max(1, Math.round(input.bandwidth / 1000))} kbps`)
  return parts.length > 0 ? parts.join(' · ') : '未知清晰度'
}

/** 最高清晰度在前：带宽优先，其次分辨率。 */
export function sortVariants(variants: readonly HlsVariant[]): HlsVariant[] {
  return [...variants].sort((left, right) => {
    if (right.bandwidth !== left.bandwidth) return right.bandwidth - left.bandwidth
    const leftPixels = (left.width ?? 0) * (left.height ?? 0)
    const rightPixels = (right.width ?? 0) * (right.height ?? 0)
    if (rightPixels !== leftPixels) return rightPixels - leftPixels
    if (left.url < right.url) return -1
    if (left.url > right.url) return 1
    return 0
  })
}

export function joinWarnings(parts: Array<string | undefined>): string | undefined {
  const text = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part))
  return text.length > 0 ? text.join('。') : undefined
}

export interface HlsSizeAssessment {
  ok: true
  warning?: string
  estimatedBytes?: number
}

/** 体积估算，再加上「声音可能在另一条清单里」的提醒。 */
export function mediaDownloadWarning(input: {
  segmentCount: number
  durationSeconds: number
  bandwidth?: number
  separateAudio?: boolean
}): HlsSizeAssessment | { ok: false; error: string; estimatedBytes?: number } {
  const assessment = assessHlsSize(input)
  if (!assessment.ok) return assessment
  const warning = joinWarnings([assessment.warning, input.separateAudio ? HLS_TEXT.separateAudio : undefined])
  if (!warning) return assessment
  return assessment.estimatedBytes === undefined
    ? { ok: true, warning }
    : { ok: true, warning, estimatedBytes: assessment.estimatedBytes }
}

/**
 * 用清晰度带宽和分片时长估体积。
 * 没有带宽时只按分片数量提醒。超过 2GB 的估算直接拒绝。
 */
export function assessHlsSize(input: {
  segmentCount: number
  durationSeconds: number
  bandwidth?: number
}): HlsSizeAssessment | { ok: false; error: string; estimatedBytes?: number } {
  let estimatedBytes: number | undefined
  if (
    typeof input.bandwidth === 'number' &&
    Number.isFinite(input.bandwidth) &&
    input.bandwidth > 0 &&
    Number.isFinite(input.durationSeconds) &&
    input.durationSeconds > 0
  ) {
    estimatedBytes = (input.bandwidth / 8) * input.durationSeconds
  }

  if (estimatedBytes !== undefined && (!Number.isFinite(estimatedBytes) || estimatedBytes > HLS_HARD_BYTE_LIMIT)) {
    return {
      ok: false,
      error: hlsTooBigEstimateText(Number.isFinite(estimatedBytes) ? estimatedBytes : HLS_HARD_BYTE_LIMIT + 1),
      estimatedBytes: Number.isFinite(estimatedBytes) ? estimatedBytes : undefined,
    }
  }

  const warning = joinWarnings([
    estimatedBytes !== undefined && estimatedBytes >= HLS_WARN_BYTE_LIMIT
      ? hlsWarnBytesText(estimatedBytes)
      : undefined,
    input.segmentCount >= HLS_WARN_SEGMENT_COUNT ? hlsWarnCountText(input.segmentCount) : undefined,
  ])
  if (warning) return { ok: true, warning, estimatedBytes }
  return estimatedBytes === undefined ? { ok: true } : { ok: true, estimatedBytes }
}

function fail(error: string): HlsPlaylist {
  return { ok: false, error }
}

function stripBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1)
  return text
}

function linesOf(text: string): string[] {
  return stripBom(text)
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function tagOf(line: string): { name: string; rest: string } | undefined {
  if (!line.startsWith('#')) return undefined
  const body = line.slice(1).trim()
  if (!body.toUpperCase().startsWith('EXT')) return undefined
  const colon = body.indexOf(':')
  if (colon === -1) return { name: body.toUpperCase(), rest: '' }
  return { name: body.slice(0, colon).trim().toUpperCase(), rest: body.slice(colon + 1) }
}

/** 解析 EXT-X 的属性列表。引号里的逗号不算分隔。 */
export function parseAttributeList(input: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const source = input.trim()
  let index = 0
  while (index < source.length) {
    while (index < source.length && (source[index] === ',' || source[index] === ' ' || source[index] === '\t')) {
      index += 1
    }
    if (index >= source.length) break
    const eq = source.indexOf('=', index)
    if (eq === -1) break
    const key = source.slice(index, eq).trim().toUpperCase()
    index = eq + 1
    let value = ''
    if (source[index] === '"') {
      index += 1
      const end = source.indexOf('"', index)
      if (end === -1) {
        value = source.slice(index)
        index = source.length
      } else {
        value = source.slice(index, end)
        index = end + 1
      }
    } else {
      const comma = source.indexOf(',', index)
      if (comma === -1) {
        value = source.slice(index).trim()
        index = source.length
      } else {
        value = source.slice(index, comma).trim()
        index = comma
      }
    }
    if (key) attrs.set(key, value)
  }
  return attrs
}

function resolveHttp(base: string, ref: string): string | undefined {
  const raw = ref.trim()
  if (!raw || raw.includes('{$')) return undefined
  try {
    const url = new URL(raw, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.href
  } catch {
    return undefined
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return undefined
  return number
}

function resolutionOf(value: string | undefined): { width: number; height: number } | undefined {
  if (!value) return undefined
  const match = /^(\d+)x(\d+)$/i.exec(value.trim())
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return undefined
  return { width, height }
}

function pathExtension(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop() ?? ''
    const dot = name.lastIndexOf('.')
    if (dot <= 0 || dot === name.length - 1) return ''
    return name.slice(dot + 1).toLowerCase()
  } catch {
    return ''
  }
}

function looksLikeFmp4(url: string): boolean {
  return FMP4_EXTENSIONS.has(pathExtension(url))
}

const IMMEDIATE_REJECT: Record<string, string> = {
  'EXT-X-BYTERANGE': HLS_TEXT.byterange,
  'EXT-X-GAP': HLS_TEXT.gap,
  'EXT-X-SKIP': HLS_TEXT.skip,
  'EXT-X-I-FRAMES-ONLY': HLS_TEXT.iframesOnly,
  'EXT-X-IMAGES-ONLY': HLS_TEXT.imagesOnly,
  'EXT-X-SESSION-KEY': HLS_TEXT.sessionKey,
  'EXT-X-DEFINE': HLS_TEXT.variables,
}

function rejectTag(name: string): string | undefined {
  return IMMEDIATE_REJECT[name]
}

function rejectKey(rest: string): string | undefined {
  const method = (parseAttributeList(rest).get('METHOD') ?? '').toUpperCase()
  if (method === 'NONE') return undefined
  return hlsEncryptedText(method || undefined)
}

interface PendingSegment {
  duration?: number
}

function nextUri(lines: string[], start: number): { uri?: string; index: number; error?: string } {
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (!line.startsWith('#')) return { uri: line, index }
    if (tagOf(line)) return { error: HLS_TEXT.missingUri, index }
    index += 1
  }
  return { error: HLS_TEXT.missingUri, index }
}

export function parseHlsPlaylist(text: string, playlistUrl: string): HlsPlaylist {
  if (!isHttpUrl(playlistUrl)) return fail(HLS_TEXT.badPlaylistUrl)
  const lines = linesOf(text)
  const hasHeader = lines.some((line) => line.toUpperCase() === '#EXTM3U')
  if (!hasHeader) return fail(HLS_TEXT.notPlaylist)
  const master = lines.some((line) => {
    const name = tagOf(line)?.name
    return name === 'EXT-X-STREAM-INF' || name === 'EXT-X-I-FRAME-STREAM-INF'
  })
  return master ? parseMaster(lines, playlistUrl) : parseMedia(lines, playlistUrl)
}

function parseMaster(lines: string[], playlistUrl: string): HlsPlaylist {
  const variants: HlsVariant[] = []
  let sawIframe = false
  for (let index = 0; index < lines.length; index += 1) {
    const tag = tagOf(lines[index])
    if (!tag) continue
    const rejected = rejectTag(tag.name)
    if (rejected) return fail(rejected)
    if (tag.name === 'EXT-X-KEY') {
      const rejectedKey = rejectKey(tag.rest)
      if (rejectedKey) return fail(rejectedKey)
      continue
    }
    if (tag.name === 'EXT-X-I-FRAME-STREAM-INF') {
      sawIframe = true
      continue
    }
    if (tag.name !== 'EXT-X-STREAM-INF') continue
    const attrs = parseAttributeList(tag.rest)
    const found = nextUri(lines, index + 1)
    if (!found.uri) return fail(found.error ?? HLS_TEXT.missingUri)
    index = found.index
    if (found.uri.includes('{$')) return fail(HLS_TEXT.variables)
    const url = resolveHttp(playlistUrl, found.uri)
    if (!url) return fail(HLS_TEXT.badUrl)
    const bandwidth = positiveInteger(attrs.get('BANDWIDTH')) ?? positiveInteger(attrs.get('AVERAGE-BANDWIDTH')) ?? 0
    const resolution = resolutionOf(attrs.get('RESOLUTION'))
    const variant: HlsVariant = {
      url,
      bandwidth,
      label: variantLabel({ bandwidth, width: resolution?.width, height: resolution?.height }),
      separateAudio: Boolean(attrs.get('AUDIO')),
    }
    if (resolution) {
      variant.width = resolution.width
      variant.height = resolution.height
    }
    variants.push(variant)
  }
  if (variants.length === 0) return fail(sawIframe ? HLS_TEXT.iframeOnlyMaster : HLS_TEXT.noVariants)
  return { ok: true, kind: 'master', variants: sortVariants(variants) }
}

function parseMedia(lines: string[], playlistUrl: string): HlsPlaylist {
  const segments: HlsSegment[] = []
  let initUrl: string | undefined
  let sawEndlist = false
  let durationSum = 0
  let pending: PendingSegment | undefined

  const pushUri = (raw: string): string | undefined => {
    if (raw.includes('{$')) return HLS_TEXT.variables
    const url = resolveHttp(playlistUrl, raw)
    if (!url) return HLS_TEXT.badUrl
    const segment: HlsSegment = { url }
    if (pending?.duration !== undefined) {
      segment.duration = pending.duration
      durationSum += pending.duration
    }
    segments.push(segment)
    pending = undefined
    return undefined
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const tag = tagOf(line)
    if (!tag) {
      if (line.startsWith('#')) continue
      const error = pushUri(line)
      if (error) return fail(error)
      continue
    }
    // 先认加密和明确不支持的标签，避免夹在 EXTINF 和地址之间时被说成「缺少地址」。
    if (tag.name === 'EXT-X-KEY') {
      const rejectedKey = rejectKey(tag.rest)
      if (rejectedKey) return fail(rejectedKey)
      continue
    }
    const rejected = rejectTag(tag.name)
    if (rejected) return fail(rejected)
    if (pending) return fail(HLS_TEXT.missingUri)
    if (tag.name === 'EXT-X-ENDLIST') {
      sawEndlist = true
      continue
    }
    if (tag.name === 'EXT-X-MAP') {
      const attrs = parseAttributeList(tag.rest)
      if (attrs.has('BYTERANGE')) return fail(HLS_TEXT.mapByterange)
      const uri = attrs.get('URI')
      if (!uri) return fail(HLS_TEXT.missingUri)
      if (uri.includes('{$')) return fail(HLS_TEXT.variables)
      const resolved = resolveHttp(playlistUrl, uri)
      if (!resolved) return fail(HLS_TEXT.badUrl)
      if (initUrl && initUrl !== resolved) return fail(HLS_TEXT.multipleMap)
      initUrl = resolved
      continue
    }
    if (tag.name === 'EXTINF') {
      const comma = tag.rest.indexOf(',')
      const rawDuration = (comma === -1 ? tag.rest : tag.rest.slice(0, comma)).trim()
      const duration = Number(rawDuration)
      pending = {
        duration: Number.isFinite(duration) && duration >= 0 ? duration : undefined,
      }
      continue
    }
    // EXT-X-DISCONTINUITY、日期、打点这些不改变分片字节，忽略。
  }

  if (pending) return fail(HLS_TEXT.missingUri)
  if (!sawEndlist) return fail(HLS_TEXT.live)
  if (segments.length === 0) return fail(HLS_TEXT.empty)
  if (!initUrl && segments.some((segment) => looksLikeFmp4(segment.url))) return fail(HLS_TEXT.fmp4NoMap)

  const media: HlsMedia = {
    segments,
    container: initUrl ? 'mp4' : 'ts',
    durationSeconds: durationSum,
    segmentCount: segments.length,
  }
  if (initUrl) media.initUrl = initUrl
  return { ok: true, kind: 'media', media }
}
