/**
 * offscreen 页面和 service worker 的唯一通道。
 * 这里只使用 chrome.runtime。会话存储和保存文件都在后台。
 */

import type { HlsJobRecord } from '../shared/hls-job'
import { OFFSCREEN_BRIDGE } from '../shared/offscreen-bridge'

const BLOB_REVOKE_DELAY_MS = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(value: unknown, fallback: string): string {
  if (!isRecord(value) || typeof value.error !== 'string') return fallback
  const text = value.error.trim()
  return text || fallback
}

export async function putJob(storageKey: string, key: string, record: HlsJobRecord): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: OFFSCREEN_BRIDGE.WRITE_JOB,
    storageKey,
    key,
    record,
  })
  if (!isRecord(response) || response.ok !== true) {
    throw new Error(errorText(response, '写入任务状态失败'))
  }
}

export async function cancelStoredJob(storageKey: string, key: string, phases: readonly string[]): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: OFFSCREEN_BRIDGE.CANCEL_JOB,
    storageKey,
    key,
    phases: [...phases],
  })
  if (!isRecord(response) || response.ok !== true) {
    throw new Error(errorText(response, '写入任务状态失败'))
  }
}

function scheduleRevoke(url: string): void {
  // 后台读取 blob 地址是异步的。收到回复后再等一会儿，马上 revoke 会让保存失败。
  setTimeout(() => URL.revokeObjectURL(url), BLOB_REVOKE_DELAY_MS)
}

export async function saveBlobFile(
  parts: Uint8Array[],
  mime: string,
  filename: string,
): Promise<{ ok: true; downloadId: number } | { ok: false; error: string }> {
  const blob = new Blob(parts as BlobPart[], { type: mime })
  const objectUrl = URL.createObjectURL(blob)
  let response: unknown
  try {
    response = await chrome.runtime.sendMessage({
      type: OFFSCREEN_BRIDGE.SAVE_BLOB,
      url: objectUrl,
      filename,
    })
  } finally {
    scheduleRevoke(objectUrl)
  }
  if (!isRecord(response) || response.ok !== true) {
    return { ok: false, error: errorText(response, '保存文件失败') }
  }
  if (typeof response.downloadId !== 'number' || !Number.isInteger(response.downloadId) || response.downloadId < 0) {
    return { ok: false, error: '保存文件失败' }
  }
  return { ok: true, downloadId: response.downloadId }
}
