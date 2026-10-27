/**
 * 把 DASH 下载交给 offscreen document。
 * service worker 补上页面标题和列表序号。进度和保存文件见 offscreen-jobs.ts。
 * 分片字节不经过这里。
 */

import { downloadContext, ensureOffscreen, relayJobSync, sendOffscreen } from './hls'
import { normalizeUrl } from '../shared/classify'
import { HLS_TEXT, isHttpUrl } from '../shared/hls'
import {
  isDashCancelMessage,
  isDashDownloadMessage,
  isDashInspectMessage,
  isDashSyncMessage,
  type DashDownloadMessage,
  type DashInspectMessage,
} from '../shared/messages'

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

function isFailure(value: unknown): value is { ok: false; error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === false &&
    'error' in value &&
    typeof value.error === 'string'
  )
}

async function forwardDownload(playlistUrl: string, representationId: string | undefined, tabId: number | undefined): Promise<unknown> {
  const context = await downloadContext(tabId, playlistUrl)
  const message: Record<string, unknown> = {
    type: 'DASH_OFFSCREEN_DOWNLOAD',
    playlistUrl,
  }
  if (representationId) message.representationId = representationId
  if (context.title) message.title = context.title
  if (context.index !== undefined) message.index = context.index
  return sendOffscreen(message)
}

async function inspect(message: DashInspectMessage): Promise<unknown> {
  const playlistUrl = normalizeUrl(message.url) || message.url.trim()
  if (!isHttpUrl(playlistUrl)) return { ok: false, error: HLS_TEXT.badPlaylistUrl }
  try {
    await ensureOffscreen()
  } catch (error) {
    warn('打开 offscreen 失败', error)
    return { ok: false, error: HLS_TEXT.offscreen }
  }
  const inspected = await sendOffscreen({ type: 'DASH_OFFSCREEN_INSPECT', playlistUrl })
  if (inspected === undefined) return { ok: false, error: HLS_TEXT.offscreen }
  if (
    typeof inspected === 'object' &&
    inspected !== null &&
    'kind' in inspected &&
    inspected.kind === 'media' &&
    'ok' in inspected &&
    inspected.ok === true
  ) {
    const started = await forwardDownload(playlistUrl, undefined, message.tabId)
    if (started === undefined) return { ok: false, error: HLS_TEXT.offscreen }
    if (isFailure(started)) return started
  }
  return inspected
}

async function download(message: DashDownloadMessage): Promise<unknown> {
  const playlistUrl = normalizeUrl(message.url) || message.url.trim()
  const representationId = message.representationId.trim()
  if (!isHttpUrl(playlistUrl) || !representationId) return { ok: false, error: HLS_TEXT.badPlaylistUrl }
  try {
    await ensureOffscreen()
  } catch (error) {
    warn('打开 offscreen 失败', error)
    return { ok: false, error: HLS_TEXT.offscreen }
  }
  const started = await forwardDownload(playlistUrl, representationId, message.tabId)
  return started ?? { ok: false, error: HLS_TEXT.offscreen }
}

export function handleDashMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (isDashInspectMessage(message)) {
    void inspect(message).then(sendResponse, (error: unknown) => {
      warn('检查 DASH 失败', error)
      sendResponse({ ok: false, error: HLS_TEXT.offscreen })
    })
    return true
  }
  if (isDashDownloadMessage(message)) {
    void download(message).then(sendResponse, (error: unknown) => {
      warn('开始 DASH 下载失败', error)
      sendResponse({ ok: false, error: HLS_TEXT.offscreen })
    })
    return true
  }
  if (isDashCancelMessage(message)) {
    const playlistUrl = normalizeUrl(message.url) || message.url.trim()
    void sendOffscreen({ type: 'DASH_OFFSCREEN_CANCEL', playlistUrl }).then(
      (response) => sendResponse(response ?? { ok: true }),
      (error: unknown) => {
        warn('取消 DASH 失败', error)
        sendResponse({ ok: false, error: HLS_TEXT.offscreen })
      },
    )
    return true
  }
  if (isDashSyncMessage(message)) {
    void relayJobSync().then(
      (response) => sendResponse(response),
      (error: unknown) => {
        warn('同步 DASH 状态失败', error)
        sendResponse({ ok: true })
      },
    )
    return true
  }
  return undefined
}

let listening = false

export function listenForDash(): void {
  if (listening) return
  listening = true
  chrome.runtime.onMessage.addListener(handleDashMessage)
}
