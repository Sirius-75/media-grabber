/**
 * Popup 入口。
 * 打开时查询当前标签页，向 background 发 GET_MEDIA。
 * 复制把完整链接写入剪贴板。下载发 DOWNLOAD，结果写在条目上。
 * 最近一次状态在 chrome.storage.session，关掉再打开还能看到。
 * 清空发 CLEAR_MEDIA。这里不改嗅探。
 */

import { BILIBILI_JOB_STORAGE_KEY, BILIBILI_TEXT } from '../shared/bilibili'
import { normalizeUrl } from '../shared/classify'
import { DASH_JOB_STORAGE_KEY, readDashJobMap } from '../shared/dash-job'
import {
  DOWNLOAD_STATUS_STORAGE_KEY,
  readDownloadStatusMap,
  type DownloadStatusMap,
  type DownloadStatusRecord,
} from '../shared/download-status'
import { HLS_TEXT } from '../shared/hls'
import {
  HLS_JOB_STORAGE_KEY,
  readHlsJobMap,
  readHlsUserResponse,
  type HlsJobMap,
  type HlsJobRecord,
} from '../shared/hls-job'
import {
  MESSAGE_TYPE,
  type BilibiliDownloadMessage,
  type DashDownloadMessage,
  type DashInspectMessage,
  type DownloadMessage,
  type HlsDownloadMessage,
  type HlsInspectMessage,
} from '../shared/messages'
import type { MediaItem } from '../shared/types'
import {
  bindListActions,
  downloadFeedback,
  flashButton,
  isMediaItemList,
  renderList,
  setRowStatus,
  statusFromDownloadResponse,
} from './view.ts'

const countEl = document.querySelector('#count')
const bannerEl = document.querySelector('#banner')
const emptyEl = document.querySelector('#empty')
const listEl = document.querySelector('#list')
const clearButton = document.querySelector('#clear')

let tabId: number | undefined
let items: MediaItem[] = []
let statuses: DownloadStatusMap = {}
let jobs: HlsJobMap = {}
let dashJobs: HlsJobMap = {}
let bilibiliJobs: HlsJobMap = {}
/** 用户在清晰度列表里点过的地址。DASH 里存的是 Representation id。重画时不要跳回默认项。 */
const preferredVariant = new Map<string, string>()

function showBanner(text: string): void {
  if (!(bannerEl instanceof HTMLElement)) return
  bannerEl.hidden = false
  bannerEl.textContent = text
}

function hideBanner(): void {
  if (!(bannerEl instanceof HTMLElement)) return
  bannerEl.hidden = true
  bannerEl.textContent = ''
}

function paint(): void {
  if (!(countEl instanceof HTMLElement)) return
  if (!(emptyEl instanceof HTMLElement)) return
  if (!(listEl instanceof HTMLElement)) return
  if (!(clearButton instanceof HTMLButtonElement)) return

  countEl.textContent = `共 ${items.length} 条`
  clearButton.disabled = tabId === undefined || items.length === 0
  renderList(listEl, items, statuses, jobs, preferredVariant, dashJobs, bilibiliJobs)
  const isEmpty = items.length === 0
  emptyEl.hidden = !isEmpty
  listEl.hidden = isEmpty
}

async function queryActiveTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const id = tabs[0]?.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return undefined
  return id
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return fallbackCopy(text)
  }
}

/** 剪贴板 API 不可用时，用一次用户手势里的选区复制。 */
function fallbackCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

async function copyUrl(url: string, button: HTMLButtonElement): Promise<void> {
  const ok = await writeClipboard(url)
  flashButton(button, ok ? '已复制' : '复制失败')
}

function statusKey(url: string): string {
  return normalizeUrl(url) || url
}

/** 只比用户能看到的内容。session 回写的时间戳不同，不必整表重画。 */
function sameStatuses(left: DownloadStatusMap, right: DownloadStatusMap): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => {
    const a = left[key]
    const b = right[key]
    return (
      a !== undefined &&
      b !== undefined &&
      a.phase === b.phase &&
      a.message === b.message &&
      a.downloadId === b.downloadId
    )
  })
}

function rememberLocal(url: string, record: Omit<DownloadStatusRecord, 'updatedAt'>): void {
  statuses = {
    ...statuses,
    [statusKey(url)]: { ...record, updatedAt: Date.now() },
  }
}

async function readSession(): Promise<void> {
  const stored = await chrome.storage.session.get([
    DOWNLOAD_STATUS_STORAGE_KEY,
    HLS_JOB_STORAGE_KEY,
    DASH_JOB_STORAGE_KEY,
    BILIBILI_JOB_STORAGE_KEY,
  ])
  statuses = readDownloadStatusMap(stored[DOWNLOAD_STATUS_STORAGE_KEY])
  jobs = readHlsJobMap(stored[HLS_JOB_STORAGE_KEY])
  dashJobs = readDashJobMap(stored[DASH_JOB_STORAGE_KEY])
  bilibiliJobs = readHlsJobMap(stored[BILIBILI_JOB_STORAGE_KEY])
}

function rememberJob(url: string, record: Omit<HlsJobRecord, 'updatedAt'>): void {
  jobs = {
    ...jobs,
    [statusKey(url)]: { ...record, updatedAt: Date.now() },
  }
}

function sameJobs(left: HlsJobMap, right: HlsJobMap): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => {
    const a = left[key]
    const b = right[key]
    if (!a || !b) return false
    if (a.phase !== b.phase || a.message !== b.message || a.completed !== b.completed) return false
    if (a.total !== b.total || a.warning !== b.warning) return false
    const leftVariants = a.variants ?? []
    const rightVariants = b.variants ?? []
    if (leftVariants.length !== rightVariants.length) return false
    return leftVariants.every((variant, index) => variant.url === rightVariants[index]?.url && variant.label === rightVariants[index]?.label)
  })
}

function onStorageChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  area: chrome.storage.AreaName,
): void {
  if (area !== 'session') return
  let nextStatuses = statuses
  let nextJobs = jobs
  let nextDash = dashJobs
  let nextBilibili = bilibiliJobs
  let changed = false
  if (DOWNLOAD_STATUS_STORAGE_KEY in changes) {
    const parsed = readDownloadStatusMap(changes[DOWNLOAD_STATUS_STORAGE_KEY]?.newValue)
    if (!sameStatuses(statuses, parsed)) {
      nextStatuses = parsed
      changed = true
    }
  }
  if (HLS_JOB_STORAGE_KEY in changes) {
    const parsed = readHlsJobMap(changes[HLS_JOB_STORAGE_KEY]?.newValue)
    if (!sameJobs(jobs, parsed)) {
      nextJobs = parsed
      changed = true
    }
  }
  if (DASH_JOB_STORAGE_KEY in changes) {
    const parsed = readDashJobMap(changes[DASH_JOB_STORAGE_KEY]?.newValue)
    if (!sameJobs(dashJobs, parsed)) {
      nextDash = parsed
      changed = true
    }
  }
  if (BILIBILI_JOB_STORAGE_KEY in changes) {
    const parsed = readHlsJobMap(changes[BILIBILI_JOB_STORAGE_KEY]?.newValue)
    if (!sameJobs(bilibiliJobs, parsed)) {
      nextBilibili = parsed
      changed = true
    }
  }
  if (!changed) return
  statuses = nextStatuses
  jobs = nextJobs
  dashJobs = nextDash
  bilibiliJobs = nextBilibili
  paint()
}

/** 等待下载回复时，storage 回调可能已经重画过列表，原来的按钮会脱离文档。 */
function liveDownloadRow(url: string, button: HTMLButtonElement): HTMLElement | undefined {
  if (button.isConnected) {
    const row = button.closest('.item')
    if (row instanceof HTMLElement) return row
  }
  if (!(listEl instanceof HTMLElement)) return undefined
  const key = statusKey(url)
  const index = items.findIndex((item) => item.url === url || statusKey(item.url) === key)
  const row = listEl.querySelectorAll('.item')[index]
  return row instanceof HTMLElement ? row : undefined
}

async function requestHlsDownload(url: string): Promise<void> {
  rememberJob(url, { phase: 'inspecting', message: HLS_TEXT.inspecting, completed: 0, total: 0 })
  paint()
  const message: HlsInspectMessage = { type: MESSAGE_TYPE.HLS_INSPECT, url }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response = readHlsUserResponse(await chrome.runtime.sendMessage(message))
    if (!response || response.ok === false) {
      rememberJob(url, {
        phase: 'failed',
        message: response && response.ok === false ? response.error : '读取清单失败',
        completed: 0,
        total: 0,
      })
      paint()
      return
    }
    if ('kind' in response && response.kind === 'master') {
      rememberJob(url, {
        phase: 'picking',
        message: HLS_TEXT.picking,
        completed: 0,
        total: 0,
        variants: response.variants,
        warning: response.warning,
      })
      paint()
      return
    }
    if ('kind' in response && response.kind === 'media') {
      rememberJob(url, {
        phase: 'downloading',
        message: HLS_TEXT.started,
        completed: 0,
        total: response.total,
        warning: response.warning,
      })
      paint()
      return
    }
    rememberJob(url, { phase: 'failed', message: '读取清单失败', completed: 0, total: 0 })
    paint()
  } catch {
    rememberJob(url, { phase: 'failed', message: '读取清单失败', completed: 0, total: 0 })
    paint()
  }
}

async function startHlsDownload(url: string, mediaUrl: string): Promise<void> {
  if (!mediaUrl) {
    rememberJob(url, { phase: 'failed', message: HLS_TEXT.noVariants, completed: 0, total: 0 })
    paint()
    return
  }
  preferredVariant.set(url, mediaUrl)
  rememberJob(url, { phase: 'downloading', message: HLS_TEXT.started, completed: 0, total: 0 })
  paint()
  const message: HlsDownloadMessage = { type: MESSAGE_TYPE.HLS_DOWNLOAD, url, mediaUrl }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response = readHlsUserResponse(await chrome.runtime.sendMessage(message))
    if (!response || response.ok === false) {
      rememberJob(url, {
        phase: 'failed',
        message: response && response.ok === false ? response.error : HLS_TEXT.offscreen,
        completed: 0,
        total: 0,
      })
      paint()
    }
  } catch {
    rememberJob(url, { phase: 'failed', message: HLS_TEXT.offscreen, completed: 0, total: 0 })
    paint()
  }
}

function rememberDash(url: string, record: Omit<HlsJobRecord, 'updatedAt'>): void {
  dashJobs = {
    ...dashJobs,
    [statusKey(url)]: { ...record, updatedAt: Date.now() },
  }
}

async function requestDashDownload(url: string): Promise<void> {
  rememberDash(url, { phase: 'inspecting', message: HLS_TEXT.inspecting, completed: 0, total: 0 })
  paint()
  const message: DashInspectMessage = { type: MESSAGE_TYPE.DASH_INSPECT, url }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response = readHlsUserResponse(await chrome.runtime.sendMessage(message))
    if (!response || response.ok === false) {
      rememberDash(url, {
        phase: 'failed',
        message: response && response.ok === false ? response.error : '读取清单失败',
        completed: 0,
        total: 0,
      })
      paint()
      return
    }
    if ('kind' in response && response.kind === 'master') {
      rememberDash(url, {
        phase: 'picking',
        message: HLS_TEXT.picking,
        completed: 0,
        total: 0,
        variants: response.variants,
        warning: response.warning,
      })
      paint()
      return
    }
    if ('kind' in response && response.kind === 'media') {
      rememberDash(url, {
        phase: 'downloading',
        message: HLS_TEXT.started,
        completed: 0,
        total: response.total,
        warning: response.warning,
      })
      paint()
      return
    }
    rememberDash(url, { phase: 'failed', message: '读取清单失败', completed: 0, total: 0 })
    paint()
  } catch {
    rememberDash(url, { phase: 'failed', message: '读取清单失败', completed: 0, total: 0 })
    paint()
  }
}

async function startDashDownload(url: string, representationId: string): Promise<void> {
  if (!representationId) {
    rememberDash(url, { phase: 'failed', message: HLS_TEXT.noVariants, completed: 0, total: 0 })
    paint()
    return
  }
  preferredVariant.set(url, representationId)
  const previous = dashJobs[statusKey(url)]
  rememberDash(url, {
    phase: 'downloading',
    message: HLS_TEXT.started,
    completed: 0,
    total: 0,
    warning: previous?.warning,
  })
  paint()
  const message: DashDownloadMessage = { type: MESSAGE_TYPE.DASH_DOWNLOAD, url, representationId }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response = readHlsUserResponse(await chrome.runtime.sendMessage(message))
    if (!response || response.ok === false) {
      rememberDash(url, {
        phase: 'failed',
        message: response && response.ok === false ? response.error : HLS_TEXT.offscreen,
        completed: 0,
        total: 0,
      })
      paint()
    }
  } catch {
    rememberDash(url, { phase: 'failed', message: HLS_TEXT.offscreen, completed: 0, total: 0 })
    paint()
  }
}

async function cancelDashDownload(url: string): Promise<void> {
  rememberDash(url, { phase: 'cancelled', message: HLS_TEXT.cancelled, completed: 0, total: 0 })
  paint()
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.DASH_CANCEL, url })
  } catch {
    rememberDash(url, { phase: 'failed', message: '取消失败，请再试一次', completed: 0, total: 0 })
    paint()
  }
}

function rememberBilibili(url: string, record: Omit<HlsJobRecord, 'updatedAt'>): void {
  bilibiliJobs = {
    ...bilibiliJobs,
    [statusKey(url)]: { ...record, updatedAt: Date.now() },
  }
}

async function requestBilibiliDownload(url: string, withAudio: boolean): Promise<void> {
  rememberBilibili(url, { phase: 'downloading', message: BILIBILI_TEXT.preparing, completed: 0, total: 0 })
  paint()
  const message: BilibiliDownloadMessage = { type: MESSAGE_TYPE.BILIBILI_DOWNLOAD, url, withAudio }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response = readHlsUserResponse(await chrome.runtime.sendMessage(message))
    if (!response || response.ok === false) {
      rememberBilibili(url, {
        phase: 'failed',
        message: response && response.ok === false ? response.error : HLS_TEXT.offscreen,
        completed: 0,
        total: 0,
      })
      paint()
    }
  } catch {
    rememberBilibili(url, { phase: 'failed', message: HLS_TEXT.offscreen, completed: 0, total: 0 })
    paint()
  }
}

async function cancelBilibiliDownload(url: string): Promise<void> {
  rememberBilibili(url, { phase: 'cancelled', message: HLS_TEXT.cancelled, completed: 0, total: 0 })
  paint()
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.BILIBILI_CANCEL, url })
  } catch {
    rememberBilibili(url, { phase: 'failed', message: '取消失败，请再试一次', completed: 0, total: 0 })
    paint()
  }
}

async function cancelHlsDownload(url: string): Promise<void> {
  rememberJob(url, { phase: 'cancelled', message: HLS_TEXT.cancelled, completed: 0, total: 0 })
  paint()
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.HLS_CANCEL, url })
  } catch {
    rememberJob(url, { phase: 'failed', message: '取消失败，请再试一次', completed: 0, total: 0 })
    paint()
  }
}

async function requestDownload(url: string, button: HTMLButtonElement): Promise<void> {
  const message: DownloadMessage = { type: MESSAGE_TYPE.DOWNLOAD, url }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response: unknown = await chrome.runtime.sendMessage(message)
    const status = statusFromDownloadResponse(response)
    rememberLocal(url, status)
    const row = liveDownloadRow(url, button)
    if (row) setRowStatus(row, status)
    const liveButton = row?.querySelector<HTMLButtonElement>('[data-action="download"]') ?? button
    flashButton(liveButton, downloadFeedback(response))
  } catch {
    const status = statusFromDownloadResponse(undefined)
    rememberLocal(url, status)
    const row = liveDownloadRow(url, button)
    if (row) setRowStatus(row, status)
    const liveButton = row?.querySelector<HTMLButtonElement>('[data-action="download"]') ?? button
    flashButton(liveButton, '下载失败')
  }
}

async function clearMedia(): Promise<void> {
  if (tabId === undefined || !(clearButton instanceof HTMLButtonElement)) return
  clearButton.disabled = true
  hideBanner()
  try {
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.CLEAR_MEDIA,
      tabId,
    })
    items = []
    paint()
  } catch {
    showBanner('清空失败，请再试一次。')
    if (clearButton.isConnected) clearButton.disabled = items.length === 0
  }
}

async function load(): Promise<void> {
  if (countEl instanceof HTMLElement) countEl.textContent = '正在读取…'
  if (emptyEl instanceof HTMLElement) emptyEl.hidden = true
  if (listEl instanceof HTMLElement) listEl.hidden = true
  if (clearButton instanceof HTMLButtonElement) clearButton.disabled = true
  hideBanner()

  try {
    tabId = await queryActiveTabId()
  } catch {
    tabId = undefined
  }

  if (tabId === undefined) {
    items = []
    paint()
    showBanner('找不到当前标签页。')
    return
  }

  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.GET_MEDIA,
      tabId,
    })
    if (!isMediaItemList(response)) {
      items = []
      paint()
      showBanner('没能读到媒体列表。')
      return
    }
    items = response
    try {
      await readSession()
    } catch {
      statuses = {}
      jobs = {}
      dashJobs = {}
      bilibiliJobs = {}
    }
    paint()
    void chrome.runtime.sendMessage({ type: MESSAGE_TYPE.HLS_SYNC }).catch(() => undefined)
    void chrome.runtime.sendMessage({ type: MESSAGE_TYPE.DASH_SYNC }).catch(() => undefined)
    void chrome.runtime.sendMessage({ type: MESSAGE_TYPE.BILIBILI_SYNC }).catch(() => undefined)
  } catch {
    items = []
    paint()
    showBanner('读取媒体列表失败。')
  }
}

function start(): void {
  if (!(listEl instanceof HTMLElement)) return
  if (clearButton instanceof HTMLButtonElement) {
    clearButton.addEventListener('click', () => {
      void clearMedia()
    })
  }
  bindListActions(listEl, () => items, {
    onCopy(url, button) {
      void copyUrl(url, button)
    },
    onDownload(url, button) {
      void requestDownload(url, button)
    },
    onHlsDownload(url) {
      void requestHlsDownload(url)
    },
    onHlsStart(url, mediaUrl) {
      void startHlsDownload(url, mediaUrl)
    },
    onHlsCancel(url) {
      void cancelHlsDownload(url)
    },
    onHlsVariant(url, mediaUrl) {
      preferredVariant.set(url, mediaUrl)
    },
    onDashDownload(url) {
      void requestDashDownload(url)
    },
    onDashStart(url, representationId) {
      void startDashDownload(url, representationId)
    },
    onDashCancel(url) {
      void cancelDashDownload(url)
    },
    onDashVariant(url, representationId) {
      preferredVariant.set(url, representationId)
    },
    onBilibiliDownload(url) {
      void requestBilibiliDownload(url, false)
    },
    onBilibiliWithAudio(url) {
      void requestBilibiliDownload(url, true)
    },
    onBilibiliCancel(url) {
      void cancelBilibiliDownload(url)
    },
  })
  chrome.storage.onChanged.addListener(onStorageChanged)
  void load()
}

start()
