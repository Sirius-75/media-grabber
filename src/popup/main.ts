/**
 * Popup 入口。
 * 打开时查询当前标签页，向 background 发 GET_MEDIA。
 * 复制把完整链接写入剪贴板。下载先发 DOWNLOAD，真正保存留给后续任务。
 * 清空发 CLEAR_MEDIA。这里不读写存储，也不改嗅探。
 */

import { MESSAGE_TYPE } from '../shared/messages'
import type { MediaItem } from '../shared/types'
import {
  bindListActions,
  downloadFeedback,
  flashButton,
  isMediaItemList,
  renderList,
} from './view.ts'

const countEl = document.querySelector('#count')
const bannerEl = document.querySelector('#banner')
const emptyEl = document.querySelector('#empty')
const listEl = document.querySelector('#list')
const clearButton = document.querySelector('#clear')

let tabId: number | undefined
let items: MediaItem[] = []

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
  renderList(listEl, items)
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

async function requestDownload(url: string, button: HTMLButtonElement): Promise<void> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.DOWNLOAD,
      url,
    })
    flashButton(button, downloadFeedback(response))
  } catch {
    flashButton(button, '即将支持')
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
  void load()
}

start()
