/**
 * 在 offscreen 里读取字幕清单并下载。
 * fetch 不设置 headers。保存文件仍交给 service worker。
 */

import { parseMpd } from '../shared/dash'
import { describePlaylistStatus, isHttpUrl, parseHlsPlaylist } from '../shared/hls'
import { fetchPlaylistText } from '../shared/hls-fetch'
import {
  assembleFetchedSubtitles,
  readHlsSubtitleSource,
  subtitleFilename,
  tracksFromDash,
  tracksFromHls,
  type SubtitleTrackView,
} from '../shared/subtitles'
import { SUBTITLE_TEXT } from '../shared/webvtt'
import { saveBlobFile } from './runtime-bridge'

export interface SubtitleDownloadRequest {
  playlistUrl: string
  trackId: string
  format: 'vtt' | 'srt'
  title?: string
  index?: number
}

function isDashManifest(url: string, text: string): boolean {
  try {
    if (new URL(url).pathname.toLowerCase().endsWith('.mpd')) return true
  } catch {
    // 地址不完整时再看正文。
  }
  return /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<MPD[\s>]/i.test(text)
}

async function fetchText(url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const signal = new AbortController().signal
  let fetched = await fetchPlaylistText(url, signal)
  if (!fetched.ok && fetched.status !== 401 && fetched.status !== 403 && fetched.status !== 404) {
    fetched = await fetchPlaylistText(url, signal)
  }
  if (!fetched.ok) return { ok: false, error: describePlaylistStatus(fetched.status, fetched.reason) }
  return { ok: true, text: fetched.text }
}

export async function inspectSubtitles(
  playlistUrl: string,
): Promise<{ ok: true; tracks: SubtitleTrackView[] } | { ok: false; error: string }> {
  if (!isHttpUrl(playlistUrl)) return { ok: false, error: '只支持 http 或 https 清单' }
  const fetched = await fetchText(playlistUrl)
  if (!fetched.ok) return fetched
  if (isDashManifest(playlistUrl, fetched.text)) {
    const parsed = parseMpd(fetched.text, playlistUrl)
    if (!parsed.ok) return parsed
    return { ok: true, tracks: tracksFromDash(parsed) }
  }
  const parsed = parseHlsPlaylist(fetched.text, playlistUrl)
  if (!parsed.ok) return parsed
  if (parsed.kind !== 'master') return { ok: true, tracks: [] }
  return { ok: true, tracks: tracksFromHls(parsed.subtitles) }
}

export async function downloadSubtitle(
  request: SubtitleDownloadRequest,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isHttpUrl(request.playlistUrl)) return { ok: false, error: '只支持 http 或 https 清单' }
  const fetched = await fetchText(request.playlistUrl)
  if (!fetched.ok) return fetched

  let parts: { text: string; duration?: number }[] = []
  let kind: 'vtt' | 'ttml' = 'vtt'
  let language: string | undefined
  let label = '字幕'

  if (isDashManifest(request.playlistUrl, fetched.text)) {
    const parsed = parseMpd(fetched.text, request.playlistUrl)
    if (!parsed.ok) return parsed
    const track = parsed.subtitles.find((item) => item.id === request.trackId)
    if (!track) return { ok: false, error: SUBTITLE_TEXT.badTrack }
    if (track.format === 'unsupported' || track.note || track.urls.length === 0) {
      return { ok: false, error: track.note ?? SUBTITLE_TEXT.unsupported }
    }
    kind = track.format
    language = track.language
    label = track.label
    for (const url of track.urls) {
      const piece = await fetchText(url)
      if (!piece.ok) return piece
      parts.push({ text: piece.text })
    }
  } else {
    const parsed = parseHlsPlaylist(fetched.text, request.playlistUrl)
    if (!parsed.ok) return parsed
    if (parsed.kind !== 'master') return { ok: false, error: SUBTITLE_TEXT.badTrack }
    const rendition = parsed.subtitles.find((item) => item.url === request.trackId)
    if (!rendition) return { ok: false, error: SUBTITLE_TEXT.badTrack }
    language = rendition.language
    label = rendition.name
    const body = await fetchText(rendition.url)
    if (!body.ok) return body
    const source = readHlsSubtitleSource(body.text, rendition.url)
    if (!source.ok) return source
    if (source.kind === 'file') {
      parts = [{ text: body.text }]
    } else {
      for (const segment of source.segments) {
        const piece = await fetchText(segment.url)
        if (!piece.ok) return piece
        const part: { text: string; duration?: number } = { text: piece.text }
        if (segment.duration !== undefined) part.duration = segment.duration
        parts.push(part)
      }
    }
  }

  const assembled = assembleFetchedSubtitles({ format: request.format, kind, parts })
  if (!assembled.ok) return assembled
  const filename = subtitleFilename({
    title: request.title,
    url: request.playlistUrl,
    index: request.index,
    language,
    label,
    ext: assembled.ext,
  })
  const bytes = new TextEncoder().encode(assembled.body)
  const saved = await saveBlobFile([bytes], assembled.mime, filename)
  if (!saved.ok) return saved
  return { ok: true }
}
