/**
 * Popup 入口。
 * 打开时查询当前标签页，向 background 发 GET_MEDIA。
 * 复制把完整链接写入剪贴板。下载发 DOWNLOAD，结果写在条目上。
 * 最近一次状态在 chrome.storage.session，关掉再打开还能看到。
 * 清空发 CLEAR_MEDIA。这里不改嗅探。
 */

import { normalizeUrl } from '../shared/classify'
import {
  DOWNLOAD_STATUS_STORAGE_KEY,
  readDownloadStatusMap,
  type DownloadStatusMap,
  type DownloadStatusRecord,
} from '../shared/download-status'
import { MESSAGE_TYPE, type DownloadMessage } from '../shared/messages'
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
  renderList(listEl, items, statuses)
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

async function readStatuses(): Promise<DownloadStatusMap> {
  const stored = await chrome.storage.session.get(DOWNLOAD_STATUS_STORAGE_KEY)
  return readDownloadStatusMap(stored[DOWNLOAD_STATUS_STORAGE_KEY])
}

function onStorageChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  area: chrome.storage.AreaName,
): void {
  if (area !== 'session' || !(DOWNLOAD_STATUS_STORAGE_KEY in changes)) return
  const next = readDownloadStatusMap(changes[DOWNLOAD_STATUS_STORAGE_KEY]?.newValue)
  if (sameStatuses(statuses, next)) return
  statuses = next
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
      statuses = await readStatuses()
    } catch {
      statuses = {}
    }
    paint()
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
  })
  chrome.storage.onChanged.addListener(onStorageChanged)
  void load()
}

start()
