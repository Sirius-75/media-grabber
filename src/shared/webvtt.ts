/**
 * 把多段 WebVTT 合成一条连续字幕，并可选转成 SRT。
 * 不访问 chrome，也不发请求。
 *
 * X-TIMESTAMP-MAP 的 MPEGTS 是 90 kHz。LOCAL 对应该时间轴上的字幕时间。
 * 第一段的（MPEGTS/90000 − LOCAL）当作 0 点，后面的分片都减去这个偏移，
 * 这样时间轴从 0 开始，和归零后的视频对齐。
 * 没有时间戳映射、但每一段的 cue 又从 0 附近重新开始时，按前面各段的时长顺延。
 */

export const SUBTITLE_TEXT = {
  unsupportedStpp: '这种字幕格式（TTML/stpp）暂不支持',
  unsupportedWvtt: '这种字幕格式（fMP4/wvtt）暂不支持',
  unsupported: '这种字幕格式暂不支持',
  encrypted: '字幕使用了加密或 DRM，不支持',
  live: '这是直播字幕（没有 EXT-X-ENDLIST），暂不支持下载',
  empty: '字幕里没有可保存的内容',
  noUrl: '没有可下载的字幕地址',
  segmentBase: '暂不支持按字节范围截取的字幕',
  badTrack: '这条字幕不在清单里',
} as const

export interface VttSegmentInput {
  text: string
  /** EXTINF 或分片时长，秒。没有时间戳映射、cue 又从 0 重新开始时用来顺延。 */
  duration?: number
}

interface Cue {
  startMs: number
  endMs: number
  payload: string
  settings: string
}

const TIMESTAMP = /^(?:(\d+):)?(\d{1,3}):(\d{2})[.](\d{1,3})$/

/** 解析 HH:MM:SS.mmm 或 MM:SS.mmm。毫秒不足三位时按左边补齐。 */
export function parseVttTimestamp(value: string): number | undefined {
  const match = TIMESTAMP.exec(value.trim())
  if (!match) return undefined
  const hours = match[1] ? Number(match[1]) : 0
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const fraction = match[4] ?? '0'
  if (minutes > 59 || seconds > 59) return undefined
  const millis = Number(fraction.padEnd(3, '0'))
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
}

function formatTimestamp(ms: number, separator: '.' | ','): string {
  const total = Math.max(0, Math.round(ms))
  const millis = total % 1000
  const secondsTotal = Math.floor(total / 1000)
  const seconds = secondsTotal % 60
  const minutesTotal = Math.floor(secondsTotal / 60)
  const minutes = minutesTotal % 60
  const hours = Math.floor(minutesTotal / 60)
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`
}

function mapOffsetMs(header: string): number | undefined {
  const line = /X-TIMESTAMP-MAP=([^\r\n]+)/i.exec(header)
  if (!line?.[1]) return undefined
  const attrs = line[1]
  const mpegts = /MPEGTS\s*:\s*(\d+)/i.exec(attrs)
  const local = /LOCAL\s*:\s*([0-9:.]+)/i.exec(attrs)
  if (!mpegts?.[1] || !local?.[1]) return undefined
  const localMs = parseVttTimestamp(local[1].replace(',', '.'))
  if (localMs === undefined) return undefined
  const ticks = Number(mpegts[1])
  if (!Number.isFinite(ticks)) return undefined
  return Math.round(ticks / 90) - localMs
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function cuePayload(raw: string): string {
  const withoutTags = raw.replace(/<[^>]+>/g, '')
  return decodeEntities(withoutTags).replace(/\s+\n/g, '\n').trim()
}

function parseBlocks(text: string): { header: string; blocks: string[][] } {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const chunks = source.split(/\n{2,}/).map((chunk) => chunk.split('\n'))
  const headerLines: string[] = []
  const blocks: string[][] = []
  let headerDone = false
  for (const lines of chunks) {
    const content = lines.filter((line) => line.length > 0)
    if (content.length === 0) continue
    const timing = content.some((line) => line.includes('-->'))
    if (!headerDone && !timing) {
      headerLines.push(...content)
      continue
    }
    headerDone = true
    if (timing) blocks.push(content)
  }
  return { header: headerLines.join('\n'), blocks }
}

function parseCueBlock(lines: string[]): Cue | undefined {
  const timingIndex = lines.findIndex((line) => line.includes('-->'))
  if (timingIndex < 0) return undefined
  const timing = lines[timingIndex] ?? ''
  const match = /^(\S+)\s+-->\s+(\S+)(.*)$/.exec(timing.trim())
  if (!match?.[1] || !match[2]) return undefined
  const start = parseVttTimestamp(match[1])
  const end = parseVttTimestamp(match[2])
  if (start === undefined || end === undefined || end < start) return undefined
  const payload = cuePayload(lines.slice(timingIndex + 1).join('\n'))
  if (!payload) return undefined
  return { startMs: start, endMs: end, payload, settings: (match[3] ?? '').trim() }
}

function parseVtt(text: string): { mapOffsetMs?: number; cues: Cue[] } {
  const { header, blocks } = parseBlocks(text)
  const offset = mapOffsetMs(header)
  const cues: Cue[] = []
  for (const block of blocks) {
    const head = (block[0] ?? '').trim().toUpperCase()
    if (head === 'NOTE' || head === 'STYLE' || head === 'REGION') continue
    const cue = parseCueBlock(block)
    if (cue) cues.push(cue)
  }
  return offset === undefined ? { cues } : { mapOffsetMs: offset, cues }
}

function sameCue(left: Cue, right: Cue): boolean {
  return left.startMs === right.startMs && left.endMs === right.endMs && left.payload === right.payload
}

/**
 * 合成一段连续的 WebVTT。时间轴减去第一段的 MPEGTS 偏移，使起点为 0。
 */
export function mergeWebVttSegments(segments: readonly VttSegmentInput[]): string {
  const placed: Cue[] = []
  let baseline: number | undefined
  let cumulativeMs = 0
  for (const segment of segments) {
    const parsed = parseVtt(segment.text)
    if (baseline === undefined && parsed.mapOffsetMs !== undefined) baseline = parsed.mapOffsetMs
    let shift = parsed.mapOffsetMs ?? 0
    if (parsed.mapOffsetMs === undefined && parsed.cues.length > 0 && placed.length > 0) {
      const minStart = Math.min(...parsed.cues.map((cue) => cue.startMs))
      const prevEnd = placed.reduce((max, cue) => Math.max(max, cue.endMs), 0)
      if (prevEnd > 200 && minStart < prevEnd - 200 && minStart < 1000) {
        shift = cumulativeMs > 0 ? cumulativeMs : prevEnd
      }
    }
    for (const cue of parsed.cues) {
      const next: Cue = {
        startMs: cue.startMs + shift,
        endMs: cue.endMs + shift,
        payload: cue.payload,
        settings: cue.settings,
      }
      if (!placed.some((existing) => sameCue(existing, next))) placed.push(next)
    }
    const durationMs =
      segment.duration !== undefined && Number.isFinite(segment.duration) && segment.duration > 0
        ? Math.round(segment.duration * 1000)
        : parsed.cues.reduce((max, cue) => Math.max(max, cue.endMs), 0)
    cumulativeMs += durationMs
  }

  const zero = baseline ?? 0
  const cues = placed
    .map((cue) => ({
      ...cue,
      startMs: cue.startMs - zero,
      endMs: cue.endMs - zero,
    }))
    .filter((cue) => cue.endMs > 0)
    .map((cue) => ({
      ...cue,
      startMs: Math.max(0, cue.startMs),
    }))
    .filter((cue) => cue.endMs > cue.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)

  const lines = ['WEBVTT', '']
  for (const cue of cues) {
    const settings = cue.settings ? ` ${cue.settings}` : ''
    lines.push(`${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}${settings}`)
    lines.push(cue.payload)
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}

/** WebVTT 转 SRT。去掉样式设置，毫秒用逗号。 */
export function webVttToSrt(vtt: string): string {
  const parsed = parseVtt(vtt)
  const lines: string[] = []
  parsed.cues.forEach((cue, index) => {
    lines.push(String(index + 1))
    lines.push(`${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}`)
    lines.push(cue.payload)
    lines.push('')
  })
  return `${lines.join('\n').trim()}\n`
}

function parseClockOrOffset(value: string): number | undefined {
  const raw = value.trim()
  const clock = parseVttTimestamp(raw.replace(',', '.'))
  if (clock !== undefined) return clock
  const seconds = /^(\d+(?:\.\d+)?)s$/i.exec(raw)
  if (seconds?.[1]) return Math.round(Number(seconds[1]) * 1000)
  const millis = /^(\d+(?:\.\d+)?)ms$/i.exec(raw)
  if (millis?.[1]) return Math.round(Number(millis[1]))
  const frames = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(raw)
  if (frames) {
    const hours = Number(frames[1])
    const minutes = Number(frames[2])
    const secs = Number(frames[3])
    const frame = Number(frames[4])
    return ((hours * 60 + minutes) * 60 + secs) * 1000 + Math.round((frame / 30) * 1000)
  }
  return undefined
}

function attrOf(source: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(source)
  return match?.[1] ?? match?.[2]
}

/**
 * 把一份 TTML / IMSC 转成没有时间戳映射的 WebVTT，再交给合成函数。
 * 只认带 begin / end（或 dur）的 p。读不出来就返回空字符串。
 */
export function ttmlToVtt(xml: string): string {
  const cues: Cue[] = []
  const pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const attrs = match[1] ?? ''
    const begin = attrOf(attrs, 'begin')
    const endRaw = attrOf(attrs, 'end')
    const dur = attrOf(attrs, 'dur')
    if (!begin) continue
    const startMs = parseClockOrOffset(begin)
    if (startMs === undefined) continue
    let endMs = endRaw ? parseClockOrOffset(endRaw) : undefined
    if (endMs === undefined && dur) {
      const duration = parseClockOrOffset(dur)
      if (duration !== undefined) endMs = startMs + duration
    }
    if (endMs === undefined || endMs <= startMs) continue
    const payload = cuePayload(
      (match[2] ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'),
    )
    if (!payload) continue
    cues.push({ startMs, endMs, payload, settings: '' })
  }
  if (cues.length === 0) return ''
  const lines = ['WEBVTT', '']
  for (const cue of cues) {
    lines.push(`${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}`)
    lines.push(cue.payload)
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}

export interface AssembledSubtitle {
  ok: true
  body: string
  ext: 'vtt' | 'srt'
  mime: string
}

/** 把若干 VTT 或 TTML 分片合成一个文件。format 决定扩展名。 */
export function assembleSubtitleFile(input: {
  format: 'vtt' | 'srt'
  segments: readonly { text: string; duration?: number; kind: 'vtt' | 'ttml' }[]
}): AssembledSubtitle | { ok: false; error: string } {
  const pieces: VttSegmentInput[] = []
  for (const segment of input.segments) {
    const text = segment.kind === 'ttml' ? ttmlToVtt(segment.text) : segment.text
    if (!text.trim()) continue
    const piece: VttSegmentInput = { text }
    if (segment.duration !== undefined) piece.duration = segment.duration
    pieces.push(piece)
  }
  if (pieces.length === 0) return { ok: false, error: SUBTITLE_TEXT.empty }
  const vtt = mergeWebVttSegments(pieces)
  if (!vtt.includes('-->')) return { ok: false, error: SUBTITLE_TEXT.empty }
  if (input.format === 'srt') {
    const srt = webVttToSrt(vtt)
    if (!srt.includes('-->')) return { ok: false, error: SUBTITLE_TEXT.empty }
    return { ok: true, body: srt, ext: 'srt', mime: 'application/x-subrip' }
  }
  return { ok: true, body: vtt, ext: 'vtt', mime: 'text/vtt' }
}
