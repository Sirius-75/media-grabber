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
import { DASH_NOTE } from '../shared/dash-text'
import type { HlsJobMap, HlsJobPhase, HlsJobRecord } from '../shared/hls-job'
import type { BilibiliRole, MediaItem, MediaKind } from '../shared/types'

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

const HLS_NOTE = 'HLS 清单，可下载未加密的点播'
const OLD_HLS_NOTE = 'HLS 清单，仅支持复制链接'
const OLD_DASH_NOTE = 'DASH 清单，仅支持复制链接'

const KIND_FALLBACK_NOTE: Partial<Record<MediaKind, string>> = {
  hls: HLS_NOTE,
  dash: DASH_NOTE,
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
 * 直链才走 chrome.downloads 那个下载按钮。
 * HLS 用另一颗按钮。DASH、blob、data，以及 downloadable 为 false 的条目都不显示这颗。
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

/** m3u8 的 http(s) 地址可以下载未加密点播。 */
export function canOfferHlsDownload(item: Pick<MediaItem, 'url' | 'kind'>): boolean {
  if (item.kind !== 'hls') return false
  const scheme = schemeOf(item.url)
  return scheme === 'http' || scheme === 'https'
}

/** mpd 的 http(s) 地址可以下载未加密的静态点播。 */
export function canOfferDashDownload(item: Pick<MediaItem, 'url' | 'kind'>): boolean {
  if (item.kind !== 'dash') return false
  const scheme = schemeOf(item.url)
  return scheme === 'http' || scheme === 'https'
}

/** B 站分轨不走普通直链，单独一颗按钮。 */
export function canOfferBilibiliDownload(item: Pick<MediaItem, 'url' | 'bilibili'>): boolean {
  if (!item.bilibili?.label) return false
  const scheme = schemeOf(item.url)
  return scheme === 'http' || scheme === 'https'
}

function bilibiliButtonText(role: BilibiliRole): string {
  if (role === 'audio') return '下载音频'
  if (role === 'unknown') return '下载'
  return '下载视频'
}

/** 不可下载时给一句说明。条目自带 note 时优先用它。 */
export function itemNote(
  item: Pick<MediaItem, 'url' | 'kind' | 'downloadable' | 'note'>,
): string | undefined {
  if (canOfferHlsDownload(item)) {
    const note = item.note?.trim()
    if (note && note !== OLD_HLS_NOTE) return note
    return HLS_NOTE
  }
  if (canOfferDashDownload(item)) {
    const note = item.note?.trim()
    if (note && note !== OLD_DASH_NOTE) return note
    return DASH_NOTE
  }
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

/** 按规范化后的 URL 取 HLS 任务。 */
export function hlsJobForItem(
  item: Pick<MediaItem, 'url'>,
  jobs: HlsJobMap | undefined,
): HlsJobRecord | undefined {
  if (!jobs) return undefined
  const direct = jobs[item.url]
  if (direct) return direct
  const key = normalizeUrl(item.url)
  if (!key) return undefined
  return jobs[key]
}

export interface ListActions {
  onCopy: (url: string, button: HTMLButtonElement) => void
  onDownload: (url: string, button: HTMLButtonElement) => void
  onHlsDownload?: (url: string, button: HTMLButtonElement) => void
  onHlsStart?: (url: string, mediaUrl: string, button: HTMLButtonElement) => void
  onHlsCancel?: (url: string, button: HTMLButtonElement) => void
  onHlsVariant?: (url: string, mediaUrl: string) => void
  onDashDownload?: (url: string, button: HTMLButtonElement) => void
  onDashStart?: (url: string, mediaUrl: string, button: HTMLButtonElement) => void
  onDashCancel?: (url: string, button: HTMLButtonElement) => void
  onDashVariant?: (url: string, mediaUrl: string) => void
  onBilibiliDownload?: (url: string, button: HTMLButtonElement) => void
  onBilibiliWithAudio?: (url: string, button: HTMLButtonElement) => void
  onBilibiliCancel?: (url: string, button: HTMLButtonElement) => void
}

/** 把当前列表画进 ul。调用方保留 ul 上的点击监听，这里只换子节点。 */
export function renderList(
  list: HTMLElement,
  items: readonly MediaItem[],
  statuses?: DownloadStatusMap,
  jobs?: HlsJobMap,
  preferredVariant?: ReadonlyMap<string, string>,
  dashJobs?: HlsJobMap,
  bilibiliJobs?: HlsJobMap,
): void {
  const pairAudio = items.some((item) => item.bilibili?.role === 'audio')
  const rows = items.map((item, index) =>
    renderItem(
      item,
      index,
      statusForItem(item, statuses),
      hlsJobForItem(item, jobs),
      preferredVariant?.get(item.url),
      hlsJobForItem(item, dashJobs),
      hlsJobForItem(item, bilibiliJobs),
      pairAudio,
    ),
  )
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
    if (button.dataset.action === 'hls-download') actions.onHlsDownload?.(item.url, button)
    if (button.dataset.action === 'hls-cancel') actions.onHlsCancel?.(item.url, button)
    if (button.dataset.action === 'hls-start') {
      const select = row.querySelector('select')
      const mediaUrl = select instanceof HTMLSelectElement ? select.value : ''
      actions.onHlsStart?.(item.url, mediaUrl, button)
    }
    if (button.dataset.action === 'dash-download') actions.onDashDownload?.(item.url, button)
    if (button.dataset.action === 'dash-cancel') actions.onDashCancel?.(item.url, button)
    if (button.dataset.action === 'dash-start') {
      const select = row.querySelector('select')
      const mediaUrl = select instanceof HTMLSelectElement ? select.value : ''
      actions.onDashStart?.(item.url, mediaUrl, button)
    }
    if (button.dataset.action === 'bilibili-download') actions.onBilibiliDownload?.(item.url, button)
    if (button.dataset.action === 'bilibili-with-audio') actions.onBilibiliWithAudio?.(item.url, button)
    if (button.dataset.action === 'bilibili-cancel') actions.onBilibiliCancel?.(item.url, button)
  })
  list.addEventListener('change', (event) => {
    const select = event.target
    if (!(select instanceof HTMLSelectElement) || !list.contains(select)) return
    const row = select.closest('.item')
    if (!(row instanceof HTMLElement)) return
    const index = Number(row.dataset.index)
    const item = getItems()[index]
    if (!item || !select.value) return
    if (item.kind === 'dash') actions.onDashVariant?.(item.url, select.value)
    else actions.onHlsVariant?.(item.url, select.value)
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

function hlsStatusPhase(phase: HlsJobPhase): DownloadPhase {
  if (phase === 'complete') return 'complete'
  if (phase === 'failed' || phase === 'cancelled') return 'failed'
  return 'started'
}

function renderItem(
  item: MediaItem,
  index: number,
  status: DownloadStatusRecord | undefined,
  hlsJob: HlsJobRecord | undefined,
  preferredMediaUrl: string | undefined,
  dashJob: HlsJobRecord | undefined,
  bilibiliJob: HlsJobRecord | undefined,
  pairAudio: boolean,
): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'item'
  row.dataset.index = String(index)

  const meta = document.createElement('div')
  meta.className = 'meta'

  const kind = document.createElement('span')
  kind.className = `tag tag-${item.kind}`
  if (item.bilibili) kind.classList.add('tag-bilibili')
  kind.textContent = item.bilibili?.label.trim() || kindLabel(item.kind)

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

  const segment = canOfferHlsDownload(item)
    ? { job: hlsJob, action: 'hls' as const }
    : canOfferDashDownload(item)
      ? { job: dashJob, action: 'dash' as const }
      : undefined
  const hls = segment?.job ?? (canOfferBilibiliDownload(item) ? bilibiliJob : undefined)
  // 下载进行中时，进度和失败原因已经说明状态，不再重复清单说明。
  if (!hls || hls.phase === 'picking') {
    const note = itemNote(item)
    if (note) {
      const noteEl = document.createElement('p')
      noteEl.className = 'note'
      noteEl.textContent = note
      row.append(noteEl)
    }
  }

  if (
    hls?.warning &&
    (hls.phase === 'downloading' || hls.phase === 'picking' || hls.phase === 'failed' || hls.phase === 'remuxing')
  ) {
    const warning = document.createElement('p')
    warning.className = 'warning'
    warning.textContent = hls.warning
    row.append(warning)
  }

  if (hls && hls.phase === 'downloading') {
    const progress = document.createElement('div')
    progress.className = 'progress'
    progress.setAttribute('role', 'progressbar')
    progress.setAttribute('aria-valuemin', '0')
    progress.setAttribute('aria-valuemax', String(hls.total))
    progress.setAttribute('aria-valuenow', String(hls.completed))
    const fill = document.createElement('div')
    fill.className = 'progress-fill'
    const ratio = hls.total > 0 ? Math.min(100, Math.round((hls.completed / hls.total) * 100)) : 0
    fill.style.width = `${ratio}%`
    progress.append(fill)
    row.append(progress)
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

  // HLS 和 DASH 共用进度、清晰度和取消。动作名前缀不同，避免点到另一条链路。
  if (segment) {
    const prefix = segment.action
    if (hls?.phase === 'picking' && hls.variants && hls.variants.length > 0) {
      const select = document.createElement('select')
      select.className = 'quality'
      select.setAttribute('aria-label', '清晰度')
      for (const variant of hls.variants) {
        const option = document.createElement('option')
        option.value = variant.url
        option.textContent = variant.label
        select.append(option)
      }
      const chosen = preferredMediaUrl && hls.variants.some((variant) => variant.url === preferredMediaUrl)
        ? preferredMediaUrl
        : hls.variants[0]?.url
      if (chosen) select.value = chosen
      const start = document.createElement('button')
      start.type = 'button'
      start.dataset.action = `${prefix}-start`
      start.textContent = '开始下载'
      actions.append(select, start)
    } else if (hls?.phase === 'downloading' || hls?.phase === 'inspecting' || hls?.phase === 'remuxing') {
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.dataset.action = `${prefix}-cancel`
      cancel.textContent = '取消'
      actions.append(cancel)
    } else {
      const download = document.createElement('button')
      download.type = 'button'
      download.className = `${prefix}-download`
      download.dataset.action = `${prefix}-download`
      download.textContent = '下载'
      actions.append(download)
    }
  }

  if (!segment && canOfferBilibiliDownload(item) && item.bilibili) {
    const busy = hls?.phase === 'downloading' || hls?.phase === 'inspecting'
    if (busy) {
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.dataset.action = 'bilibili-cancel'
      cancel.textContent = '取消'
      actions.append(cancel)
    } else {
      const download = document.createElement('button')
      download.type = 'button'
      download.className = 'bilibili-download'
      download.dataset.action = 'bilibili-download'
      download.textContent = bilibiliButtonText(item.bilibili.role)
      actions.append(download)
      if (pairAudio && (item.bilibili.role === 'video' || item.bilibili.role === 'file')) {
        const both = document.createElement('button')
        both.type = 'button'
        both.dataset.action = 'bilibili-with-audio'
        both.textContent = '下载视频+音频'
        actions.append(both)
      }
    }
  }

  row.append(actions)
  if (hls) setRowStatus(row, { phase: hlsStatusPhase(hls.phase), message: hls.message })
  else if (status) setRowStatus(row, status)
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
