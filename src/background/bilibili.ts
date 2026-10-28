/**
 * B 站分轨下载。
 * service worker 先加上 Referer 会话规则，再通知 offscreen 去拉文件。
 * 进度和保存文件仍走原来的 offscreen 消息。这里不改 HLS、DASH 和普通直链。
 */

import { downloadContext, ensureOffscreen, relayJobSync, sendOffscreen } from './hls'
import {
  clearBilibiliRefererOnStartup,
  finishBilibiliDownload,
  noteBilibiliOffscreen,
  runBilibiliWithReferer,
  waitForBilibiliDownload,
} from './bilibili-rules'
import { getItems } from './store'
import { BILIBILI_OFFSCREEN, BILIBILI_PORT, BILIBILI_TEXT, planBilibiliFiles } from '../shared/bilibili'
import { normalizeUrl } from '../shared/classify'
import { HLS_TEXT, isHttpUrl } from '../shared/hls'
import {
  isBilibiliCancelMessage,
  isBilibiliDownloadMessage,
  isBilibiliSyncMessage,
  type BilibiliDownloadMessage,
} from '../shared/messages'
function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function pageUrlOf(tabId: number | undefined): Promise<string | undefined> {
  try {
    const id =
      tabId ??
      (await chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]?.id))
    if (typeof id !== 'number') return undefined
    return (await chrome.tabs.get(id)).url
  } catch (error) {
    warn('读取页面地址失败', error)
    return undefined
  }
}

function failureOf(value: unknown): { ok: false; error: string } | undefined {
  if (!isRecord(value) || value.ok !== false) return undefined
  if (typeof value.error !== 'string' || value.error.trim() === '') return { ok: false, error: HLS_TEXT.offscreen }
  return { ok: false, error: value.error }
}

function doneResult(value: unknown): { ok: boolean; error?: string; cancelled?: boolean } | undefined {
  if (!isRecord(value) || value.type !== BILIBILI_OFFSCREEN.DONE) return undefined
  if (typeof value.key !== 'string' || value.key.trim() === '') return undefined
  const result: { ok: boolean; error?: string; cancelled?: boolean } = { ok: value.ok === true }
  if (typeof value.error === 'string' && value.error.trim()) result.error = value.error
  if (value.cancelled === true) result.cancelled = true
  if (!result.ok && !result.error) result.error = HLS_TEXT.offscreen
  return result
}

async function download(message: BilibiliDownloadMessage): Promise<unknown> {
  const primary = normalizeUrl(message.url) || message.url.trim()
  if (!isHttpUrl(primary)) return { ok: false, error: BILIBILI_TEXT.badMedia }
  const tabId = message.tabId
  const pageUrl = await pageUrlOf(tabId)
  if (!pageUrl) return { ok: false, error: BILIBILI_TEXT.badPage }
  const items = tabId === undefined ? [] : await getItems(tabId)
  const planned = planBilibiliFiles(items, primary, message.withAudio === true)
  if (!planned.ok) return planned
  const context = await downloadContext(tabId, primary)
  return runBilibiliWithReferer(
    { pageUrl, mediaUrls: planned.files.map((file) => file.url), jobKey: primary },
    async () => {
      const pending = waitForBilibiliDownload(primary)
      try {
        await ensureOffscreen()
      } catch (error) {
        warn('打开 offscreen 失败', error)
        finishBilibiliDownload(primary, { ok: false, error: HLS_TEXT.offscreen })
        return pending
      }
      const payload: Record<string, unknown> = {
        type: BILIBILI_OFFSCREEN.DOWNLOAD,
        key: primary,
        files: planned.files,
      }
      if (context.title) payload.title = context.title
      if (context.index !== undefined) payload.index = context.index
      if (message.separate === true) payload.separate = true
      const started = await sendOffscreen(payload)
      const failed = failureOf(started)
      if (started === undefined || failed) {
        finishBilibiliDownload(primary, failed ?? { ok: false, error: HLS_TEXT.offscreen })
      }
      return pending
    },
  )
}

function onPort(port: chrome.runtime.Port): void {
  if (port.name !== BILIBILI_PORT) return
  port.onDisconnect.addListener(() => {
    // 正常结束时，完成消息会先解开等待，这里再断开就什么也不做。
    // 后台页中途没了，等待还在，就按中断结束并删规则。
    noteBilibiliOffscreen(undefined)
  })
}

export function handleBilibiliMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  const done = doneResult(message)
  if (done && isRecord(message) && typeof message.key === 'string') {
    finishBilibiliDownload(message.key, done)
    sendResponse({ ok: true })
    return true
  }
  if (isBilibiliDownloadMessage(message)) {
    void download(message).then(sendResponse, (error: unknown) => {
      warn('开始 B站 下载失败', error)
      sendResponse({ ok: false, error: HLS_TEXT.offscreen })
    })
    return true
  }
  if (isBilibiliCancelMessage(message)) {
    const key = normalizeUrl(message.url) || message.url.trim()
    void sendOffscreen({ type: BILIBILI_OFFSCREEN.CANCEL, key }).then(
      (response) => {
        if (response === undefined) noteBilibiliOffscreen(undefined)
        sendResponse(response ?? { ok: true })
      },
      (error: unknown) => {
        warn('取消 B站 下载失败', error)
        noteBilibiliOffscreen(undefined)
        sendResponse({ ok: false, error: HLS_TEXT.offscreen })
      },
    )
    return true
  }
  if (isBilibiliSyncMessage(message)) {
    void relayJobSync().then(
      (response) => sendResponse(response),
      (error: unknown) => {
        warn('同步 B站 状态失败', error)
        sendResponse({ ok: true })
      },
    )
    return true
  }
  return undefined
}

let listening = false

export function listenForBilibili(): void {
  if (listening) return
  listening = true
  chrome.runtime.onMessage.addListener(handleBilibiliMessage)
  chrome.runtime.onConnect.addListener(onPort)
}

export { clearBilibiliRefererOnStartup }
