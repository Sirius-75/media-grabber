/**
 * Popup 的展示规则。不访问 chrome，方便单测。
 * 打开时的消息收发在 main.ts。
 */

import { normalizeUrl } from '../shared/classify'
import {
  DOWNLOAD_FAILED_TEXT,
  DOWNLOAD_STARTED_TEXT,
  type DownloadPhase,
  type DownloadStatusMap,
  type DownloadStatusRecord,
} from '../shared/download-status'
import { formatBytes } from '../shared/format'
import type { MediaItem, MediaKind } from '../shared/types'

/** 单行里大约能放下的字符数。更长的地址用省略号截断，悬停仍看全文。 */
export const URL_VISIBLE_CHARS = 52

/** 按钮提示停留的时间。短到能看清，又不会一直占着原文。 */
export const BUTTON_FLASH_MS = 1200

const KIND_LABEL: Record<MediaKind, string> = {
  video: '视频',
  audio: '音频',
  hls: 'HLS',
  dash: 'DASH',
}

const KIND_FALLBACK_NOTE: Partial<Record<MediaKind, string>> = {
  hls: 'HLS 清单，仅支持复制链接',
  dash: 'DASH 清单，仅支持复制链接',
}

export function kindLabel(kind: MediaKind): string {
  return KIND_LABEL[kind]
}

/**
 * 中间截断，尽量留下协议和文件名。
 * 已经不长于 limit 时原样返回。
 */
export function truncateUrl(url: string, limit = URL_VISIBLE_CHARS): string {
  const text = url.trim()
  if (limit < 2 || text.length <= limit) return text
  const mark = '…'
  const room = limit - mark.length
  const head = Math.ceil(room / 2)
  const tail = room - head
  return `${text.slice(0, head)}${mark}${text.slice(text.length - tail)}`
}

function schemeOf(url: string): string {
  const index = url.indexOf(':')
  if (index <= 0) return ''
  return url.slice(0, index).toLowerCase()
}

/**
 * 直链才给出下载按钮。
 * HLS / DASH、blob / data，以及 downloadable 为 false 的条目都不显示。
 */
export function canOfferDownload(
  item: Pick<MediaItem, 'url' | 'kind' | 'downloadable'>,
): boolean {
  if (item.downloadable !== true) return false
  if (item.kind === 'hls' || item.kind === 'dash') return false
  const scheme = schemeOf(item.url)
  if (scheme === 'blob' || scheme === 'data') return false
  return true
}

/** 不可下载时给一句说明。条目自带 note 时优先用它。 */
export function itemNote(
  item: Pick<MediaItem, 'url' | 'kind' | 'downloadable' | 'note'>,
): string | undefined {
  const note = item.note?.trim()
  if (note) return note
  if (canOfferDownload(item)) return undefined
  const scheme = schemeOf(item.url)
  if (scheme === 'blob') return 'blob 地址，无法直接下载'
  if (scheme === 'data') return 'data 地址，无法直接下载'
  return KIND_FALLBACK_NOTE[item.kind] ?? '无法直接下载'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMediaItem(value: unknown): value is MediaItem {
  if (!isRecord(value)) return false
  if (typeof value.url !== 'string' || value.url === '') return false
  if (typeof value.kind !== 'string' || !(value.kind in KIND_LABEL)) return false
  if (typeof value.downloadable !== 'boolean') return false
  if (!Array.isArray(value.sources)) return false
  if (typeof value.firstSeen !== 'number' || !Number.isFinite(value.firstSeen)) return false
  return true
}

/** GET_MEDIA 的响应。不是列表就不要往界面上画。 */
export function isMediaItemList(value: unknown): value is MediaItem[] {
  return Array.isArray(value) && value.every(isMediaItem)
}

export interface DownloadFeedback {
  phase: Extract<DownloadPhase, 'started' | 'failed'>
  message: string
  downloadId?: number
}

/**
 * 后台 DOWNLOAD 的回复，转成条目上要留下的状态。
 * 真正下完是「已完成」，那一步由 downloads.onChanged 写进 session，不在这条回复里。
 */
export function statusFromDownloadResponse(response: unknown): DownloadFeedback {
  if (isRecord(response) && response.ok === true) {
    const feedback: DownloadFeedback = { phase: 'started', message: DOWNLOAD_STARTED_TEXT }
    if (typeof response.downloadId === 'number' && Number.isInteger(response.downloadId) && response.downloadId >= 0) {
      feedback.downloadId = response.downloadId
    }
    return feedback
  }
  if (isRecord(response) && typeof response.error === 'string' && response.error.trim()) {
    return { phase: 'failed', message: response.error.trim() }
  }
  return { phase: 'failed', message: DOWNLOAD_FAILED_TEXT }
}

/**
 * 下载按钮上短暂显示的结果。
 * 成功是「已开始下载」。失败原因太长时按钮只写「下载失败」，完整句子在条目的状态行上。
 */
export function downloadFeedback(response: unknown): string {
  const status = statusFromDownloadResponse(response)
  if (status.phase === 'started') return status.message
  if ([...status.message].length <= 12) return status.message
  return DOWNLOAD_FAILED_TEXT
}

/** 按规范化后的 URL 取最近一次下载状态。没有就 undefined。 */
export function statusForItem(
  item: Pick<MediaItem, 'url'>,
  statuses: DownloadStatusMap | undefined,
): DownloadStatusRecord | undefined {
  if (!statuses) return undefined
  const direct = statuses[item.url]
  if (direct) return direct
  const key = normalizeUrl(item.url)
  if (!key) return undefined
  return statuses[key]
}

export interface ListActions {
  onCopy: (url: string, button: HTMLButtonElement) => void
  onDownload: (url: string, button: HTMLButtonElement) => void
}

/** 把当前列表画进 ul。调用方保留 ul 上的点击监听，这里只换子节点。 */
export function renderList(
  list: HTMLElement,
  items: readonly MediaItem[],
  statuses?: DownloadStatusMap,
): void {
  const rows = items.map((item, index) => renderItem(item, index, statusForItem(item, statuses)))
  list.replaceChildren(...rows)
}

/**
 * 列表只绑一次。条目换了就通过 getItems 读到最新的那份，避免重复监听。
 */
export function bindListActions(
  list: HTMLElement,
  getItems: () => readonly MediaItem[],
  actions: ListActions,
): void {
  list.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('button')
    if (!(button instanceof HTMLButtonElement) || !list.contains(button)) return
    const row = button.closest('.item')
    if (!(row instanceof HTMLElement)) return
    const index = Number(row.dataset.index)
    const item = getItems()[index]
    if (!item) return
    if (button.dataset.action === 'copy') actions.onCopy(item.url, button)
    if (button.dataset.action === 'download') actions.onDownload(item.url, button)
  })
}

/** 记下按钮原来的字，过一会儿换回去。连点时只恢复最后一次。 */
export function flashButton(button: HTMLButtonElement, text: string, ms = BUTTON_FLASH_MS): void {
  if (button.dataset.label === undefined) {
    button.dataset.label = button.textContent ?? ''
  }
  button.textContent = text
  const stamp = String(Number(button.dataset.flash ?? '0') + 1)
  button.dataset.flash = stamp
  window.setTimeout(() => {
    if (button.dataset.flash !== stamp) return
    button.textContent = button.dataset.label ?? ''
    delete button.dataset.flash
  }, ms)
}

function renderItem(
  item: MediaItem,
  index: number,
  status: DownloadStatusRecord | undefined,
): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'item'
  row.dataset.index = String(index)

  const meta = document.createElement('div')
  meta.className = 'meta'

  const kind = document.createElement('span')
  kind.className = `tag tag-${item.kind}`
  kind.textContent = kindLabel(item.kind)

  const size = document.createElement('span')
  size.className = 'size'
  size.textContent = formatBytes(item.size)

  meta.append(kind, size)
  if (item.ext) {
    const ext = document.createElement('span')
    ext.className = 'ext'
    ext.textContent = item.ext
    meta.append(ext)
  }

  const url = document.createElement('p')
  url.className = 'url'
  url.textContent = truncateUrl(item.url)
  url.title = item.url

  row.append(meta, url)

  const note = itemNote(item)
  if (note) {
    const noteEl = document.createElement('p')
    noteEl.className = 'note'
    noteEl.textContent = note
    row.append(noteEl)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'copy'
  copy.dataset.action = 'copy'
  copy.textContent = '复制'
  actions.append(copy)

  if (canOfferDownload(item)) {
    const download = document.createElement('button')
    download.type = 'button'
    download.className = 'download'
    download.dataset.action = 'download'
    download.textContent = '下载'
    actions.append(download)
  }

  row.append(actions)
  if (status) setRowStatus(row, status)
  return row
}

/** 在这一行上写下最近的下载状态。重复调用只改这一段，不重建按钮。 */
export function setRowStatus(
  row: HTMLElement,
  status: Pick<DownloadStatusRecord, 'phase' | 'message'>,
): void {
  let el = row.querySelector('.status')
  if (!(el instanceof HTMLElement)) {
    el = document.createElement('p')
    const actions = row.querySelector('.actions')
    if (actions) row.insertBefore(el, actions)
    else row.append(el)
  }
  el.className = `status status-${status.phase}`
  el.textContent = status.message
}
