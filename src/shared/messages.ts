/**
 * 扩展内部消息协议。常量、载荷类型和类型守卫。
 * MEDIA_FOUND 的 tabId 不在消息里，由 background 从 sender.tab.id 取。
 */

import {
  MEDIA_KINDS,
  MEDIA_SOURCES,
  type MediaItem,
  type MediaItemDraft,
  type MediaKind,
  type MediaSource,
} from './types'

export const MESSAGE_TYPE = {
  MEDIA_FOUND: 'MEDIA_FOUND',
  GET_MEDIA: 'GET_MEDIA',
  CLEAR_MEDIA: 'CLEAR_MEDIA',
  DOWNLOAD: 'DOWNLOAD',
  HLS_INSPECT: 'HLS_INSPECT',
  HLS_DOWNLOAD: 'HLS_DOWNLOAD',
  HLS_CANCEL: 'HLS_CANCEL',
  HLS_SYNC: 'HLS_SYNC',
} as const

export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE]

/** content → background。items 至少要带 url。 */
export interface MediaFoundMessage {
  type: typeof MESSAGE_TYPE.MEDIA_FOUND
  items: MediaItemDraft[]
}

/** popup → background，返回该 tab 的 MediaItem[]。 */
export interface GetMediaMessage {
  type: typeof MESSAGE_TYPE.GET_MEDIA
  tabId: number
}

export type GetMediaResponse = MediaItem[]

/** popup → background。没有响应体。 */
export interface ClearMediaMessage {
  type: typeof MESSAGE_TYPE.CLEAR_MEDIA
  tabId: number
}

/**
 * popup → background。
 * filename 可选，后台会再做非法字符过滤；没给时用页面标题或 URL 文件名。
 * tabId 可选，用来取这个标签页的标题和列表序号。
 */
export interface DownloadMessage {
  type: typeof MESSAGE_TYPE.DOWNLOAD
  url: string
  filename?: string
  tabId?: number
}

export interface DownloadResponse {
  ok: boolean
  downloadId?: number
  error?: string
}

/** popup → background。读 m3u8：主清单返回清晰度，媒体清单直接开始下载。 */
export interface HlsInspectMessage {
  type: typeof MESSAGE_TYPE.HLS_INSPECT
  url: string
  tabId?: number
}

/** popup → background。主清单里选定一条清晰度后再下载。mediaUrl 必须属于这条清单。 */
export interface HlsDownloadMessage {
  type: typeof MESSAGE_TYPE.HLS_DOWNLOAD
  url: string
  mediaUrl: string
  tabId?: number
}

/** popup → background。取消这条清单正在进行的分片下载。 */
export interface HlsCancelMessage {
  type: typeof MESSAGE_TYPE.HLS_CANCEL
  url: string
}

/** popup 重新打开时发一次，让后台把已经中断的进度标成失败。 */
export interface HlsSyncMessage {
  type: typeof MESSAGE_TYPE.HLS_SYNC
}

export type ExtensionMessage =
  | MediaFoundMessage
  | GetMediaMessage
  | ClearMediaMessage
  | DownloadMessage
  | HlsInspectMessage
  | HlsDownloadMessage
  | HlsCancelMessage
  | HlsSyncMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === 'string' && (MEDIA_KINDS as readonly string[]).includes(value)
}

function isMediaSource(value: unknown): value is MediaSource {
  return typeof value === 'string' && (MEDIA_SOURCES as readonly string[]).includes(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isMediaItemDraft(value: unknown): value is MediaItemDraft {
  if (!isRecord(value)) return false
  if (typeof value.url !== 'string' || value.url.trim() === '') return false
  if (value.kind !== undefined && !isMediaKind(value.kind)) return false
  if (!isOptionalString(value.ext) || !isOptionalString(value.mime)) return false
  if (!isOptionalString(value.note) || !isOptionalString(value.frameUrl)) return false
  if (value.size !== undefined) {
    if (typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0) return false
  }
  if (value.downloadable !== undefined && typeof value.downloadable !== 'boolean') return false
  if (!isOptionalFiniteNumber(value.firstSeen)) return false
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || !value.sources.every(isMediaSource)) return false
  }
  return true
}

function isTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function isMediaFoundMessage(value: unknown): value is MediaFoundMessage {
  if (!isRecord(value) || value.type !== MESSAGE_TYPE.MEDIA_FOUND) return false
  return Array.isArray(value.items) && value.items.every(isMediaItemDraft)
}

export function isGetMediaMessage(value: unknown): value is GetMediaMessage {
  return isRecord(value) && value.type === MESSAGE_TYPE.GET_MEDIA && isTabId(value.tabId)
}

export function isClearMediaMessage(value: unknown): value is ClearMediaMessage {
  return isRecord(value) && value.type === MESSAGE_TYPE.CLEAR_MEDIA && isTabId(value.tabId)
}

export function isDownloadMessage(value: unknown): value is DownloadMessage {
  if (!isRecord(value) || value.type !== MESSAGE_TYPE.DOWNLOAD) return false
  if (typeof value.url !== 'string' || value.url.trim() === '') return false
  if (value.tabId !== undefined && !isTabId(value.tabId)) return false
  if (value.filename === undefined) return true
  return typeof value.filename === 'string' && value.filename.trim() !== ''
}

function isHttpishUrl(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function isHlsInspectMessage(value: unknown): value is HlsInspectMessage {
  if (!isRecord(value) || value.type !== MESSAGE_TYPE.HLS_INSPECT) return false
  if (!isHttpishUrl(value.url)) return false
  if (value.tabId !== undefined && !isTabId(value.tabId)) return false
  return true
}

export function isHlsDownloadMessage(value: unknown): value is HlsDownloadMessage {
  if (!isRecord(value) || value.type !== MESSAGE_TYPE.HLS_DOWNLOAD) return false
  if (!isHttpishUrl(value.url) || !isHttpishUrl(value.mediaUrl)) return false
  if (value.tabId !== undefined && !isTabId(value.tabId)) return false
  return true
}

export function isHlsCancelMessage(value: unknown): value is HlsCancelMessage {
  return isRecord(value) && value.type === MESSAGE_TYPE.HLS_CANCEL && isHttpishUrl(value.url)
}

export function isHlsSyncMessage(value: unknown): value is HlsSyncMessage {
  return isRecord(value) && value.type === MESSAGE_TYPE.HLS_SYNC
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return (
    isMediaFoundMessage(value) ||
    isGetMediaMessage(value) ||
    isClearMediaMessage(value) ||
    isDownloadMessage(value) ||
    isHlsInspectMessage(value) ||
    isHlsDownloadMessage(value) ||
    isHlsCancelMessage(value) ||
    isHlsSyncMessage(value)
  )
}
