/**
 * 处理 popup 发来的 DOWNLOAD。
 * 只对 downloadable 为 true 的 http(s) 直链调用 chrome.downloads.download。
 * 不设置 headers，也不使用 declarativeNetRequest，避免伪造 Referer 或其他请求头。
 * 结果写在 chrome.storage.session，popup 关掉再打开仍能看到最近一次状态。
 */

import { getItems } from './store'
import { classify, normalizeUrl } from '../shared/classify'
import {
  DOWNLOAD_FAILED_TEXT,
  DOWNLOAD_FINISHED_TEXT,
  DOWNLOAD_STARTED_TEXT,
  DOWNLOAD_STATUS_STORAGE_KEY,
  describeInterruptReason,
  downloadBlockReason,
  readDownloadStatusMap,
  trimDownloadStatuses,
  type DownloadStatusMap,
  type DownloadStatusRecord,
} from '../shared/download-status'
import { buildDownloadFilename } from '../shared/filename'
import { isDownloadMessage, type DownloadMessage, type DownloadResponse } from '../shared/messages'
import type { MediaItem } from '../shared/types'

/** download() 返回后立刻记下 id，避免 onChanged 比 session 写入更早。 */
const activeIds = new Map<number, string>()

let tail: Promise<unknown> = Promise.resolve()
let listening = false

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task)
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

async function readMap(): Promise<DownloadStatusMap> {
  const data = (await chrome.storage.session.get(DOWNLOAD_STATUS_STORAGE_KEY)) as Record<string, unknown>
  return readDownloadStatusMap(data[DOWNLOAD_STATUS_STORAGE_KEY])
}

async function writeMap(map: DownloadStatusMap): Promise<void> {
  await chrome.storage.session.set({
    [DOWNLOAD_STATUS_STORAGE_KEY]: trimDownloadStatuses(map),
  })
}

function statusKey(url: string): string {
  return normalizeUrl(url) || url.trim()
}

async function remember(url: string, record: DownloadStatusRecord): Promise<void> {
  const key = statusKey(url)
  if (!key) return
  try {
    await enqueue(async () => {
      const map = await readMap()
      const existing = map[key]
      // 完成或失败已经写上时，不要被晚到的「已开始下载」盖掉。
      if (
        existing &&
        record.phase === 'started' &&
        existing.phase !== 'started' &&
        existing.downloadId !== undefined &&
        existing.downloadId === record.downloadId
      ) {
        return
      }
      map[key] = record
      await writeMap(map)
    })
  } catch (error) {
    warn('记录下载状态失败', error)
  }
}

function isTerminal(state: string | undefined, error: string | undefined): boolean {
  return state === 'complete' || state === 'interrupted' || Boolean(error)
}

async function applyDelta(delta: chrome.downloads.DownloadDelta): Promise<void> {
  const state = delta.state?.current
  const error = delta.error?.current
  if (!isTerminal(state, error)) return

  await enqueue(async () => {
    const map = await readMap()
    let key = Object.entries(map).find(([, status]) => status.downloadId === delta.id)?.[0]
    if (!key) key = activeIds.get(delta.id)
    if (!key) return

    const previous = map[key]
    const next: DownloadStatusRecord = {
      phase: state === 'complete' ? 'complete' : 'failed',
      message: state === 'complete' ? DOWNLOAD_FINISHED_TEXT : describeInterruptReason(error),
      updatedAt: Date.now(),
    }
    if (typeof delta.id === 'number') next.downloadId = delta.id
    else if (previous?.downloadId !== undefined) next.downloadId = previous.downloadId

    map[key] = next
    await writeMap(map)
    if (next.phase !== 'started') activeIds.delete(delta.id)
  })
}

function onDownloadChanged(delta: chrome.downloads.DownloadDelta): void {
  void applyDelta(delta).catch((error: unknown) => warn('更新下载状态失败', error))
}

/** service worker 重新起来时，把还停在「已开始下载」的条目对一下浏览器里的真实状态。 */
async function reconcileDownloads(): Promise<void> {
  if (typeof chrome.downloads.search !== 'function') return
  await enqueue(async () => {
    const map = await readMap()
    let changed = false
    for (const [key, status] of Object.entries(map)) {
      if (status.phase !== 'started' || status.downloadId === undefined) continue
      let found: chrome.downloads.DownloadItem[]
      try {
        found = await chrome.downloads.search({ id: status.downloadId })
      } catch (error) {
        warn('查询下载记录失败', error)
        continue
      }
      const item = found[0]
      if (!item) continue
      if (item.state === 'complete') {
        map[key] = {
          ...status,
          phase: 'complete',
          message: DOWNLOAD_FINISHED_TEXT,
          updatedAt: Date.now(),
        }
        changed = true
        continue
      }
      if (item.state === 'interrupted') {
        map[key] = {
          ...status,
          phase: 'failed',
          message: describeInterruptReason(item.error),
          updatedAt: Date.now(),
        }
        changed = true
      }
    }
    if (changed) await writeMap(map)
  })
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    return tabs[0]
  } catch (error) {
    warn('读取当前标签页失败', error)
    return undefined
  }
}

async function pageTitle(tabId: number | undefined): Promise<string | undefined> {
  try {
    if (tabId === undefined) return (await activeTab())?.title
    const tab = await chrome.tabs.get(tabId)
    return tab.title
  } catch (error) {
    warn('读取页面标题失败', error)
    return undefined
  }
}

async function findItem(
  tabId: number | undefined,
  url: string,
): Promise<{ item?: MediaItem; index: number; tabId?: number }> {
  let resolved = tabId
  if (resolved === undefined) {
    const tab = await activeTab()
    if (typeof tab?.id === 'number') resolved = tab.id
  }
  if (resolved === undefined) return { index: -1 }
  const items = await getItems(resolved)
  const normalized = normalizeUrl(url)
  const index = items.findIndex((entry) => entry.url === normalized || entry.url === url.trim())
  return { item: index >= 0 ? items[index] : undefined, index, tabId: resolved }
}

function extensionFor(item: MediaItem | undefined, url: string): string | undefined {
  if (item?.ext) return item.ext
  return classify(url, item?.mime)?.ext
}

async function performDownload(message: DownloadMessage): Promise<DownloadResponse> {
  const found = await findItem(message.tabId, message.url)
  const targetUrl = found.item?.url ?? message.url.trim()
  const reason = downloadBlockReason({
    url: targetUrl,
    kind: found.item?.kind,
    downloadable: found.item?.downloadable,
    note: found.item?.note,
    fromStore: found.item !== undefined,
  })
  if (reason) {
    await remember(targetUrl, {
      phase: 'failed',
      message: reason,
      updatedAt: Date.now(),
    })
    return { ok: false, error: reason }
  }

  const title = await pageTitle(found.tabId)
  const filename = buildDownloadFilename({
    title,
    url: targetUrl,
    ext: extensionFor(found.item, targetUrl),
    index: found.index >= 0 ? found.index + 1 : undefined,
    filename: message.filename,
  })

  // 只传 url / filename / saveAs / conflictAction。不要加 headers。
  const options: chrome.downloads.DownloadOptions = {
    url: targetUrl,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  }

  try {
    const downloadId = await chrome.downloads.download(options)
    // Promise 形式失败会 reject，不要再读 runtime.lastError，避免撞上别的调用留下的错误。
    if (typeof downloadId !== 'number') {
      await remember(targetUrl, {
        phase: 'failed',
        message: DOWNLOAD_FAILED_TEXT,
        updatedAt: Date.now(),
      })
      warn('下载没有开始', downloadId)
      return { ok: false, error: DOWNLOAD_FAILED_TEXT }
    }

    activeIds.set(downloadId, statusKey(targetUrl))
    console.info('[media-grabber] 开始下载', downloadId, filename, targetUrl)
    await remember(targetUrl, {
      phase: 'started',
      message: DOWNLOAD_STARTED_TEXT,
      downloadId,
      updatedAt: Date.now(),
    })
    return { ok: true, downloadId }
  } catch (error) {
    const messageText = describeInterruptReason(error instanceof Error ? error.message : undefined)
    await remember(targetUrl, {
      phase: 'failed',
      message: messageText,
      updatedAt: Date.now(),
    })
    warn('下载没有开始', error)
    return { ok: false, error: messageText }
  }
}

export function handleDownloadMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (!isDownloadMessage(message)) return undefined
  void performDownload(message).then(sendResponse, (error: unknown) => {
    warn('处理下载失败', error)
    sendResponse({ ok: false, error: DOWNLOAD_FAILED_TEXT } satisfies DownloadResponse)
  })
  return true
}

/** 重复调用不会叠两层监听。GET_MEDIA 等仍由 store 处理。 */
export function listenForDownload(): void {
  if (listening) return
  listening = true
  chrome.runtime.onMessage.addListener(handleDownloadMessage)
  chrome.downloads.onChanged.addListener(onDownloadChanged)
  void reconcileDownloads().catch((error: unknown) => warn('同步下载状态失败', error))
}
