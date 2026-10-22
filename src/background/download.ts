/**
 * DOWNLOAD 的占位回复。
 * popup 点「下载」会发这条消息。本轮不调用 chrome.downloads，也不写存储。
 * 真正下载留给后续任务，到时候替换 handleDownloadMessage 的回复即可。
 */

import { isDownloadMessage, type DownloadResponse } from '../shared/messages'

export const DOWNLOAD_PENDING_ERROR = '即将支持'

export function handleDownloadMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (!isDownloadMessage(message)) return undefined
  const response: DownloadResponse = { ok: false, error: DOWNLOAD_PENDING_ERROR }
  sendResponse(response)
  return true
}

let listening = false

/** 重复调用不会叠两层监听。GET_MEDIA 等仍由 store 处理。 */
export function listenForDownload(): void {
  if (listening) return
  listening = true
  chrome.runtime.onMessage.addListener(handleDownloadMessage)
}
