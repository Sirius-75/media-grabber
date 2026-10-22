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

/** popup → background。filename 可选，后台会再做非法字符过滤。 */
export interface DownloadMessage {
  type: typeof MESSAGE_TYPE.DOWNLOAD
  url: string
  filename?: string
}

export interface DownloadResponse {
  ok: boolean
  downloadId?: number
  error?: string
}

export type ExtensionMessage =
  | MediaFoundMessage
  | GetMediaMessage
  | ClearMediaMessage
  | DownloadMessage

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
  if (value.filename === undefined) return true
  return typeof value.filename === 'string' && value.filename.trim() !== ''
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return (
    isMediaFoundMessage(value) ||
    isGetMediaMessage(value) ||
    isClearMediaMessage(value) ||
    isDownloadMessage(value)
  )
}
