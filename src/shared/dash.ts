/**
 * DASH 清单解析和下载计划。不访问 chrome，也不发请求。
 *
 * 只做静态点播、没有 ContentProtection、用 SegmentTemplate 或 SegmentList 的 mp4。
 * 直播、DRM、多个 Period、SegmentBase 都不做。字幕轨单独列出来，不并进音视频文件。
 * 相对地址按标准 URL 规则拼到清单或 BaseURL 上，不把清单 query 里的 token 抄到分片上。
 *
 * 视频和音频常常是两个 AdaptationSet。计划里仍是两路地址。
 * 下载完默认合并成一个 mp4；合并失败、超过 1GB，或用户选择分开时，再各存一份。
 */

import { assessHlsSize, isHttpUrl, joinWarnings, sortVariants, variantLabel, type HlsVariant } from './hls'
import type { HlsVariantChoice } from './hls-job'
import { DASH_TEXT } from './dash-text'
import { SUBTITLE_TEXT } from './webvtt'

/** 展开时间线时的上限。再多就拒绝，避免先造出几万个地址。 */
const MAX_SEGMENTS = 20_000

export interface DashSegment {
  url: string
}

export interface DashTrack {
  id: string
  kind: 'video' | 'audio'
  bandwidth: number
  width?: number
  height?: number
  label: string
  /** Role 是 main。选音轨时优先。 */
  main: boolean
  ext: 'mp4' | 'm4a'
  mime: string
  initUrl: string
  segments: DashSegment[]
}

export interface DashSubtitleTrack {
  id: string
  label: string
  language?: string
  /** vtt / ttml 可以下载并转成 .vtt。unsupported 只展示中文说明。 */
  format: 'vtt' | 'ttml' | 'unsupported'
  /** 单文件只有一项。分片按时间顺序。下载不了时为空。 */
  urls: string[]
  /** 不能下载时的中文说明。 */
  note?: string
}

export interface DashManifest {
  ok: true
  videos: DashTrack[]
  audios: DashTrack[]
  /** 文本字幕轨。不参与音视频下载计划。 */
  subtitles: DashSubtitleTrack[]
  /** 清单上的时长，秒。没有就是 0，体积估算会跳过。 */
  durationSeconds: number
}

export type DashParseResult = DashManifest | { ok: false; error: string }

export interface DashFilePlan {
  kind: 'video' | 'audio'
  ext: 'mp4' | 'm4a'
  mime: string
  /** 第一项是初始化段，后面是媒体分片。 */
  urls: string[]
  /** 视频轨的像素高度，用来生成「标题-1080P.mp4」。 */
  height?: number
  /** 没有高度时用带宽生成后缀。 */
  bandwidth?: number
}

export interface DashDownloadPlan {
  ok: true
  files: DashFilePlan[]
  /** 按下载顺序排好的全部地址，和 files 里的 urls 拼起来一致。 */
  urls: string[]
  total: number
  separateAudio: boolean
  warning?: string
  /** 供进度条和选择器用。url 字段存的是 Representation id，不是分片地址。 */
  variants: HlsVariantChoice[]
}

interface TemplateAttrs {
  media?: string
  initialization?: string
  timescale?: number
  duration?: number
  startNumber?: number
  endNumber?: number
  timeline?: TimelineEntry[]
}

interface TimelineEntry {
  t?: number
  d: number
  r: number
}

interface BuiltSegments {
  initUrl: string
  segments: DashSegment[]
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function children(parent: Element, name: string): Element[] {
  return [...parent.children].filter((element) => element.localName === name)
}

function firstChild(parent: Element, name: string): Element | undefined {
  return children(parent, name)[0]
}

function hasDescendant(root: Document | Element, name: string): boolean {
  const nodes = root.getElementsByTagName('*')
  for (const node of nodes) {
    if (node.localName === name) return true
  }
  return false
}

function attr(element: Element | undefined, name: string): string | undefined {
  const value = element?.getAttribute(name)?.trim()
  return value ? value : undefined
}

function numberAttr(element: Element | undefined, name: string): number | undefined {
  const raw = attr(element, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  return value
}

/** ISO 8601 时长，例如 PT10M、PT1H2M3.5S。解析不了就当没有。 */
export function parseIsoDuration(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined
  const value = raw.trim()
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value)
  if (!match || value === 'P' || value === 'PT') return undefined
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  const seconds = Number(match[4] ?? 0)
  const total = ((days * 24 + hours) * 60 + minutes) * 60 + seconds
  if (!Number.isFinite(total) || total <= 0) return undefined
  return total
}

function resolveAgainst(base: string, ref: string): string | undefined {
  try {
    const url = new URL(ref, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.href
  } catch {
    return undefined
  }
}

function chainBase(manifestUrl: string, bases: Array<string | undefined>): string {
  let current = manifestUrl
  for (const base of bases) {
    if (!base) continue
    try {
      current = new URL(base, current).href
    } catch {
      // 这一级 BaseURL 坏了就停在上一级，后面的分片解析会再报。
    }
  }
  return current
}

function textOf(element: Element | undefined): string | undefined {
  const value = element?.textContent?.trim()
  return value ? value : undefined
}

function readTimeline(element: Element): TimelineEntry[] | { error: string } {
  const entries: TimelineEntry[] = []
  for (const node of children(element, 'S')) {
    const duration = numberAttr(node, 'd')
    if (duration === undefined || duration <= 0) return { error: DASH_TEXT.unsupportedTemplate }
    const repeat = numberAttr(node, 'r')
    if (repeat !== undefined && (!Number.isInteger(repeat) || repeat < -1)) return { error: DASH_TEXT.unsupportedTemplate }
    const start = numberAttr(node, 't')
    const entry: TimelineEntry = { d: duration, r: repeat ?? 0 }
    if (start !== undefined) entry.t = start
    entries.push(entry)
  }
  if (entries.length === 0) return { error: DASH_TEXT.unknownCount }
  return entries
}

function readTemplate(element: Element | undefined): TemplateAttrs | { error: string } | undefined {
  if (!element) return undefined
  const template: TemplateAttrs = {}
  const media = attr(element, 'media')
  const initialization = attr(element, 'initialization')
  if (media) template.media = media
  if (initialization) template.initialization = initialization
  const timescale = numberAttr(element, 'timescale')
  const duration = numberAttr(element, 'duration')
  const startNumber = numberAttr(element, 'startNumber')
  const endNumber = numberAttr(element, 'endNumber')
  if (timescale !== undefined) template.timescale = timescale
  if (duration !== undefined) template.duration = duration
  if (startNumber !== undefined) template.startNumber = startNumber
  if (endNumber !== undefined) template.endNumber = endNumber
  const timeline = firstChild(element, 'SegmentTimeline')
  if (timeline) {
    const parsed = readTimeline(timeline)
    if ('error' in parsed) return parsed
    template.timeline = parsed
  }
  return template
}

function mergeTemplate(base: TemplateAttrs | undefined, extra: TemplateAttrs | { error: string } | undefined): TemplateAttrs | { error: string } | undefined {
  if (extra && 'error' in extra) return extra
  if (!base && !extra) return undefined
  return {
    ...base,
    ...extra,
    timeline: extra?.timeline ?? base?.timeline,
  }
}

function formatToken(spec: string, values: Record<string, string | number>): string | undefined {
  const match = /^(RepresentationID|Bandwidth|Number|Time)(?:%(0)?(\d+)d)?$/.exec(spec)
  if (!match) return undefined
  const name = match[1]
  if (!name) return undefined
  const raw = values[name]
  if (raw === undefined) return undefined
  const text = String(raw)
  const width = match[3] ? Number(match[3]) : 0
  if (!width || text.length >= width) return text
  return text.padStart(width, '0')
}

/** 替换 $Number$、$Time$、$RepresentationID$、$Bandwidth$ 和 $$。不认识的占位直接失败。 */
export function fillDashTemplate(template: string, values: Record<string, string | number>): string | undefined {
  let failed = false
  const filled = template.replace(/\$\$|\$([^$]+)\$/g, (whole, inner: string) => {
    if (whole === '$$') return '$'
    const formatted = formatToken(inner, values)
    if (formatted === undefined) {
      failed = true
      return whole
    }
    return formatted
  })
  if (failed) return undefined
  return filled
}

function expandTimeline(
  timeline: readonly TimelineEntry[],
  timescale: number,
  periodSeconds: number,
): Array<{ time: number; number: number }> | { error: string } {
  const points: Array<{ time: number; number: number }> = []
  let time = 0
  const periodTicks = periodSeconds > 0 ? periodSeconds * timescale : undefined
  for (const entry of timeline) {
    if (entry.t !== undefined) time = entry.t
    const repeats = entry.r === -1 ? Number.POSITIVE_INFINITY : entry.r + 1
    if (entry.r === -1 && periodTicks === undefined) return { error: DASH_TEXT.unknownCount }
    for (let index = 0; index < repeats; index += 1) {
      if (entry.r === -1 && periodTicks !== undefined && time >= periodTicks) break
      points.push({ time, number: points.length })
      time += entry.d
      if (points.length > MAX_SEGMENTS) return { error: DASH_TEXT.tooMany }
    }
  }
  if (points.length === 0) return { error: DASH_TEXT.unknownCount }
  return points
}

/** SegmentTemplate 展开成媒体地址。音视频和字幕共用，字幕不要求初始化段。 */
function urlsFromTemplate(
  template: TemplateAttrs,
  representationId: string,
  bandwidth: number,
  baseUrl: string,
  periodSeconds: number,
): { urls: string[] } | { error: string } {
  if (!template.media) return { error: DASH_TEXT.unsupportedTemplate }
  const mediaTemplate = template.media
  const timescale = template.timescale && template.timescale > 0 ? template.timescale : 1
  const startNumber = template.startNumber ?? 1
  let points: Array<{ time: number; number: number }>
  if (template.timeline) {
    const expanded = expandTimeline(template.timeline, timescale, periodSeconds)
    if ('error' in expanded) return expanded
    points = expanded
  } else if (template.duration && template.duration > 0 && periodSeconds > 0) {
    const count = Math.ceil(periodSeconds / (template.duration / timescale) - 1e-8)
    if (!Number.isFinite(count) || count < 1) return { error: DASH_TEXT.unknownCount }
    if (count > MAX_SEGMENTS) return { error: DASH_TEXT.tooMany }
    const step = template.duration
    points = Array.from({ length: count }, (_, number) => ({ time: number * step, number }))
  } else if (template.endNumber !== undefined && template.endNumber >= startNumber) {
    const count = template.endNumber - startNumber + 1
    if (count > MAX_SEGMENTS) return { error: DASH_TEXT.tooMany }
    points = Array.from({ length: count }, (_, number) => ({ time: number, number }))
  } else {
    return { error: DASH_TEXT.unknownCount }
  }

  const urls: string[] = []
  for (const point of points) {
    const filled = fillDashTemplate(mediaTemplate, {
      RepresentationID: representationId,
      Bandwidth: bandwidth,
      Number: startNumber + point.number,
      Time: point.time,
    })
    if (!filled) return { error: DASH_TEXT.unsupportedTemplate }
    const url = resolveAgainst(baseUrl, filled)
    if (!url) return { error: DASH_TEXT.badSegmentUrl }
    urls.push(url)
  }
  return { urls }
}

function buildFromTemplate(
  template: TemplateAttrs,
  representationId: string,
  bandwidth: number,
  baseUrl: string,
  periodSeconds: number,
): BuiltSegments | { error: string } {
  if (!template.media) return { error: DASH_TEXT.unsupportedTemplate }
  if (!template.initialization) return { error: DASH_TEXT.noInit }
  const listed = urlsFromTemplate(template, representationId, bandwidth, baseUrl, periodSeconds)
  if ('error' in listed) return listed

  const initFilled = fillDashTemplate(template.initialization, {
    RepresentationID: representationId,
    Bandwidth: bandwidth,
  })
  if (!initFilled) return { error: DASH_TEXT.unsupportedTemplate }
  const initUrl = resolveAgainst(baseUrl, initFilled)
  if (!initUrl) return { error: DASH_TEXT.badSegmentUrl }
  return { initUrl, segments: listed.urls.map((url) => ({ url })) }
}

function buildFromList(list: Element, baseUrl: string): BuiltSegments | { error: string } {
  const initialization = firstChild(list, 'Initialization')
  const source = attr(initialization, 'sourceURL')
  if (!source) return { error: DASH_TEXT.noInit }
  const initUrl = resolveAgainst(baseUrl, source)
  if (!initUrl) return { error: DASH_TEXT.badSegmentUrl }
  const segments: DashSegment[] = []
  for (const node of children(list, 'SegmentURL')) {
    const media = attr(node, 'media')
    if (!media) return { error: DASH_TEXT.unsupportedTemplate }
    const url = resolveAgainst(baseUrl, media)
    if (!url) return { error: DASH_TEXT.badSegmentUrl }
    segments.push({ url })
    if (segments.length > MAX_SEGMENTS) return { error: DASH_TEXT.tooMany }
  }
  if (segments.length === 0) return { error: DASH_TEXT.unknownCount }
  return { initUrl, segments }
}

function isTextTrack(mime: string, contentType: string | undefined, codecs: string | undefined): boolean {
  const content = contentType?.toLowerCase() ?? ''
  if (content === 'text') return true
  if (mime.startsWith('text/')) return true
  if (mime.includes('ttml') || mime.includes('vtt') || mime.includes('imsc')) return true
  const codec = (codecs ?? '').toLowerCase()
  if (mime === 'application/mp4' && (codec.includes('stpp') || codec.includes('wvtt'))) return true
  return false
}

function subtitleFormat(mime: string, codecs: string | undefined): DashSubtitleTrack['format'] {
  const type = mime.toLowerCase()
  const codec = (codecs ?? '').toLowerCase()
  if (codec.includes('stpp')) return 'unsupported'
  if (type === 'application/mp4' || type === 'video/mp4' || codec.includes('wvtt')) return 'unsupported'
  if (type.includes('vtt')) return 'vtt'
  if (type.includes('ttml') || type.includes('imsc') || type === 'application/xml' || type === 'text/xml') return 'ttml'
  if (type.startsWith('text/')) return 'vtt'
  return 'unsupported'
}

function unsupportedNote(codecs: string | undefined, mime: string): string {
  const codec = (codecs ?? '').toLowerCase()
  const type = mime.toLowerCase()
  if (codec.includes('stpp') || type.includes('ttml') && type.includes('mp4')) return SUBTITLE_TEXT.unsupportedStpp
  if (codec.includes('stpp')) return SUBTITLE_TEXT.unsupportedStpp
  if (codec.includes('wvtt') || type === 'application/mp4') return SUBTITLE_TEXT.unsupportedWvtt
  return SUBTITLE_TEXT.unsupported
}

function subtitleLabel(language: string | undefined, name: string | undefined, id: string): string {
  const lang = language?.trim()
  const title = name?.trim()
  if (title && lang && title.toLowerCase() !== lang.toLowerCase()) return `${title}（${lang}）`
  return title || lang || id
}

function singleFileUrl(manifestUrl: string, baseUrl: string): string | undefined {
  if (baseUrl === manifestUrl) return undefined
  try {
    const path = new URL(baseUrl).pathname
    if (path.endsWith('/')) return undefined
    return baseUrl
  } catch {
    return undefined
  }
}

/** 字幕不要求初始化段。坏模板只记在这一条上，不让整份音视频清单失败。 */
function subtitleUrls(
  period: Element,
  adaptation: Element,
  representation: Element,
  representationId: string,
  bandwidth: number,
  baseUrl: string,
  manifestUrl: string,
  periodSeconds: number,
): { urls: string[] } | { note: string } {
  const nodes = [representation, adaptation, period]
  let mode: 'template' | 'list' | 'base' | undefined
  for (const node of nodes) {
    if (firstChild(node, 'SegmentTemplate')) {
      mode = 'template'
      break
    }
    if (firstChild(node, 'SegmentList')) {
      mode = 'list'
      break
    }
    if (firstChild(node, 'SegmentBase')) {
      mode = 'base'
      break
    }
  }
  if (mode === 'base') return { note: SUBTITLE_TEXT.segmentBase }
  if (mode === 'list') {
    const list =
      firstChild(representation, 'SegmentList') ??
      firstChild(adaptation, 'SegmentList') ??
      firstChild(period, 'SegmentList')
    if (!list) return { note: DASH_TEXT.unsupportedTemplate }
    const urls: string[] = []
    for (const node of children(list, 'SegmentURL')) {
      const media = attr(node, 'media')
      if (!media) return { note: DASH_TEXT.unsupportedTemplate }
      const url = resolveAgainst(baseUrl, media)
      if (!url) return { note: DASH_TEXT.badSegmentUrl }
      urls.push(url)
      if (urls.length > MAX_SEGMENTS) return { note: DASH_TEXT.tooMany }
    }
    if (urls.length === 0) return { note: SUBTITLE_TEXT.noUrl }
    return { urls }
  }
  if (mode === 'template') {
    let template: TemplateAttrs | undefined
    for (const node of [period, adaptation, representation]) {
      const merged = mergeTemplate(template, readTemplate(firstChild(node, 'SegmentTemplate')))
      if (merged && 'error' in merged) return { note: merged.error }
      template = merged
    }
    if (!template) return { note: DASH_TEXT.unsupportedTemplate }
    const listed = urlsFromTemplate(template, representationId, bandwidth, baseUrl, periodSeconds)
    if ('error' in listed) return { note: listed.error }
    if (listed.urls.length === 0) return { note: SUBTITLE_TEXT.noUrl }
    return { urls: listed.urls }
  }
  const single = singleFileUrl(manifestUrl, baseUrl)
  if (!single) return { note: SUBTITLE_TEXT.noUrl }
  return { urls: [single] }
}

function trackKind(mime: string, contentType: string | undefined): 'video' | 'audio' | 'skip' {
  const content = contentType?.toLowerCase() ?? ''
  // contentType 是 video / audio / text，不是 MIME。字幕和图片直接跳过。
  if (content === 'text' || content === 'image') return 'skip'
  if (mime.startsWith('text/') || mime.startsWith('image/') || mime.includes('ttml') || mime.includes('vtt')) return 'skip'
  if (mime === 'video/mp4') return 'video'
  if (mime === 'audio/mp4' || mime === 'audio/m4a') return 'audio'
  return 'skip'
}

function isMain(element: Element, fallback: boolean): boolean {
  const roles = children(element, 'Role')
  if (roles.length === 0) return fallback
  return roles.some((role) => attr(role, 'value') === 'main')
}

/**
 * 离 Representation 最近的一种寻址方式生效。
 * SegmentTemplate 的属性会从 Period、AdaptationSet 继承下来。
 */
function resolveSegments(
  period: Element,
  adaptation: Element,
  representation: Element,
  representationId: string,
  bandwidth: number,
  baseUrl: string,
  periodSeconds: number,
): BuiltSegments | { error: string } | { skip: 'segment-base' } {
  const nodes = [representation, adaptation, period]
  let mode: 'template' | 'list' | 'base' | undefined
  for (const node of nodes) {
    if (firstChild(node, 'SegmentTemplate')) {
      mode = 'template'
      break
    }
    if (firstChild(node, 'SegmentList')) {
      mode = 'list'
      break
    }
    if (firstChild(node, 'SegmentBase')) {
      mode = 'base'
      break
    }
  }
  if (mode === 'base') return { skip: 'segment-base' }
  if (!mode) return { error: DASH_TEXT.unsupportedTemplate }
  if (mode === 'list') {
    const list = firstChild(representation, 'SegmentList') ?? firstChild(adaptation, 'SegmentList') ?? firstChild(period, 'SegmentList')
    if (!list) return { error: DASH_TEXT.unsupportedTemplate }
    return buildFromList(list, baseUrl)
  }
  let template: TemplateAttrs | undefined
  for (const node of [period, adaptation, representation]) {
    const merged = mergeTemplate(template, readTemplate(firstChild(node, 'SegmentTemplate')))
    if (merged && 'error' in merged) return merged
    template = merged
  }
  if (!template?.media) return { error: DASH_TEXT.unsupportedTemplate }
  return buildFromTemplate(template, representationId, bandwidth, baseUrl, periodSeconds)
}

function toChoice(track: DashTrack, separateAudio: boolean): HlsVariantChoice {
  const choice: HlsVariantChoice = {
    url: track.id,
    label: track.label,
    bandwidth: track.bandwidth,
    separateAudio,
  }
  if (track.width !== undefined && track.height !== undefined) {
    choice.width = track.width
    choice.height = track.height
  }
  return choice
}

function sortedTracks(tracks: readonly DashTrack[]): DashTrack[] {
  const order = sortVariants(
    tracks.map((track) => {
      const variant: HlsVariant = {
        url: track.id,
        bandwidth: track.bandwidth,
        label: track.label,
        separateAudio: false,
      }
      if (track.width !== undefined && track.height !== undefined) {
        variant.width = track.width
        variant.height = track.height
      }
      return variant
    }),
  ).map((variant) => variant.url)
  return [...tracks].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id))
}

function audioChoiceText(audios: readonly DashTrack[]): string {
  return audios.some((track) => track.main) ? DASH_TEXT.audioMain : DASH_TEXT.audioChoice
}

function pickAudio(audios: readonly DashTrack[]): DashTrack | undefined {
  if (audios.length === 0) return undefined
  const mains = audios.filter((track) => track.main)
  const pool = mains.length > 0 ? mains : audios
  return [...pool].sort((left, right) => {
    if (right.bandwidth !== left.bandwidth) return right.bandwidth - left.bandwidth
    if (left.id < right.id) return -1
    if (left.id > right.id) return 1
    return 0
  })[0]
}

export function parseMpd(xml: string, manifestUrl: string): DashParseResult {
  if (!isHttpUrl(manifestUrl)) return fail(DASH_TEXT.badUrl)
  const source = xml.replace(/^\uFEFF/, '').trim()
  if (!source) return fail(DASH_TEXT.notManifest)
  const document = new DOMParser().parseFromString(source, 'text/xml')
  const root = document.documentElement
  if (!root || root.localName !== 'MPD') return fail(DASH_TEXT.notManifest)
  if (hasDescendant(document, 'parsererror') && root.localName !== 'MPD') return fail(DASH_TEXT.notManifest)
  const type = (attr(root, 'type') ?? 'static').toLowerCase()
  if (type === 'dynamic') return fail(DASH_TEXT.live)
  if (type !== 'static') return fail(DASH_TEXT.notManifest)
  if (hasDescendant(root, 'ContentProtection')) return fail(DASH_TEXT.protected)

  const periods = children(root, 'Period')
  if (periods.length === 0) return fail(DASH_TEXT.notManifest)
  if (periods.length > 1) return fail(DASH_TEXT.multiPeriod)
  const period = periods[0]
  if (!period) return fail(DASH_TEXT.notManifest)

  const durationSeconds = parseIsoDuration(attr(period, 'duration')) ?? parseIsoDuration(attr(root, 'mediaPresentationDuration')) ?? 0
  const mpdBase = textOf(firstChild(root, 'BaseURL'))
  const periodBase = textOf(firstChild(period, 'BaseURL'))

  const videos: DashTrack[] = []
  const audios: DashTrack[] = []
  const subtitles: DashSubtitleTrack[] = []
  let sawSegmentBase = false

  for (const adaptation of children(period, 'AdaptationSet')) {
    const adaptationMime = attr(adaptation, 'mimeType')
    const adaptationType = attr(adaptation, 'contentType')
    const adaptationMain = isMain(adaptation, false)
    const adaptationBase = textOf(firstChild(adaptation, 'BaseURL'))
    const adaptationLang = attr(adaptation, 'lang')
    const adaptationLabel = textOf(firstChild(adaptation, 'Label'))
    const adaptationCodecs = attr(adaptation, 'codecs')

    for (const representation of children(adaptation, 'Representation')) {
      const id = attr(representation, 'id')
      if (!id) return fail(DASH_TEXT.missingId)
      const mime = (attr(representation, 'mimeType') ?? adaptationMime ?? '').toLowerCase()
      const contentType = attr(representation, 'contentType') ?? adaptationType
      const codecs = attr(representation, 'codecs') ?? adaptationCodecs
      if (isTextTrack(mime, contentType, codecs)) {
        const language = attr(representation, 'lang') ?? adaptationLang
        const format = subtitleFormat(mime, codecs)
        const label = subtitleLabel(language, textOf(firstChild(representation, 'Label')) ?? adaptationLabel, id)
        const track: DashSubtitleTrack = { id, label, format, urls: [] }
        if (language) track.language = language
        if (format === 'unsupported') {
          track.note = unsupportedNote(codecs, mime)
        } else {
          const bandwidth = Math.max(
            0,
            Math.round(numberAttr(representation, 'bandwidth') ?? numberAttr(adaptation, 'bandwidth') ?? 0),
          )
          const baseUrl = chainBase(manifestUrl, [
            mpdBase,
            periodBase,
            adaptationBase,
            textOf(firstChild(representation, 'BaseURL')),
          ])
          const built = subtitleUrls(
            period,
            adaptation,
            representation,
            id,
            bandwidth,
            baseUrl,
            manifestUrl,
            durationSeconds,
          )
          if ('note' in built) track.note = built.note
          else track.urls = built.urls
        }
        subtitles.push(track)
        continue
      }
      const kind = trackKind(mime, contentType)
      if (kind === 'skip') continue

      const bandwidth = Math.max(0, Math.round(numberAttr(representation, 'bandwidth') ?? numberAttr(adaptation, 'bandwidth') ?? 0))
      const baseUrl = chainBase(manifestUrl, [
        mpdBase,
        periodBase,
        adaptationBase,
        textOf(firstChild(representation, 'BaseURL')),
      ])
      const built = resolveSegments(period, adaptation, representation, id, bandwidth, baseUrl, durationSeconds)
      if ('skip' in built) {
        sawSegmentBase = true
        continue
      }
      if ('error' in built) return fail(built.error)

      const width = numberAttr(representation, 'width') ?? numberAttr(adaptation, 'width')
      const height = numberAttr(representation, 'height') ?? numberAttr(adaptation, 'height')
      const track: DashTrack = {
        id,
        kind,
        bandwidth,
        label: variantLabel({
          bandwidth,
          width: width && height ? width : undefined,
          height: width && height ? height : undefined,
        }),
        main: isMain(representation, adaptationMain),
        ext: kind === 'audio' ? 'm4a' : 'mp4',
        mime: kind === 'audio' ? 'audio/mp4' : 'video/mp4',
        initUrl: built.initUrl,
        segments: built.segments,
      }
      if (width && height) {
        track.width = width
        track.height = height
      }
      if (kind === 'video') videos.push(track)
      else audios.push(track)
    }
  }

  if (videos.length === 0 && audios.length === 0) {
    return fail(sawSegmentBase ? DASH_TEXT.segmentBase : DASH_TEXT.noMedia)
  }
  return {
    ok: true,
    videos: sortedTracks(videos),
    audios: sortedTracks(audios),
    subtitles,
    durationSeconds,
  }
}

function fileOf(track: DashTrack): DashFilePlan {
  const file: DashFilePlan = {
    kind: track.kind,
    ext: track.ext,
    mime: track.mime,
    urls: [track.initUrl, ...track.segments.map((segment) => segment.url)],
  }
  if (track.height !== undefined) file.height = track.height
  if (track.bandwidth > 0) file.bandwidth = track.bandwidth
  return file
}

/**
 * 选定一条清晰度，并在有独立音轨时配上带宽最高的那条。
 * representationId 为空且有多条可选时，只返回选项，不开始下。
 * audioOnly 为 true 时只选音轨；为 false 时只选视频轨（没有视频就拒绝）。
 * 不传时保持旧行为：优先视频，没有视频才退回音频。
 */
export function planDashDownload(
  manifest: DashManifest,
  representationId?: string,
  audioOnly?: boolean,
): DashDownloadPlan | { ok: false; error: string } {
  if (audioOnly === true && manifest.audios.length === 0) return fail(DASH_TEXT.noAudioTrack)
  if (audioOnly === false && manifest.videos.length === 0) return fail(DASH_TEXT.noVideoTrack)
  const choices =
    audioOnly === true ? manifest.audios : manifest.videos.length > 0 ? manifest.videos : manifest.audios
  if (choices.length === 0) return fail(DASH_TEXT.noMedia)
  const separateAudio = audioOnly !== true && manifest.videos.length > 0 && manifest.audios.length > 0
  const variants = choices.map((track) => toChoice(track, separateAudio))
  if (!representationId) {
    if (choices.length > 1) {
      const pending: DashDownloadPlan = { ok: true, files: [], urls: [], total: 0, separateAudio, variants }
      const warning = joinWarnings([
        separateAudio ? DASH_TEXT.separatePlan : undefined,
        manifest.audios.length > 1 ? audioChoiceText(manifest.audios) : undefined,
      ])
      if (warning) pending.warning = warning
      return pending
    }
    representationId = choices[0]?.id
  }
  const selected = choices.find((track) => track.id === representationId)
  if (!selected || !representationId) return fail(DASH_TEXT.variantMissing)

  const files = [fileOf(selected)]
  if (selected.kind === 'video' && separateAudio) {
    const audio = pickAudio(manifest.audios)
    if (audio) files.push(fileOf(audio))
  }
  const urls = files.flatMap((file) => file.urls)
  const segmentCount = files.reduce((sum, file) => sum + Math.max(0, file.urls.length - 1), 0)
  const audioBandwidth = files.length > 1 ? pickAudio(manifest.audios)?.bandwidth ?? 0 : 0
  const assessment = assessHlsSize({
    segmentCount,
    durationSeconds: manifest.durationSeconds,
    bandwidth: selected.bandwidth + audioBandwidth,
  })
  if (!assessment.ok) return fail(assessment.error)
  const warning = joinWarnings([
    assessment.warning,
    files.length > 1 ? DASH_TEXT.separatePlan : undefined,
    selected.kind === 'video' && manifest.audios.length > 1 ? audioChoiceText(manifest.audios) : undefined,
    selected.kind === 'audio' && manifest.audios.length > 1 ? audioChoiceText(manifest.audios) : undefined,
  ])
  const plan: DashDownloadPlan = {
    ok: true,
    files,
    urls,
    total: urls.length,
    separateAudio: files.length > 1,
    variants,
  }
  if (warning) plan.warning = warning
  return plan
}

/** 下载列表里的下标属于哪个文件的初始化段或第几个分片。 */
export function describeDashFetchFailure(plan: Pick<DashDownloadPlan, 'files'>, index: number, status: number): string {
  let cursor = 0
  for (const file of plan.files) {
    const label = file.kind === 'audio' ? '音频' : '视频'
    if (index < cursor + file.urls.length) {
      const local = index - cursor
      if (status === 403) return '服务器拒绝访问（403）'
      if (status === 401) return '需要登录或未授权（401）'
      if (status === 404) return local === 0 ? `${label}初始化段缺失（404）` : `${label}第 ${local} 个分片缺失（404）`
      if (status === 0) return local === 0 ? `${label}初始化段下载失败：网络连接失败` : `${label}第 ${local} 个分片下载失败：网络连接失败`
      return local === 0 ? `${label}初始化段下载失败（${status}）` : `${label}第 ${local} 个分片下载失败（${status}）`
    }
    cursor += file.urls.length
  }
  return `第 ${index + 1} 个分片下载失败（${status}）`
}
