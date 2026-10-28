/**
 * B 站播放信息的解析和列表文案。
 * 不访问 chrome，也不发请求。JSON 只用 JSON.parse，不使用 eval。
 * 解析失败就当没看见，不向外抛错。
 */

import { normalizeUrl } from './classify'
import type { BilibiliMeta, BilibiliRole, MediaItem, MediaItemDraft } from './types'
import { BILIBILI_ROLES } from './types'

/** 进度和 popup 用的会话键。形状和 HLS / DASH 任务相同。 */
export const BILIBILI_JOB_STORAGE_KEY = 'bilibili-jobs'

export const BILIBILI_OFFSCREEN = {
  DOWNLOAD: 'BILIBILI_OFFSCREEN_DOWNLOAD',
  CANCEL: 'BILIBILI_OFFSCREEN_CANCEL',
  DONE: 'BILIBILI_OFFSCREEN_DONE',
} as const

/** offscreen 用来通知自己还活着。断开就表示后台下载页没了。 */
export const BILIBILI_PORT = 'bilibili-download'

export const BILIBILI_M4S_LABEL = 'B站 m4s 分轨文件'

/** 页面 playinfo 里的视频或音频。 */
export const BILIBILI_NOTE =
  '只下载页面当前能播放的内容，不支持会员专享。视频和音频默认合并成一个 mp4，也可以勾选「分开保存视频和音频」。链接有有效期，失效后请先刷新页面再下载。'

/** 老式 durl 的单个 mp4。 */
export const BILIBILI_FILE_NOTE =
  '只下载页面当前能播放的内容，不支持会员专享。链接有有效期，失效后请先刷新页面再下载。'

/** 嗅探到的 .m4s。类型要等下载后才能确定。 */
export const BILIBILI_UNKNOWN_NOTE =
  '类型未知。播放器对同一个文件会发很多次 Range 请求，这里只保留一条。下载后按响应的 Content-Type，或 moov 里的 handler（vide / soun）决定保存为 .mp4 或 .m4a。只下载页面当前能播放的内容，不支持会员专享。链接有有效期，失效后请先刷新页面再下载。'

export const BILIBILI_TEXT = {
  badPage: '只能从 http 或 https 页面下载',
  badMedia: '媒体地址不是 http 或 https',
  badHost: '媒体地址的主机无法套用 Referer 规则',
  tooManyRules: '需要的 Referer 规则超过了预留数量',
  refererFailed: '无法设置下载所需的 Referer，下载没有开始',
  noAudio: '没有可一起下载的音频',
  partial: '服务器只返回了部分内容，无法保存完整文件',
  missing: '找不到媒体文件（404）',
  uncertain: '未能判断音视频类型，已保存为 .mp4',
  audioCancelled: '视频已保存。音频下载已取消',
  preparing: '正在准备下载…',
} as const

export function bilibiliStatusText(status: number): string {
  return `下载失败（${status}）`
}

const PLAYINFO_MARKER = /window\.__playinfo__\s*=/g

/** 这些 query 只表示这一次 Range，不是另一个文件。值不像字节范围时保留。 */
const RANGE_QUERY = new Set(['range', 'bytes', 'start', 'end'])

export interface BilibiliTrack {
  url: string
  role: BilibiliRole
  label: string
  ext: 'm4s' | 'mp4'
  qualityId?: number
  bandwidth?: number
  width?: number
  height?: number
  codecs?: string
}

interface SniffHeader {
  name?: string
  value?: string
}

/** 嗅探层能提供的字段。单测不必拼完整的 Chrome details。 */
export interface BilibiliSniffInput {
  url: string
  tabId: number
  statusCode: number
  responseHeaders?: readonly SniffHeader[]
  timeStamp?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function textField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return normalizeUrl(url.href) || undefined
  } catch {
    return undefined
  }
}

/**
 * 从赋值号后面截一段 JSON。
 * 只认引号和括号，字符串里的括号不算。不执行脚本。
 */
function sliceJsonValue(source: string, start: number): string | undefined {
  const open = source[start]
  if (open !== '{' && open !== '[') return undefined
  const stack: string[] = [open === '{' ? '}' : ']']
  let inString = false
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] ?? ''
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      const expected = stack.pop()
      if (char !== expected) return undefined
      if (stack.length === 0) return source.slice(start, index + 1)
    }
  }
  return undefined
}

/** 一个 script 里可能写了不止一次。失败的那次跳过。 */
export function readPlayinfoValues(source: string): unknown[] {
  if (!source.includes('__playinfo__')) return []
  const found: unknown[] = []
  PLAYINFO_MARKER.lastIndex = 0
  for (const match of source.matchAll(PLAYINFO_MARKER)) {
    let index = match.index + match[0].length
    while (index < source.length && /\s/.test(source[index] ?? '')) index += 1
    const json = sliceJsonValue(source, index)
    if (!json) continue
    try {
      found.push(JSON.parse(json))
    } catch {
      // 不是 JSON 就忽略。页面上别的脚本不影响这条。
    }
  }
  return found
}

function payloadOf(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (isRecord(value.data)) return value.data
  return value
}

function qualityNames(payload: Record<string, unknown>): Map<number, string> {
  const names = new Map<number, string>()
  const ids = payload.accept_quality
  const labels = payload.accept_description
  if (!Array.isArray(ids) || !Array.isArray(labels)) return names
  const count = Math.min(ids.length, labels.length)
  for (let index = 0; index < count; index += 1) {
    const id = finiteNumber(ids[index])
    const label = labels[index]
    if (id === undefined || typeof label !== 'string' || label.trim() === '') continue
    names.set(id, label.trim())
  }
  return names
}

/** 视频编码缩成弹窗上能看懂的短名。不认识就不加。 */
export function codecShort(codecs: string | undefined): string | undefined {
  const head = codecs?.split(',')[0]?.trim().toLowerCase() ?? ''
  if (!head) return undefined
  if (head.startsWith('avc')) return 'AVC'
  if (head.startsWith('hev') || head.startsWith('hvc')) return 'HEVC'
  if (head.startsWith('av01') || head.startsWith('av1')) return 'AV1'
  if (head.startsWith('vp09') || head.startsWith('vp9')) return 'VP9'
  return undefined
}

export function videoTrackLabel(input: {
  qualityText?: string
  width?: number
  height?: number
  qualityId?: number
  codecs?: string
}): string {
  const quality =
    input.qualityText ??
    (input.width !== undefined && input.height !== undefined && input.width > 0 && input.height > 0
      ? `${input.width}×${input.height}`
      : undefined) ??
    (input.qualityId !== undefined ? `画质 ${input.qualityId}` : undefined)
  const codec = codecShort(input.codecs)
  const head = quality ? `B站视频 ${quality}` : 'B站视频'
  return codec ? `${head} · ${codec}` : head
}

export function audioTrackLabel(bandwidth: number | undefined): string {
  if (bandwidth === undefined || bandwidth <= 0) return 'B站音频'
  if (bandwidth >= 1000) return `B站音频 ${Math.round(bandwidth / 1000)}kbps`
  return `B站音频 ${Math.round(bandwidth)}bps`
}

function optionalPositive(value: number | undefined): number | undefined {
  if (value === undefined || value < 0) return undefined
  return value
}

function readDashTrack(value: unknown, role: 'video' | 'audio', names: Map<number, string>): BilibiliTrack | undefined {
  if (!isRecord(value)) return undefined
  const url = httpUrl(textField(value, 'baseUrl') ?? textField(value, 'base_url'))
  if (!url) return undefined
  const qualityId = finiteNumber(value.id)
  const bandwidth = optionalPositive(finiteNumber(value.bandwidth))
  const width = optionalPositive(finiteNumber(value.width))
  const height = optionalPositive(finiteNumber(value.height))
  const codecs = textField(value, 'codecs')
  const track: BilibiliTrack = {
    url,
    role,
    ext: 'm4s',
    label:
      role === 'audio'
        ? audioTrackLabel(bandwidth)
        : videoTrackLabel({
            qualityText: qualityId !== undefined ? names.get(qualityId) : undefined,
            width,
            height,
            qualityId,
            codecs,
          }),
  }
  if (qualityId !== undefined) track.qualityId = qualityId
  if (bandwidth !== undefined) track.bandwidth = bandwidth
  if (width !== undefined) track.width = width
  if (height !== undefined) track.height = height
  if (codecs) track.codecs = codecs
  return track
}

function extensionOf(url: string): string | undefined {
  try {
    const base = new URL(url).pathname.split('/').pop() ?? ''
    const dot = base.lastIndexOf('.')
    if (dot <= 0 || dot === base.length - 1) return undefined
    return base.slice(dot + 1).toLowerCase()
  } catch {
    return undefined
  }
}

/** 老式 durl 只收 mp4。flv 和其它扩展名直接丢掉。不读 backup_url。 */
function readDurl(value: unknown): BilibiliTrack | undefined {
  if (!isRecord(value)) return undefined
  const url = httpUrl(textField(value, 'url'))
  if (!url || extensionOf(url) !== 'mp4') return undefined
  return { url, role: 'file', ext: 'mp4', label: 'B站视频' }
}

function tracksFromPayload(payload: Record<string, unknown>): BilibiliTrack[] {
  const names = qualityNames(payload)
  const tracks: BilibiliTrack[] = []
  const dash = isRecord(payload.dash) ? payload.dash : undefined
  if (dash) {
    if (Array.isArray(dash.video)) {
      for (const entry of dash.video) {
        const track = readDashTrack(entry, 'video', names)
        if (track) tracks.push(track)
      }
    }
    if (Array.isArray(dash.audio)) {
      for (const entry of dash.audio) {
        const track = readDashTrack(entry, 'audio', names)
        if (track) tracks.push(track)
      }
    }
  }
  if (Array.isArray(payload.durl)) {
    for (const entry of payload.durl) {
      const track = readDurl(entry)
      if (track) tracks.push(track)
    }
  }
  return tracks
}

/** 多个 script、多次赋值合成一份。同一个地址只留第一条。 */
export function parsePlayinfoScripts(scripts: readonly string[]): BilibiliTrack[] {
  const tracks: BilibiliTrack[] = []
  const seen = new Set<string>()
  for (const source of scripts) {
    if (typeof source !== 'string') continue
    for (const value of readPlayinfoValues(source)) {
      const payload = payloadOf(value)
      if (!payload) continue
      for (const track of tracksFromPayload(payload)) {
        if (seen.has(track.url)) continue
        seen.add(track.url)
        tracks.push(track)
      }
    }
  }
  return tracks
}

export function trackMeta(track: BilibiliTrack): BilibiliMeta {
  const meta: BilibiliMeta = { role: track.role, label: track.label }
  if (track.qualityId !== undefined) meta.qualityId = track.qualityId
  if (track.bandwidth !== undefined) meta.bandwidth = track.bandwidth
  if (track.width !== undefined) meta.width = track.width
  if (track.height !== undefined) meta.height = track.height
  if (track.codecs) meta.codecs = track.codecs
  return meta
}

export function draftFromTrack(
  track: BilibiliTrack,
  options: { now: number; frameUrl?: string; firstSeen: Map<string, number> },
): MediaItemDraft {
  let firstSeen = options.firstSeen.get(track.url)
  if (firstSeen === undefined) {
    firstSeen = options.now
    options.firstSeen.set(track.url, firstSeen)
  }
  const draft: MediaItemDraft = {
    url: track.url,
    kind: track.role === 'audio' ? 'audio' : 'video',
    ext: track.ext,
    sources: ['dom'],
    downloadable: false,
    note: track.role === 'file' ? BILIBILI_FILE_NOTE : BILIBILI_NOTE,
    firstSeen,
    bilibili: trackMeta(track),
  }
  if (options.frameUrl) draft.frameUrl = options.frameUrl
  return draft
}

/** 存储和消息里的附加字段。不合格就丢掉，不让整条媒体失效。 */
export function readBilibiliMeta(value: unknown): BilibiliMeta | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.role !== 'string' || !(BILIBILI_ROLES as readonly string[]).includes(value.role)) return undefined
  if (typeof value.label !== 'string' || value.label.trim() === '') return undefined
  const meta: BilibiliMeta = { role: value.role as BilibiliRole, label: value.label.trim() }
  if (value.qualityId !== undefined) {
    const qualityId = finiteNumber(value.qualityId)
    if (qualityId === undefined) return undefined
    meta.qualityId = qualityId
  }
  if (value.bandwidth !== undefined) {
    const bandwidth = finiteNumber(value.bandwidth)
    if (bandwidth === undefined || bandwidth < 0) return undefined
    meta.bandwidth = bandwidth
  }
  if (value.width !== undefined || value.height !== undefined) {
    const width = finiteNumber(value.width)
    const height = finiteNumber(value.height)
    if (width === undefined || height === undefined || width < 0 || height < 0) return undefined
    meta.width = width
    meta.height = height
  }
  if (value.codecs !== undefined) {
    if (typeof value.codecs !== 'string' || value.codecs.trim() === '') return undefined
    meta.codecs = value.codecs.trim()
  }
  return meta
}

/** 嗅探先到、页面信息后到时，用能看清音视频的那份。 */
export function preferBilibiliMeta(
  current: BilibiliMeta | undefined,
  incoming: BilibiliMeta | undefined,
): BilibiliMeta | undefined {
  if (!incoming) return current ? { ...current } : undefined
  if (!current || (current.role === 'unknown' && incoming.role !== 'unknown')) return { ...incoming }
  return { ...current }
}

function isBilibiliCdnHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '')
  return (
    host === 'bilivideo.com' ||
    host.endsWith('.bilivideo.com') ||
    host === 'bilivideo.cn' ||
    host.endsWith('.bilivideo.cn')
  )
}

/**
 * B 站 CDN 上的单个 .m4s。
 * 普通 DASH 站点的分片不是这个主机，仍然不进列表。
 * 去掉表示字节范围的 query，避免同一次播放列成很多条。其它 query 原样保留，签名还在。
 */
export function canonicalBilibiliM4sUrl(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (!isBilibiliCdnHost(url.hostname)) return undefined
  if (!url.pathname.toLowerCase().endsWith('.m4s')) return undefined
  const kept = new URLSearchParams()
  for (const [key, value] of url.searchParams) {
    if (RANGE_QUERY.has(key.toLowerCase()) && /^\d+(-\d+)?$/.test(value)) continue
    kept.append(key, value)
  }
  url.search = kept.size > 0 ? `?${kept.toString()}` : ''
  url.hash = ''
  return url.href
}

function headerValue(headers: BilibiliSniffInput['responseHeaders'], name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined
  const wanted = name.toLowerCase()
  for (const header of headers) {
    if (typeof header?.name !== 'string' || header.name.toLowerCase() !== wanted) continue
    if (typeof header.value !== 'string') continue
    return header.value
  }
  return undefined
}

function digits(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined
  const number = Number(value.trim())
  if (!Number.isSafeInteger(number)) return undefined
  return number
}

/** Content-Range 的总长度。206 的 Content-Length 只是这一段，不能当成文件大小。 */
function contentRangeTotal(headers: BilibiliSniffInput['responseHeaders']): number | undefined {
  const raw = headerValue(headers, 'content-range')
  if (!raw) return undefined
  const match = /\/(\d+)\s*$/.exec(raw.trim())
  return digits(match?.[1])
}

/**
 * 网络里的 B 站 .m4s。
 * 播放器几乎总是发 Range，所以 200 和 206 都收。同一地址由调用方再去重。
 * 这里分不清音视频，标成类型未知。
 */
export function bilibiliM4sItem(details: BilibiliSniffInput, now = Date.now()): MediaItem | null {
  if (!Number.isInteger(details.tabId) || details.tabId < 0) return null
  if (details.statusCode !== 200 && details.statusCode !== 206) return null
  const url = canonicalBilibiliM4sUrl(details.url)
  if (!url) return null
  const seen =
    typeof details.timeStamp === 'number' && Number.isFinite(details.timeStamp) && details.timeStamp > 0
      ? details.timeStamp
      : now
  const item: MediaItem = {
    url,
    kind: 'video',
    ext: 'm4s',
    sources: ['network'],
    downloadable: false,
    note: BILIBILI_UNKNOWN_NOTE,
    firstSeen: seen,
    bilibili: { role: 'unknown', label: BILIBILI_M4S_LABEL },
  }
  const size =
    details.statusCode === 200
      ? digits(headerValue(details.responseHeaders, 'content-length'))
      : contentRangeTotal(details.responseHeaders)
  if (size !== undefined) item.size = size
  return item
}

export interface BilibiliDownloadFile {
  url: string
  role: BilibiliRole
}

/** 组合下载时，选带宽最高的一条音频。没有带宽就留列表里的第一条。 */
export function highestBilibiliAudioUrl(
  items: readonly Pick<MediaItem, 'url' | 'bilibili'>[],
  exceptUrl?: string,
): string | undefined {
  let best: { url: string; bandwidth: number } | undefined
  for (const item of items) {
    if (item.bilibili?.role !== 'audio') continue
    if (exceptUrl && item.url === exceptUrl) continue
    const bandwidth = item.bilibili.bandwidth ?? -1
    if (!best || bandwidth > best.bandwidth) best = { url: item.url, bandwidth }
  }
  return best?.url
}

export function planBilibiliFiles(
  items: readonly Pick<MediaItem, 'url' | 'bilibili'>[],
  primaryUrl: string,
  withAudio: boolean,
): { ok: true; files: BilibiliDownloadFile[] } | { ok: false; error: string } {
  const url = normalizeUrl(primaryUrl) || primaryUrl.trim()
  if (!httpUrl(url)) return { ok: false, error: BILIBILI_TEXT.badMedia }
  const primary = items.find((item) => item.url === url)
  const role = primary?.bilibili?.role ?? 'unknown'
  const files: BilibiliDownloadFile[] = [{ url, role }]
  if (!withAudio || role === 'audio') return { ok: true, files }
  const audioUrl = highestBilibiliAudioUrl(items, url)
  if (!audioUrl) return { ok: false, error: BILIBILI_TEXT.noAudio }
  files.push({ url: audioUrl, role: 'audio' })
  return { ok: true, files }
}
