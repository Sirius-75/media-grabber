/**
 * 把 HLS 下载交给 offscreen document。
 * service worker 只负责把消息转过去，并补上页面标题和列表序号。
 * 分片字节不经过这里。
 */

import { normalizeUrl } from '../shared/classify'
import { HLS_TEXT, isHttpUrl } from '../shared/hls'
import {
  isHlsCancelMessage,
  isHlsDownloadMessage,
  isHlsInspectMessage,
  isHlsSyncMessage,
  type HlsDownloadMessage,
  type HlsInspectMessage,
} from '../shared/messages'
import { getItems } from './store'

/** 和 src/offscreen/offscreen.html 的位置一致。构建后还在这个路径。 */
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'

let opening: Promise<void> | undefined

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

async function hasOffscreen(): Promise<boolean> {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    try {
      return await chrome.offscreen.hasDocument()
    } catch (error) {
      warn('检查 offscreen 失败', error)
    }
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  })
  return contexts.length > 0
}

async function createOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  try {
    await chrome.offscreen.createDocument({
      url: `${OFFSCREEN_PATH}?role=offscreen`,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification:
        '在扩展页面里把 HLS 或 DASH 分片拼成 Blob 再下载。Service worker 会被回收，不能在里面跑这个长任务。',
    })
  } catch (error) {
    if (await hasOffscreen()) return
    throw error
  }
}

/** 整个扩展同时只能有一个 offscreen document。已经开着就复用。 */
export function ensureOffscreen(): Promise<void> {
  if (!opening) {
    opening = createOffscreen().finally(() => {
      opening = undefined
    })
  }
  return opening
}

export async function sendOffscreen(message: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreen()
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response: unknown = await chrome.runtime.sendMessage(message)
      if (response !== undefined) return response
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
  }
  warn('offscreen 没有响应', lastError)
  return undefined
}

async function activeTabId(): Promise<number | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const id = tabs[0]?.id
    return typeof id === 'number' ? id : undefined
  } catch (error) {
    warn('读取当前标签页失败', error)
    return undefined
  }
}

async function pageTitle(tabId: number | undefined): Promise<string | undefined> {
  try {
    const id = tabId ?? (await activeTabId())
    if (id === undefined) return undefined
    return (await chrome.tabs.get(id)).title
  } catch (error) {
    warn('读取页面标题失败', error)
    return undefined
  }
}

async function listIndex(tabId: number | undefined, url: string): Promise<number | undefined> {
  const id = tabId ?? (await activeTabId())
  if (id === undefined) return undefined
  const items = await getItems(id)
  const normalized = normalizeUrl(url)
  const index = items.findIndex((item) => item.url === normalized || item.url === url)
  return index >= 0 ? index + 1 : undefined
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

/** 页面标题和列表序号。DASH 和 HLS 保存文件名时共用。 */
export async function downloadContext(
  tabId: number | undefined,
  url: string,
): Promise<{ title?: string; index?: number }> {
  const title = await pageTitle(tabId)
  const index = await listIndex(tabId, url)
  const context: { title?: string; index?: number } = {}
  if (title) context.title = title
  if (index !== undefined) context.index = index
  return context
}

async function forwardDownload(playlistUrl: string, mediaUrl: string, tabId: number | undefined): Promise<unknown> {
  const title = await pageTitle(tabId)
  const index = await listIndex(tabId, playlistUrl)
  const message: Record<string, unknown> = {
    type: 'HLS_OFFSCREEN_DOWNLOAD',
    playlistUrl,
    mediaUrl,
  }
  if (title) message.title = title
  if (index !== undefined) message.index = index
  return sendOffscreen(message)
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
    void sendOffscreen({ type: 'HLS_OFFSCREEN_CANCEL', playlistUrl }).then(
      (response) => sendResponse(response ?? { ok: true }),
      (error: unknown) => {
        warn('取消 HLS 失败', error)
        sendResponse({ ok: false, error: HLS_TEXT.offscreen })
      },
    )
    return true
  }
  if (isHlsSyncMessage(message)) {
    void sendOffscreen({ type: 'HLS_OFFSCREEN_SYNC' }).then(
      (response) => sendResponse(response ?? { ok: true }),
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
