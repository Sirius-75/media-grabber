/**
 * 把 HLS 清单的检查和分片下载交给 offscreen document。
 * service worker 补上页面标题和列表序号。
 * 进度写入和文件保存不在这里，见 offscreen-jobs.ts。分片字节不经过这里。
 */

import { normalizeUrl } from '../shared/classify'
import { HLS_TEXT, isHttpUrl } from '../shared/hls'
import { readOffscreenActiveKeys } from '../shared/offscreen-bridge'
import { noteBilibiliOffscreen } from './bilibili-rules'
import { cancelQueuedJob, enqueueHlsJob, reconcileDownloadQueue } from './queue'
import { syncStoredJobs } from './offscreen-jobs'
import {
  isHlsCancelMessage,
  isHlsDownloadMessage,
  isHlsInspectMessage,
  isHlsSyncMessage,
  type HlsDownloadMessage,
  type HlsInspectMessage,
} from '../shared/messages'
import { downloadContext, ensureOffscreen, sendOffscreen } from './offscreen-doc'

export { downloadContext, ensureOffscreen, sendOffscreen }

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

/** 问 offscreen 哪几条还在下，再把其余停在半截的进度标成中断。 */
export async function relayJobSync(): Promise<{ ok: true }> {
  let activeKeys: string[] = []
  try {
    const response = await sendOffscreen({ type: 'HLS_OFFSCREEN_SYNC' })
    activeKeys = readOffscreenActiveKeys(response)
  } catch (error) {
    warn('读取正在下载的任务失败', error)
  }
  try {
    await syncStoredJobs(activeKeys)
  } catch (error) {
    warn('写入中断状态失败', error)
  }
  // B 站规则只在这些任务还在 offscreen 里时保留。同步发现它已经不在，就删掉。
  noteBilibiliOffscreen(activeKeys)
  try {
    await reconcileDownloadQueue(activeKeys)
  } catch (error) {
    warn('同步下载队列失败', error)
  }
  return { ok: true }
}

async function forwardDownload(playlistUrl: string, mediaUrl: string, tabId: number | undefined): Promise<unknown> {
  const context = await downloadContext(tabId, playlistUrl)
  return enqueueHlsJob({ key: playlistUrl, mediaUrl, tabId, ...context })
}

async function inspect(message: HlsInspectMessage): Promise<unknown> {
  const playlistUrl = normalizeUrl(message.url) || message.url.trim()
  if (!isHttpUrl(playlistUrl)) return { ok: false, error: HLS_TEXT.badPlaylistUrl }
  try {
    await ensureOffscreen()
  } catch (error) {
    warn('打开 offscreen 失败', error)
    return { ok: false, error: HLS_TEXT.offscreen }
  }
  const inspected = await sendOffscreen({ type: 'HLS_OFFSCREEN_INSPECT', playlistUrl })
  if (inspected === undefined) return { ok: false, error: HLS_TEXT.offscreen }
  if (
    typeof inspected === 'object' &&
    inspected !== null &&
    'kind' in inspected &&
    inspected.kind === 'media' &&
    'ok' in inspected &&
    inspected.ok === true
  ) {
    const started = await forwardDownload(playlistUrl, playlistUrl, message.tabId)
    if (started === undefined) return { ok: false, error: HLS_TEXT.offscreen }
    if (isFailure(started)) return started
  }
  return inspected
}

async function download(message: HlsDownloadMessage): Promise<unknown> {
  const playlistUrl = normalizeUrl(message.url) || message.url.trim()
  const mediaUrl = message.mediaUrl.trim()
  if (!isHttpUrl(playlistUrl) || !isHttpUrl(mediaUrl)) return { ok: false, error: HLS_TEXT.badPlaylistUrl }
  try {
    await ensureOffscreen()
  } catch (error) {
    warn('打开 offscreen 失败', error)
    return { ok: false, error: HLS_TEXT.offscreen }
  }
  const started = await forwardDownload(playlistUrl, mediaUrl, message.tabId)
  return started ?? { ok: false, error: HLS_TEXT.offscreen }
}

export function handleHlsMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (isHlsInspectMessage(message)) {
    void inspect(message).then(sendResponse, (error: unknown) => {
      warn('检查 HLS 失败', error)
      sendResponse({ ok: false, error: HLS_TEXT.offscreen })
    })
    return true
  }
  if (isHlsDownloadMessage(message)) {
    void download(message).then(sendResponse, (error: unknown) => {
      warn('开始 HLS 下载失败', error)
      sendResponse({ ok: false, error: HLS_TEXT.offscreen })
    })
    return true
  }
  if (isHlsCancelMessage(message)) {
    const playlistUrl = normalizeUrl(message.url) || message.url.trim()
    void cancelQueuedJob('hls', playlistUrl)
      .then((cancelled) => {
        if (cancelled) return { ok: true }
        return sendOffscreen({ type: 'HLS_OFFSCREEN_CANCEL', playlistUrl })
      })
      .then(
        (response) => sendResponse(response ?? { ok: true }),
        (error: unknown) => {
          warn('取消 HLS 失败', error)
          sendResponse({ ok: false, error: HLS_TEXT.offscreen })
        },
      )
    return true
  }
  if (isHlsSyncMessage(message)) {
    void relayJobSync().then(
      (response) => sendResponse(response),
      (error: unknown) => {
        warn('同步 HLS 状态失败', error)
        sendResponse({ ok: true })
      },
    )
    return true
  }
  return undefined
}

let listening = false

export function listenForHls(): void {
  if (listening) return
  listening = true
  chrome.runtime.onMessage.addListener(handleHlsMessage)
}
