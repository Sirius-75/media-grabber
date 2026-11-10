/**
 * 从 HLS / DASH 清单里列出字幕轨，并把下到的文本合成一个文件。
 * 不访问 chrome，也不发请求。加密和 DRM 在解析阶段拒绝，这里不再去解。
 */

import type { DashManifest } from './dash'
import { buildDownloadFilename } from './filename'
import { HLS_TEXT, parseHlsPlaylist, type HlsSubtitleRendition } from './hls'
import { SUBTITLE_TEXT, assembleSubtitleFile, type AssembledSubtitle } from './webvtt'

export interface SubtitleTrackView {
  /** HLS 是字幕清单或单个 WebVTT 的地址。DASH 是 Representation id。 */
  id: string
  label: string
  language?: string
  format: 'vtt' | 'ttml' | 'unsupported'
  /** 有这句话时不提供下载按钮。 */
  note?: string
}

export function subtitleLabel(language: string | undefined, name: string | undefined): string {
  const lang = language?.trim()
  const title = name?.trim()
  if (title && lang && title.toLowerCase() !== lang.toLowerCase()) return `${title}（${lang}）`
  return title || lang || '字幕'
}

export function tracksFromHls(renditions: readonly HlsSubtitleRendition[]): SubtitleTrackView[] {
  return renditions.map((rendition) => {
    const track: SubtitleTrackView = {
      id: rendition.url,
      label: subtitleLabel(rendition.language, rendition.name),
      format: 'vtt',
    }
    if (rendition.language) track.language = rendition.language
    return track
  })
}

export function tracksFromDash(manifest: DashManifest): SubtitleTrackView[] {
  return manifest.subtitles.map((track) => {
    const view: SubtitleTrackView = {
      id: track.id,
      label: track.label,
      format: track.format,
    }
    if (track.language) view.language = track.language
    if (track.format === 'unsupported' || track.urls.length === 0) {
      view.note = track.note ?? (track.format === 'unsupported' ? SUBTITLE_TEXT.unsupported : SUBTITLE_TEXT.noUrl)
    }
    return view
  })
}

export function subtitleFilename(input: {
  title?: string
  url: string
  index?: number
  language?: string
  label: string
  ext: 'vtt' | 'srt'
}): string {
  return buildDownloadFilename({
    title: input.title,
    url: input.url,
    index: input.index,
    ext: input.ext,
    quality: input.language?.trim() || input.label.trim() || '字幕',
  })
}

export interface HlsSubtitleSegment {
  url: string
  duration?: number
}

export type HlsSubtitleSource =
  | { ok: true; kind: 'file' }
  | { ok: true; kind: 'media'; segments: HlsSubtitleSegment[] }
  | { ok: false; error: string }

/** 字幕地址上的内容：单个 WebVTT，或一份点播媒体清单。加密和直播直接拒绝。 */
export function readHlsSubtitleSource(text: string, playlistUrl: string): HlsSubtitleSource {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (/^WEBVTT\b/i.test(trimmed) || (!trimmed.startsWith('#EXTM3U') && trimmed.includes('-->'))) {
    return { ok: true, kind: 'file' }
  }
  const parsed = parseHlsPlaylist(text, playlistUrl)
  if (!parsed.ok) return parsed
  if (parsed.kind === 'master') return { ok: false, error: HLS_TEXT.nestedMaster }
  if (parsed.kind === 'live') return { ok: false, error: SUBTITLE_TEXT.live }
  if (parsed.media.aes128) return { ok: false, error: SUBTITLE_TEXT.encrypted }
  if (parsed.media.segments.length === 0) return { ok: false, error: SUBTITLE_TEXT.empty }
  return {
    ok: true,
    kind: 'media',
    segments: parsed.media.segments.map((segment) => {
      const item: HlsSubtitleSegment = { url: segment.url }
      if (segment.duration !== undefined) item.duration = segment.duration
      return item
    }),
  }
}

export function assembleFetchedSubtitles(input: {
  format: 'vtt' | 'srt'
  kind: 'vtt' | 'ttml'
  parts: readonly { text: string; duration?: number }[]
}): AssembledSubtitle | { ok: false; error: string } {
  return assembleSubtitleFile({
    format: input.format,
    segments: input.parts.map((part) => {
      const segment: { text: string; duration?: number; kind: 'vtt' | 'ttml' } = {
        text: part.text,
        kind: input.kind,
      }
      if (part.duration !== undefined) segment.duration = part.duration
      return segment
    }),
  })
}
