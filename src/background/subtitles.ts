/**
 * 把字幕清单的检查和下载交给 offscreen。
 * service worker 只补页面标题和列表序号，不拉取字幕正文。
 */

import { HLS_TEXT, isHttpUrl } from '../shared/hls'
import { normalizeUrl } from '../shared/classify'
import {
  isSubtitleDownloadMessage,
  isSubtitleInspectMessage,
  type SubtitleDownloadMessage,
} from '../shared/messages'
import { downloadContext, ensureOffscreen, sendOffscreen } from './offscreen-doc'

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

async function inspect(url: string): Promise<unknown> {
  const playlistUrl = normalizeUrl(url) || url.trim()
  if (!isHttpUrl(playlistUrl)) return { ok: false, error: HLS_TEXT.badPlaylistUrl }
  try {
    await ensureOffscreen()
  } catch (error) {
    warn('打开 offscreen 失败', error)
    return { ok: false, error: HLS_TEXT.offscreen }
  }
  const inspected = await sendOffscreen({ type: 'SUBTITLE_OFFSCREEN_INSPECT', playlistUrl })
  return inspected ?? { ok: false, error: HLS_TEXT.offscreen }
}

async function download(message: SubtitleDownloadMessage): Promise<unknown> {
  const playlistUrl = normalizeUrl(message.url) || message.url.trim()
  const trackId = message.trackId.trim()
  if (!isHttpUrl(playlistUrl) || trackId === '') return { ok: false, error: HLS_TEXT.badPlaylistUrl }
  try {
    await ensureOffscreen()
  } catch (error) {
    warn('打开 offscreen 失败', error)
    return { ok: false, error: HLS_TEXT.offscreen }
  }
  const context = await downloadContext(message.tabId, playlistUrl)
  const payload: Record<string, unknown> = {
    type: 'SUBTITLE_OFFSCREEN_DOWNLOAD',
    playlistUrl,
    trackId,
    format: message.format,
  }
  if (context.title) payload.title = context.title
  if (context.index !== undefined) payload.index = context.index
  const saved = await sendOffscreen(payload)
  return saved ?? { ok: false, error: HLS_TEXT.offscreen }
}

export function handleSubtitleMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (isSubtitleInspectMessage(message)) {
    void inspect(message.url).then(sendResponse, (error: unknown) => {
      warn('检查字幕失败', error)
      sendResponse({ ok: false, error: HLS_TEXT.offscreen })
    })
    return true
  }
  if (isSubtitleDownloadMessage(message)) {
    void download(message).then(sendResponse, (error: unknown) => {
      warn('下载字幕失败', error)
      sendResponse({ ok: false, error: HLS_TEXT.offscreen })
    })
    return true
  }
  return undefined
}

export function listenForSubtitles(): void {
  chrome.runtime.onMessage.addListener(handleSubtitleMessage)
}
