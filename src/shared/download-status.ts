/**
 * 下载能不能开始，以及失败时给用户看的中文原因。
 * 状态记在 chrome.storage.session，popup 关掉再打开还能读到。
 */

import { classify } from './classify'
import type { MediaKind } from './types'

export const DOWNLOAD_STATUS_STORAGE_KEY = 'download-status'

/** 成功排队后、以及真正下完时，条目上显示的字。 */
export const DOWNLOAD_STARTED_TEXT = '已开始下载'
export const DOWNLOAD_FINISHED_TEXT = '已完成'
export const DOWNLOAD_FAILED_TEXT = '下载失败'

/** 每个条目上最多留这么多条最近状态，避免 session 越积越长。 */
export const MAX_REMEMBERED_DOWNLOADS = 50

const HLS_NOTE = 'HLS 清单，仅支持复制链接'
const DASH_NOTE = 'DASH 清单，仅支持复制链接'
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

/**
 * chrome.downloads 的 InterruptReason。
 * 原样的英文代码不显示，改成能看懂的中文。
 */
const INTERRUPT_REASON_TEXT: Record<string, string> = {
  FILE_FAILED: '保存文件失败',
  FILE_ACCESS_DENIED: '没有权限写入下载目录',
  FILE_NO_SPACE: '磁盘空间不足',
  FILE_NAME_TOO_LONG: '文件名过长',
  FILE_TOO_LARGE: '文件过大',
  FILE_VIRUS_INFECTED: '文件被安全软件拦截',
  FILE_TRANSIENT_ERROR: '保存文件时出现临时错误',
  FILE_BLOCKED: '文件被浏览器拦截',
  FILE_SECURITY_CHECK_FAILED: '安全检查未通过',
  FILE_TOO_SHORT: '下载的文件不完整',
  FILE_HASH_MISMATCH: '文件校验失败',
  FILE_SAME_AS_SOURCE: '无法覆盖源文件',
  NETWORK_FAILED: '网络连接失败',
  NETWORK_TIMEOUT: '网络超时',
  NETWORK_DISCONNECTED: '网络已断开',
  NETWORK_SERVER_DOWN: '服务器无响应',
  NETWORK_INVALID_REQUEST: '下载请求无效',
  SERVER_FAILED: '服务器返回错误',
  SERVER_NO_RANGE: '服务器不支持断点续传',
  SERVER_BAD_CONTENT: '服务器返回了无效内容',
  SERVER_UNAUTHORIZED: '需要登录或未授权（401）',
  SERVER_CERT_PROBLEM: '服务器证书无效',
  SERVER_FORBIDDEN: '服务器拒绝访问（403）',
  SERVER_UNREACHABLE: '无法连接服务器',
  SERVER_CONTENT_LENGTH_MISMATCH: '文件大小和服务器声明的不一致',
  SERVER_CROSS_ORIGIN_REDIRECT: '跨域重定向被拒绝',
  USER_CANCELED: '下载已取消',
  USER_SHUTDOWN: '浏览器关闭，下载已中断',
  CRASH: '下载进程异常退出',
} satisfies Record<chrome.downloads.InterruptReason, string>

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

  if (input.kind === 'hls') return noteOr(input.note, HLS_NOTE)
  if (input.kind === 'dash') return noteOr(input.note, DASH_NOTE)

  if (input.fromStore) {
    if (input.downloadable === true && (input.kind === 'video' || input.kind === 'audio')) {
      return undefined
    }
    return noteOr(input.note, GENERIC_NOTE)
  }

  const classified = classify(url)
  if (!classified || classified.downloadable !== true) {
    return noteOr(classified?.note ?? input.note, GENERIC_NOTE)
  }
  if (classified.kind === 'hls' || classified.kind === 'dash') {
    return noteOr(classified.note, classified.kind === 'hls' ? HLS_NOTE : DASH_NOTE)
  }
  return undefined
}

/** 把 InterruptReason 或带这个代码的错误文本翻成中文。认不出就用「下载失败」。 */
export function describeInterruptReason(reason: string | undefined): string {
  if (typeof reason !== 'string') return DOWNLOAD_FAILED_TEXT
  const trimmed = reason.trim()
  if (!trimmed) return DOWNLOAD_FAILED_TEXT
  const table: Record<string, string> = INTERRUPT_REASON_TEXT
  const exact = table[trimmed]
  if (exact) return exact
  for (const code of Object.keys(table)) {
    if (trimmed.includes(code)) return table[code]
  }
  if (/403|forbidden/i.test(trimmed)) return table.SERVER_FORBIDDEN
  if (/network[_\s-]*failed/i.test(trimmed)) return table.NETWORK_FAILED
  return DOWNLOAD_FAILED_TEXT
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
