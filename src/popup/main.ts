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
  DOWNLOAD_RETRY_STORAGE_KEY,
  readDownloadRetryMap,
  type DownloadRetryMap,
  type DownloadRetryPlan,
} from '../shared/download-retry'
import {
  JOB_QUEUE_STORAGE_KEY,
  emptyQueue,
  queuePosition,
  queuedStatusText,
  readDownloadQueue,
  type DownloadQueueState,
} from '../shared/download-queue'
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
  type HlsLiveInspectMessage,
  type HlsLiveStartMessage,
  type SubtitleDownloadMessage,
} from '../shared/messages'
import { PREFERENCES_STORAGE_KEY, readPreferences } from '../shared/preferences'
import { shouldShowAutomaticSubtitleError, type SubtitleTrackView } from '../shared/subtitles'
import type { MediaItem } from '../shared/types'
import {
  bindListActions,
  downloadFeedback,
  flashButton,
  isMediaItemList,
  pageTitleText,
  renderList,
  setRowStatus,
  subtitleFormatKey,
  statusFromDownloadResponse,
  type ShownSubtitles,
} from './view.ts'

const countEl = document.querySelector('#count')
const bannerEl = document.querySelector('#banner')
const emptyEl = document.querySelector('#empty')
const listEl = document.querySelector('#list')
const clearButton = document.querySelector('#clear')

let tabId: number | undefined
let pageTitle = ''
let items: MediaItem[] = []
let statuses: DownloadStatusMap = {}
let jobs: HlsJobMap = {}
let dashJobs: HlsJobMap = {}
let bilibiliJobs: HlsJobMap = {}
let queue: DownloadQueueState = emptyQueue()
let retries: DownloadRetryMap = {}
/** 用户在清晰度列表里点过的地址。DASH 里存的是 Representation id。重画时不要跳回默认项。 */
const preferredVariant = new Map<string, string>()
/** 每条字幕选过的 .vtt / .srt。进度更新会重画列表，不能把选择刷回默认的 .vtt。 */
const preferredSubtitleFormat = new Map<string, 'vtt' | 'srt'>()
const subtitleState = new Map<string, ShownSubtitles>()
const subtitleRequested = new Set<string>()
const SUBTITLE_INSPECT_CACHE_KEY = 'media-grabber-subtitle-inspect'

interface SubtitleInspectCacheEntry {
  tracks: SubtitleTrackView[]
  error?: string
}

function wantsSeparate(): boolean {
  const box = document.querySelector('#separate-media')
  return box instanceof HTMLInputElement && box.checked
}

/** 勾上才把点击时窗口里已有的分片录进去。默认不勾，从直播边缘开始。 */
function wantsExistingLive(): boolean {
  const box = document.querySelector('#include-existing-live')
  return box instanceof HTMLInputElement && box.checked
}

async function loadPreferences(): Promise<void> {
  const box = document.querySelector('#include-existing-live')
  if (!(box instanceof HTMLInputElement)) return
  try {
    const stored = await chrome.storage.local.get(PREFERENCES_STORAGE_KEY)
    box.checked = readPreferences(stored[PREFERENCES_STORAGE_KEY]).includeExistingLiveSegments
  } catch {
    box.checked = false
  }
}

function persistPreferences(): void {
  const box = document.querySelector('#include-existing-live')
  if (!(box instanceof HTMLInputElement)) return
  void chrome.storage.local
    .set({ [PREFERENCES_STORAGE_KEY]: { includeExistingLiveSegments: box.checked } })
    .catch(() => undefined)
}

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
  paintPageTitle()
  renderList(
    listEl,
    items,
    statuses,
    jobs,
    preferredVariant,
    dashJobs,
    bilibiliJobs,
    queue,
    subtitleState,
    preferredSubtitleFormat,
  )
  const isEmpty = items.length === 0
  emptyEl.hidden = !isEmpty
  listEl.hidden = isEmpty
}

function paintPageTitle(): void {
  const el = document.querySelector('#page-title')
  if (!(el instanceof HTMLElement)) return
  el.hidden = pageTitle === ''
  el.textContent = pageTitle
  if (pageTitle) el.title = pageTitle
  else el.removeAttribute('title')
}

interface ActiveTabInfo {
  id: number
  title?: string
  url?: string
}

async function queryActiveTab(): Promise<ActiveTabInfo | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  const id = tab?.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return undefined
  const info: ActiveTabInfo = { id }
  if (typeof tab?.title === 'string') info.title = tab.title
  if (typeof tab?.url === 'string') info.url = tab.url
  return info
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

/** 记下这一次的启动参数，失败后「重试」用同一份。参数不含媒体内容，只放会话存储。 */
function rememberRetry(url: string, plan: DownloadRetryPlan): void {
  retries = { ...retries, [statusKey(url)]: plan }
  void persistRetries()
}

async function persistRetries(): Promise<void> {
  try {
    await chrome.storage.session.set({ [DOWNLOAD_RETRY_STORAGE_KEY]: retries })
  } catch {
    // 会话存储写失败时，本次弹窗仍能用内存里的参数重试。
  }
}

/** 这条地址是否还在队列里等。返回从 1 开始的位置。 */
function waitingPosition(url: string): number | undefined {
  const key = statusKey(url)
  const job = queue.waiting.find((entry) => entry.key === url || entry.key === key)
  return job ? queuePosition(queue, job.id) : undefined
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
    DOWNLOAD_RETRY_STORAGE_KEY,
    HLS_JOB_STORAGE_KEY,
    DASH_JOB_STORAGE_KEY,
    BILIBILI_JOB_STORAGE_KEY,
    JOB_QUEUE_STORAGE_KEY,
  ])
  statuses = readDownloadStatusMap(stored[DOWNLOAD_STATUS_STORAGE_KEY])
  retries = readDownloadRetryMap(stored[DOWNLOAD_RETRY_STORAGE_KEY])
  jobs = readHlsJobMap(stored[HLS_JOB_STORAGE_KEY])
  dashJobs = readDashJobMap(stored[DASH_JOB_STORAGE_KEY])
  bilibiliJobs = readHlsJobMap(stored[BILIBILI_JOB_STORAGE_KEY])
  queue = readDownloadQueue(stored[JOB_QUEUE_STORAGE_KEY])
}

function rememberJob(url: string, record: Omit<HlsJobRecord, 'updatedAt'>): void {
  jobs = {
    ...jobs,
    [statusKey(url)]: { ...record, updatedAt: Date.now() },
  }
}

function sameQueue(left: DownloadQueueState, right: DownloadQueueState): boolean {
  if (left.running.length !== right.running.length || left.waiting.length !== right.waiting.length) return false
  const same = (a: readonly { id: string }[], b: readonly { id: string }[]): boolean =>
    a.every((job, index) => job.id === b[index]?.id)
  return same(left.running, right.running) && same(left.waiting, right.waiting)
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
    if (a.hasVideo !== b.hasVideo || a.hasAudio !== b.hasAudio || a.audioOnly !== b.audioOnly) return false
    if (a.live !== b.live) return false
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
  let nextQueue = queue
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
  if (JOB_QUEUE_STORAGE_KEY in changes) {
    const parsed = readDownloadQueue(changes[JOB_QUEUE_STORAGE_KEY]?.newValue)
    if (!sameQueue(queue, parsed)) {
      nextQueue = parsed
      changed = true
    }
  }
  if (!changed) return
  statuses = nextStatuses
  jobs = nextJobs
  dashJobs = nextDash
  bilibiliJobs = nextBilibili
  queue = nextQueue
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
  if (index < 0) return undefined
  const row = listEl.querySelector(`.item[data-index="${index}"]`)
  return row instanceof HTMLElement ? row : undefined
}

async function requestHlsDownload(url: string): Promise<void> {
  rememberRetry(url, { kind: 'hls', mode: 'inspect' })
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
    if ('kind' in response && response.kind === 'live') {
      rememberRetry(url, { kind: 'hls', mode: 'live', mediaUrl: url })
      rememberJob(url, {
        phase: 'picking',
        message: HLS_TEXT.liveHint,
        completed: 0,
        total: 0,
        live: true,
        warning: response.warning,
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
      // 后台可能已经把这条放进队列，storage 里才是真正的排队位置。
      await readSession()
      const position = waitingPosition(url)
      rememberJob(url, {
        phase: position === undefined ? 'downloading' : 'queued',
        message: position === undefined ? HLS_TEXT.started : queuedStatusText(position),
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
  rememberRetry(url, { kind: 'hls', mode: 'download', mediaUrl })
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

async function requestHlsLive(url: string): Promise<void> {
  rememberRetry(url, { kind: 'hls', mode: 'live', mediaUrl: url })
  rememberJob(url, {
    phase: 'inspecting',
    message: HLS_TEXT.inspecting,
    completed: 0,
    total: 0,
    live: true,
  })
  paint()
  const message: HlsLiveInspectMessage = { type: MESSAGE_TYPE.HLS_LIVE_INSPECT, url }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response = readHlsUserResponse(await chrome.runtime.sendMessage(message))
    if (!response || response.ok === false) {
      rememberJob(url, {
        phase: 'failed',
        message: response && response.ok === false ? response.error : '读取清单失败',
        completed: 0,
        total: 0,
        live: true,
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
        live: true,
      })
      paint()
      return
    }
    if ('kind' in response && response.kind === 'live') {
      await startHlsLive(url, url, response.warning)
      return
    }
    rememberJob(url, {
      phase: 'failed',
      message: HLS_TEXT.liveNotLive,
      completed: 0,
      total: 0,
      live: true,
    })
    paint()
  } catch {
    rememberJob(url, {
      phase: 'failed',
      message: '读取清单失败',
      completed: 0,
      total: 0,
      live: true,
    })
    paint()
  }
}

async function startHlsLive(url: string, mediaUrl: string, warning?: string): Promise<void> {
  if (!mediaUrl) {
    rememberJob(url, {
      phase: 'failed',
      message: HLS_TEXT.noVariants,
      completed: 0,
      total: 0,
      live: true,
    })
    paint()
    return
  }
  rememberRetry(url, { kind: 'hls', mode: 'live', mediaUrl })
  preferredVariant.set(url, mediaUrl)
  rememberJob(url, {
    phase: 'recording',
    message: HLS_TEXT.liveStarting,
    completed: 0,
    total: 0,
    live: true,
    warning,
  })
  paint()
  const message: HlsLiveStartMessage = { type: MESSAGE_TYPE.HLS_LIVE_START, url, mediaUrl }
  if (wantsExistingLive()) message.includeExisting = true
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response = readHlsUserResponse(await chrome.runtime.sendMessage(message))
    if (!response || response.ok === false) {
      rememberJob(url, {
        phase: 'failed',
        message: response && response.ok === false ? response.error : HLS_TEXT.offscreen,
        completed: 0,
        total: 0,
        live: true,
        warning,
      })
      paint()
      return
    }
    // 后台可能把这条排进队列，storage 里才是真正的状态。
    await readSession()
    const position = waitingPosition(url)
    if (position !== undefined) {
      rememberJob(url, {
        phase: 'queued',
        message: queuedStatusText(position),
        completed: 0,
        total: 0,
        live: true,
        warning,
      })
      paint()
    }
  } catch {
    rememberJob(url, {
      phase: 'failed',
      message: HLS_TEXT.offscreen,
      completed: 0,
      total: 0,
      live: true,
      warning,
    })
    paint()
  }
}

async function stopHlsLive(url: string): Promise<void> {
  const previous = jobs[statusKey(url)]
  rememberJob(url, {
    phase: 'remuxing',
    message: HLS_TEXT.liveStopAndSave,
    completed: previous?.completed ?? 0,
    total: previous?.total ?? 0,
    live: true,
    warning: previous?.warning,
    recordedMs: previous?.recordedMs,
    recordedBytes: previous?.recordedBytes,
  })
  paint()
  try {
    const response = readHlsUserResponse(
      await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.HLS_LIVE_STOP, url }),
    )
    if (response && response.ok === false) {
      rememberJob(url, {
        phase: 'failed',
        message: response.error,
        completed: 0,
        total: 0,
        live: true,
      })
      paint()
    }
  } catch {
    rememberJob(url, {
      phase: 'failed',
      message: '停止录制失败，请再试一次',
      completed: 0,
      total: 0,
      live: true,
    })
    paint()
  }
}

async function cancelHlsLive(url: string): Promise<void> {
  rememberJob(url, { phase: 'cancelled', message: HLS_TEXT.cancelled, completed: 0, total: 0, live: true })
  paint()
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.HLS_LIVE_CANCEL, url })
  } catch {
    rememberJob(url, {
      phase: 'failed',
      message: '取消失败，请再试一次',
      completed: 0,
      total: 0,
      live: true,
    })
    paint()
  }
}

function rememberDash(url: string, record: Omit<HlsJobRecord, 'updatedAt'>): void {
  dashJobs = {
    ...dashJobs,
    [statusKey(url)]: { ...record, updatedAt: Date.now() },
  }
}

async function requestDashDownload(url: string, audioOnly: boolean): Promise<void> {
  const separate = audioOnly ? false : wantsSeparate()
  rememberRetry(url, { kind: 'dash', mode: 'inspect', audioOnly, separate })
  const previous = dashJobs[statusKey(url)]
  rememberDash(url, {
    phase: 'inspecting',
    message: HLS_TEXT.inspecting,
    completed: 0,
    total: 0,
    audioOnly,
    hasVideo: previous?.hasVideo,
    hasAudio: previous?.hasAudio,
  })
  paint()
  const message: DashInspectMessage = {
    type: MESSAGE_TYPE.DASH_INSPECT,
    url,
    separate,
    audioOnly,
  }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response = readHlsUserResponse(await chrome.runtime.sendMessage(message))
    if (!response || response.ok === false) {
      rememberDash(url, {
        phase: 'failed',
        message: response && response.ok === false ? response.error : '读取清单失败',
        completed: 0,
        total: 0,
        audioOnly,
        hasVideo: response && response.ok === false ? response.hasVideo : previous?.hasVideo,
        hasAudio: response && response.ok === false ? response.hasAudio : previous?.hasAudio,
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
        audioOnly,
        hasVideo: response.hasVideo ?? previous?.hasVideo,
        hasAudio: response.hasAudio ?? previous?.hasAudio,
      })
      paint()
      return
    }
    if ('kind' in response && response.kind === 'media') {
      await readSession()
      const position = waitingPosition(url)
      rememberDash(url, {
        phase: position === undefined ? 'downloading' : 'queued',
        message: position === undefined ? HLS_TEXT.started : queuedStatusText(position),
        completed: 0,
        total: response.total,
        warning: response.warning,
        audioOnly,
        hasVideo: response.hasVideo ?? previous?.hasVideo,
        hasAudio: response.hasAudio ?? previous?.hasAudio,
      })
      paint()
      return
    }
    if (response.ok === true) {
      await readSession()
      const position = waitingPosition(url)
      rememberDash(url, {
        phase: position === undefined ? 'downloading' : 'queued',
        message: position === undefined ? HLS_TEXT.started : queuedStatusText(position),
        completed: 0,
        total: 0,
        audioOnly,
        hasVideo: previous?.hasVideo,
        hasAudio: previous?.hasAudio,
      })
      paint()
      return
    }
    rememberDash(url, {
      phase: 'failed',
      message: '读取清单失败',
      completed: 0,
      total: 0,
      audioOnly,
      hasVideo: previous?.hasVideo,
      hasAudio: previous?.hasAudio,
    })
    paint()
  } catch {
    rememberDash(url, {
      phase: 'failed',
      message: '读取清单失败',
      completed: 0,
      total: 0,
      audioOnly,
      hasVideo: previous?.hasVideo,
      hasAudio: previous?.hasAudio,
    })
    paint()
  }
}

async function startDashDownload(
  url: string,
  representationId: string,
  retryAudioOnly?: boolean,
  retrySeparate?: boolean,
): Promise<void> {
  if (!representationId) {
    const previous = dashJobs[statusKey(url)]
    rememberDash(url, {
      phase: 'failed',
      message: HLS_TEXT.noVariants,
      completed: 0,
      total: 0,
      audioOnly: previous?.audioOnly,
      hasVideo: previous?.hasVideo,
      hasAudio: previous?.hasAudio,
    })
    paint()
    return
  }
  preferredVariant.set(url, representationId)
  const previous = dashJobs[statusKey(url)]
  const audioOnly = retryAudioOnly ?? previous?.audioOnly === true
  const separate = audioOnly ? false : (retrySeparate ?? wantsSeparate())
  rememberRetry(url, { kind: 'dash', mode: 'download', representationId, audioOnly, separate })
  rememberDash(url, {
    phase: 'downloading',
    message: HLS_TEXT.started,
    completed: 0,
    total: 0,
    warning: previous?.warning,
    audioOnly,
    hasVideo: previous?.hasVideo,
    hasAudio: previous?.hasAudio,
  })
  paint()
  const message: DashDownloadMessage = {
    type: MESSAGE_TYPE.DASH_DOWNLOAD,
    url,
    representationId,
    separate,
    audioOnly,
  }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response = readHlsUserResponse(await chrome.runtime.sendMessage(message))
    if (!response || response.ok === false) {
      rememberDash(url, {
        phase: 'failed',
        message: response && response.ok === false ? response.error : HLS_TEXT.offscreen,
        completed: 0,
        total: 0,
        audioOnly,
        hasVideo: previous?.hasVideo,
        hasAudio: previous?.hasAudio,
      })
      paint()
    }
  } catch {
    rememberDash(url, {
      phase: 'failed',
      message: HLS_TEXT.offscreen,
      completed: 0,
      total: 0,
      audioOnly,
      hasVideo: previous?.hasVideo,
      hasAudio: previous?.hasAudio,
    })
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

async function requestBilibiliDownload(
  url: string,
  mode: 'with-audio' | 'audio-only' | 'video-only',
  retrySeparate?: boolean,
): Promise<void> {
  const separate = mode === 'with-audio' ? (retrySeparate ?? wantsSeparate()) : false
  rememberRetry(url, { kind: 'bilibili', mode, separate })
  rememberBilibili(url, { phase: 'downloading', message: BILIBILI_TEXT.preparing, completed: 0, total: 0 })
  paint()
  const message: BilibiliDownloadMessage = { type: MESSAGE_TYPE.BILIBILI_DOWNLOAD, url }
  if (mode === 'with-audio') {
    message.withAudio = true
    message.separate = separate
  } else if (mode === 'audio-only') {
    message.audioOnly = true
  }
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
    if (row) {
      setRowStatus(row, status)
      if (status.phase !== 'failed') row.querySelector('[data-action="retry"]')?.remove()
    }
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

async function retryDownload(url: string, button: HTMLButtonElement): Promise<void> {
  const plan = retries[statusKey(url)]
  if (plan?.kind === 'hls') {
    if (plan.mode === 'download' && plan.mediaUrl) await startHlsDownload(url, plan.mediaUrl)
    else if (plan.mode === 'live' && plan.mediaUrl) await startHlsLive(url, plan.mediaUrl)
    else await requestHlsDownload(url)
    return
  }
  if (plan?.kind === 'dash') {
    if (plan.mode === 'download' && plan.representationId) {
      await startDashDownload(url, plan.representationId, plan.audioOnly, plan.separate)
    } else {
      await requestDashDownload(url, plan.audioOnly)
    }
    return
  }
  if (plan?.kind === 'bilibili') {
    await requestBilibiliDownload(url, plan.mode, plan.separate)
    return
  }

  // 旧会话里没有保留参数时，按条目类型退回原来的入口，至少能重新发起。
  const key = statusKey(url)
  const item = items.find((entry) => entry.url === url || statusKey(entry.url) === key)
  if (item?.kind === 'hls') {
    await requestHlsDownload(url)
    return
  }
  if (item?.kind === 'dash') {
    await requestDashDownload(url, false)
    return
  }
  if (item?.bilibili) {
    const hasAudio = items.some((entry) => entry.bilibili?.role === 'audio')
    if (item.bilibili.role === 'audio') await requestBilibiliDownload(url, 'audio-only')
    else if (hasAudio) await requestBilibiliDownload(url, 'with-audio')
    else await requestBilibiliDownload(url, 'video-only')
    return
  }
  await requestDownload(url, button)
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

function isSubtitleTrack(value: unknown): value is SubtitleTrackView {
  if (typeof value !== 'object' || value === null) return false
  const track = value as SubtitleTrackView
  if (typeof track.id !== 'string' || track.id.trim() === '') return false
  if (typeof track.label !== 'string' || track.label.trim() === '') return false
  if (track.format !== 'vtt' && track.format !== 'ttml' && track.format !== 'unsupported') return false
  return true
}

function readSubtitleInspectCache(value: unknown): Record<string, SubtitleInspectCacheEntry> {
  if (typeof value !== 'object' || value === null) return {}
  const cache: Record<string, SubtitleInspectCacheEntry> = {}
  for (const [url, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const tracks = 'tracks' in entry && Array.isArray(entry.tracks) ? entry.tracks.filter(isSubtitleTrack) : []
    const error = 'error' in entry && typeof entry.error === 'string' ? entry.error.trim() : ''
    const stored: SubtitleInspectCacheEntry = { tracks }
    if (error) stored.error = error
    cache[url] = stored
  }
  return cache
}

function applySubtitleInspect(url: string, entry: SubtitleInspectCacheEntry): void {
  if (entry.error && shouldShowAutomaticSubtitleError(entry.error)) {
    subtitleState.set(url, { tracks: [], error: entry.error })
    return
  }
  if (entry.tracks.length > 0) subtitleState.set(url, { tracks: entry.tracks })
}

async function loadSubtitleInspectCache(): Promise<Record<string, SubtitleInspectCacheEntry>> {
  try {
    const stored = await chrome.storage.session.get(SUBTITLE_INSPECT_CACHE_KEY)
    return readSubtitleInspectCache(stored[SUBTITLE_INSPECT_CACHE_KEY])
  } catch {
    return {}
  }
}

async function rememberSubtitleInspect(url: string, entry: SubtitleInspectCacheEntry): Promise<void> {
  try {
    const cache = await loadSubtitleInspectCache()
    cache[url] = entry
    await chrome.storage.session.set({ [SUBTITLE_INSPECT_CACHE_KEY]: cache })
  } catch {
    // 记不住时，这次弹窗里的 subtitleRequested 仍然避免重复请求。
  }
}

async function refreshSubtitles(): Promise<void> {
  const cache = await loadSubtitleInspectCache()
  const targets = items.filter((item) => {
    if (item.kind !== 'hls' && item.kind !== 'dash') return false
    return item.url.startsWith('http://') || item.url.startsWith('https://')
  })
  let painted = false
  for (const item of targets) {
    const cached = cache[item.url]
    if (!cached) continue
    subtitleRequested.add(item.url)
    applySubtitleInspect(item.url, cached)
    painted = true
  }
  if (painted) paint()
  await Promise.all(
    targets.map(async (item) => {
      if (subtitleRequested.has(item.url)) return
      subtitleRequested.add(item.url)
      try {
        const response: unknown = await chrome.runtime.sendMessage({
          type: MESSAGE_TYPE.SUBTITLE_INSPECT,
          url: item.url,
        })
        if (typeof response !== 'object' || response === null || !('ok' in response)) return
        if (response.ok === false && 'error' in response && typeof response.error === 'string' && response.error.trim()) {
          const error = response.error.trim()
          const entry: SubtitleInspectCacheEntry = { tracks: [] }
          if (shouldShowAutomaticSubtitleError(error)) {
            entry.error = error
            subtitleState.set(item.url, { tracks: [], error })
            paint()
          }
          await rememberSubtitleInspect(item.url, entry)
          return
        }
        if (response.ok !== true || !('tracks' in response) || !Array.isArray(response.tracks)) return
        const tracks = response.tracks.filter(isSubtitleTrack)
        await rememberSubtitleInspect(item.url, { tracks })
        if (tracks.length === 0) return
        subtitleState.set(item.url, { tracks })
        paint()
      } catch {
        // 读不到字幕时不挡住音视频列表。
      }
    }),
  )
}

async function requestSubtitle(url: string, trackId: string, format: 'vtt' | 'srt'): Promise<void> {
  const current = subtitleState.get(url) ?? { tracks: [] }
  subtitleState.set(url, { ...current, pendingId: trackId, message: '正在下载字幕…' })
  paint()
  const message: SubtitleDownloadMessage = {
    type: MESSAGE_TYPE.SUBTITLE_DOWNLOAD,
    url,
    trackId,
    format,
  }
  if (tabId !== undefined) message.tabId = tabId
  try {
    const response: unknown = await chrome.runtime.sendMessage(message)
    const failed =
      typeof response === 'object' &&
      response !== null &&
      'ok' in response &&
      response.ok === false &&
      'error' in response &&
      typeof response.error === 'string'
        ? response.error
        : undefined
    const ok = typeof response === 'object' && response !== null && 'ok' in response && response.ok === true
    subtitleState.set(url, {
      tracks: current.tracks,
      message: ok ? `字幕已开始下载（.${format}）` : failed || '字幕下载失败',
    })
  } catch {
    subtitleState.set(url, { tracks: current.tracks, message: '字幕下载失败' })
  }
  paint()
}

async function load(): Promise<void> {
  if (countEl instanceof HTMLElement) countEl.textContent = '正在读取…'
  if (emptyEl instanceof HTMLElement) emptyEl.hidden = true
  if (listEl instanceof HTMLElement) listEl.hidden = true
  if (clearButton instanceof HTMLButtonElement) clearButton.disabled = true
  hideBanner()

  try {
    const tab = await queryActiveTab()
    tabId = tab?.id
    pageTitle = tab ? pageTitleText(tab) : ''
  } catch {
    tabId = undefined
    pageTitle = ''
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
      queue = emptyQueue()
      retries = {}
    }
    paint()
    void refreshSubtitles()
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
  const includeExisting = document.querySelector('#include-existing-live')
  if (includeExisting instanceof HTMLInputElement) {
    includeExisting.addEventListener('change', () => {
      persistPreferences()
    })
  }
  void loadPreferences()
  bindListActions(listEl, () => items, {
    onCopy(url, button) {
      void copyUrl(url, button)
    },
    onDownload(url, button) {
      void requestDownload(url, button)
    },
    onRetry(url, button) {
      void retryDownload(url, button)
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
    onHlsLive(url) {
      void requestHlsLive(url)
    },
    onHlsLiveStart(url, mediaUrl) {
      void startHlsLive(url, mediaUrl)
    },
    onHlsLiveStop(url) {
      void stopHlsLive(url)
    },
    onHlsLiveCancel(url) {
      void cancelHlsLive(url)
    },
    onSubtitleDownload(url, trackId, format) {
      void requestSubtitle(url, trackId, format)
    },
    onDashDownload(url) {
      void requestDashDownload(url, false)
    },
    onDashAudio(url) {
      void requestDashDownload(url, true)
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
    onSubtitleFormat(url, trackId, format) {
      preferredSubtitleFormat.set(subtitleFormatKey(url, trackId), format)
    },
    onBilibiliDownload(url) {
      void requestBilibiliDownload(url, 'video-only')
    },
    onBilibiliWithAudio(url) {
      void requestBilibiliDownload(url, 'with-audio')
    },
    onBilibiliAudio(url) {
      void requestBilibiliDownload(url, 'audio-only')
    },
    onBilibiliCancel(url) {
      void cancelBilibiliDownload(url)
    },
  })
  chrome.storage.onChanged.addListener(onStorageChanged)
  void load()
}

start()
