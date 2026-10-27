/**
 * 下载能不能开始，以及失败时给用户看的中文原因。
 * 状态记在 chrome.storage.session，popup 关掉再打开还能读到。
 */

import { classify } from './classify'
import { DASH_TEXT } from './dash-text'
import { HLS_TEXT } from './hls'
import { INTERRUPT_REASON_TEXT } from './interrupt-reason'
import type { MediaKind } from './types'

export { DOWNLOAD_FAILED_TEXT, describeInterruptReason } from './interrupt-reason'

export const DOWNLOAD_STATUS_STORAGE_KEY = 'download-status'

/** 成功排队后、以及真正下完时，条目上显示的字。 */
export const DOWNLOAD_STARTED_TEXT = '已开始下载'
export const DOWNLOAD_FINISHED_TEXT = '已完成'

/** 每个条目上最多留这么多条最近状态，避免 session 越积越长。 */
export const MAX_REMEMBERED_DOWNLOADS = 50

const BLOB_NOTE = 'blob 地址，无法直接下载'
const DATA_NOTE = 'data 地址，无法直接下载'
const GENERIC_NOTE = '无法直接下载'
const SCHEME_NOTE = '只支持 http 或 https 直链'

export type DownloadPhase = 'started' | 'complete' | 'failed'

export interface DownloadStatusRecord {
  phase: DownloadPhase
  message: string
  downloadId?: number
  updatedAt: number
}

export type DownloadStatusMap = Record<string, DownloadStatusRecord>

/** 少一种中断原因时，这里会在类型检查里失败。 */
export const INTERRUPT_REASON_COVERAGE: Record<chrome.downloads.InterruptReason, string> = INTERRUPT_REASON_TEXT

const PHASES = new Set<DownloadPhase>(['started', 'complete', 'failed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemeOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:/i.exec(url.trim())
  if (!match) return ''
  return match[0].slice(0, -1).toLowerCase()
}

function noteOr(note: string | undefined, fallback: string): string {
  const text = note?.trim()
  return text || fallback
}

export interface DownloadBlockInput {
  url: string
  kind?: MediaKind
  downloadable?: boolean
  note?: string
  /** 这条来自当前标签页的列表。为 true 时以条目上的 downloadable 为准。 */
  fromStore: boolean
}

/**
 * 不能直接下载时返回给 popup 的原因。
 * 可以下载时返回 undefined。HLS / DASH / blob / data 以及 downloadable 为 false 都拒绝。
 */
export function downloadBlockReason(input: DownloadBlockInput): string | undefined {
  const url = input.url.trim()
  const scheme = schemeOf(url)
  if (scheme === 'blob') return noteOr(input.note, BLOB_NOTE)
  if (scheme === 'data') return noteOr(input.note, DATA_NOTE)
  if (scheme !== 'http' && scheme !== 'https') return SCHEME_NOTE

  if (input.kind === 'hls') return HLS_TEXT.directBlock
  if (input.kind === 'dash') return DASH_TEXT.directBlock

  if (input.fromStore) {
    if (input.downloadable === true && (input.kind === 'video' || input.kind === 'audio')) {
      return undefined
    }
    return noteOr(input.note, GENERIC_NOTE)
  }

  const classified = classify(url)
  if (classified?.kind === 'hls') return HLS_TEXT.directBlock
  if (classified?.kind === 'dash') return DASH_TEXT.directBlock
  if (!classified || classified.downloadable !== true) {
    return noteOr(classified?.note ?? input.note, GENERIC_NOTE)
  }
  return undefined
}

function parseStatus(value: unknown): DownloadStatusRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase as DownloadPhase)) return undefined
  if (typeof value.message !== 'string' || value.message.trim() === '') return undefined
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return undefined
  const record: DownloadStatusRecord = {
    phase: value.phase as DownloadPhase,
    message: value.message.trim(),
    updatedAt: value.updatedAt,
  }
  if (value.downloadId !== undefined) {
    if (typeof value.downloadId !== 'number' || !Number.isInteger(value.downloadId) || value.downloadId < 0) {
      return undefined
    }
    record.downloadId = value.downloadId
  }
  return record
}

/** session 里的值可能被写坏。认不出的条目丢掉，不让 popup 崩。 */
export function readDownloadStatusMap(value: unknown): DownloadStatusMap {
  if (!isRecord(value)) return {}
  const result: DownloadStatusMap = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === '') continue
    const parsed = parseStatus(entry)
    if (parsed) result[key] = parsed
  }
  return result
}

/** 超过上限时丢掉最早的。 */
export function trimDownloadStatuses(
  map: DownloadStatusMap,
  max = MAX_REMEMBERED_DOWNLOADS,
): DownloadStatusMap {
  const entries = Object.entries(map)
  if (entries.length <= max) return map
  entries.sort((left, right) => left[1].updatedAt - right[1].updatedAt)
  return Object.fromEntries(entries.slice(entries.length - max))
}
