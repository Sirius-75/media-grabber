/**
 * service worker 里的下载队列。
 * 所有会经 offscreen 的下载（HLS / DASH / B 站）先在这里排队，最多同时跑两个。
 * 队列状态放在 chrome.storage.session，offscreen 仍然只使用 chrome.runtime。
 * 普通 chrome.downloads 直链不经过这里。
 */

import {
  JOB_QUEUE_STORAGE_KEY,
  MAX_CONCURRENT_JOBS,
  MAX_WAITING_JOBS,
  QUEUE_EXPIRED_TEXT,
  QUEUE_FULL_TEXT,
  QUEUE_INTERRUPTED_TEXT,
  dedupeQueue,
  enqueueJob,
  expireWaiting,
  finishRunning,
  finishRunningByKey,
  queuedStatusText,
  readDownloadQueue,
  reconcileRunning,
  removeWaiting,
  takeStartable,
  type BilibiliQueueJob,
  type DashQueueJob,
  type DownloadQueueState,
  type HlsQueueJob,
  type QueueJob,
  type QueueJobKind,
} from '../shared/download-queue'
import { BILIBILI_JOB_STORAGE_KEY, BILIBILI_OFFSCREEN, BILIBILI_TEXT } from '../shared/bilibili'
import { DASH_JOB_STORAGE_KEY } from '../shared/dash-job'
import { HLS_TEXT } from '../shared/hls'
import { HLS_JOB_STORAGE_KEY, readHlsJobMap, type HlsJobMap, type HlsJobRecord } from '../shared/hls-job'
import { readOffscreenActiveKeys } from '../shared/offscreen-bridge'
import { finishBilibiliDownload, runBilibiliWithReferer, waitForBilibiliDownload } from './bilibili-rules'
import { downloadContext, offscreenExists, sendOffscreen } from './offscreen-doc'
import { updateStoredJob } from './offscreen-jobs'

type Result = { ok: true } | { ok: false; error: string }

const HLS_ACTIVE = new Set(['downloading', 'inspecting', 'recording', 'remuxing'])
const DASH_ACTIVE = new Set(['downloading', 'inspecting', 'merging'])
const BILIBILI_ACTIVE = new Set(['downloading', 'merging'])

let tail: Promise<unknown> = Promise.resolve()
let listening = false
let initialized = false

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task)
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFailure(value: unknown): value is { ok: false; error: string } {
  return isRecord(value) && value.ok === false && typeof value.error === 'string'
}

function storageKeyOf(kind: QueueJobKind): string {
  if (kind === 'dash') return DASH_JOB_STORAGE_KEY
  if (kind === 'bilibili') return BILIBILI_JOB_STORAGE_KEY
  return HLS_JOB_STORAGE_KEY
}

function activePhasesOf(kind: QueueJobKind): ReadonlySet<string> {
  if (kind === 'dash') return DASH_ACTIVE
  if (kind === 'bilibili') return BILIBILI_ACTIVE
  return HLS_ACTIVE
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // 老环境没有 randomUUID，下面用时间戳和随机数。
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function readState(): Promise<DownloadQueueState> {
  const stored = (await chrome.storage.session.get(JOB_QUEUE_STORAGE_KEY)) as Record<string, unknown>
  return dedupeQueue(readDownloadQueue(stored[JOB_QUEUE_STORAGE_KEY]))
}

async function saveState(state: DownloadQueueState): Promise<void> {
  await chrome.storage.session.set({ [JOB_QUEUE_STORAGE_KEY]: state })
}

/** 队列只改 still queued 的记录，避免和 offscreen 刚写下的进度互相覆盖。 */
function setQueuedStatus(job: QueueJob, message: string, force = false): Promise<void> {
  return updateStoredJob(storageKeyOf(job.kind), job.key, (current) => {
    if (!force && current && current.phase !== 'queued') return current
    const record: HlsJobRecord = {
      ...(current ?? {}),
      phase: 'queued',
      message,
      completed: 0,
      total: 0,
      updatedAt: Date.now(),
    }
    if (job.kind === 'hls' && job.live === true) record.live = true
    return record
  })
}

/** 离开排队、真正开始时先换掉「排队中」，等 offscreen 写第一条进度。 */
function setStartingStatus(job: QueueJob): Promise<void> {
  return updateStoredJob(storageKeyOf(job.kind), job.key, (current) => {
    if (!current) return current
    if (current.phase !== 'queued') return current
    const live = job.kind === 'hls' && job.live === true
    const next: HlsJobRecord = {
      ...current,
      phase: live ? 'recording' : 'downloading',
      message: job.kind === 'bilibili' ? BILIBILI_TEXT.preparing : live ? HLS_TEXT.liveStarting : HLS_TEXT.started,
      updatedAt: Date.now(),
    }
    if (live) next.live = true
    return next
  })
}

function setJobFailedIfPending(job: QueueJob, message: string): Promise<void> {
  return updateStoredJob(storageKeyOf(job.kind), job.key, (current) => {
    if (current && (activePhasesOf(job.kind).has(current.phase) || current.phase === 'queued')) {
      return { ...current, phase: 'failed', message, updatedAt: Date.now() }
    }
    if (current) return current
    return {
      phase: 'failed',
      message,
      completed: 0,
      total: 0,
      updatedAt: Date.now(),
    }
  })
}

function setJobCancelledIfQueued(job: QueueJob): Promise<void> {
  return updateStoredJob(storageKeyOf(job.kind), job.key, (current) => {
    if (!current || current.phase !== 'queued') return current
    return { ...current, phase: 'cancelled', message: HLS_TEXT.cancelled, updatedAt: Date.now() }
  })
}

/** 队列位置变了之后，把仍然排队的条目说明改成新的「第 N 位」。 */
async function refreshQueuedPositions(state: DownloadQueueState): Promise<void> {
  for (let index = 0; index < state.waiting.length; index += 1) {
    const job = state.waiting[index]
    if (!job) continue
    try {
      await setQueuedStatus(job, queuedStatusText(index + 1))
    } catch (error) {
      warn('更新排队位置失败', error)
    }
  }
}

function sameKey(job: QueueJob, kind: QueueJobKind, key: string): boolean {
  return job.kind === kind && job.key === key
}

async function failDispatch(job: QueueJob, message: string): Promise<void> {
  await setJobFailedIfPending(job, message)
  await finishQueueJob(job.id)
}

async function dispatchHls(job: HlsQueueJob): Promise<void> {
  const message: Record<string, unknown> = {
    type: job.live === true ? 'HLS_OFFSCREEN_LIVE_START' : 'HLS_OFFSCREEN_DOWNLOAD',
    playlistUrl: job.key,
    mediaUrl: job.mediaUrl,
  }
  if (job.title) message.title = job.title
  if (job.index !== undefined) message.index = job.index
  if (job.live === true && job.includeExisting === true) message.includeExisting = true
  const started = await sendOffscreen(message)
  if (started === undefined) {
    await failDispatch(job, HLS_TEXT.offscreen)
    return
  }
  if (isFailure(started)) await failDispatch(job, started.error)
}

async function dispatchDash(job: DashQueueJob): Promise<void> {
  const message: Record<string, unknown> = {
    type: 'DASH_OFFSCREEN_DOWNLOAD',
    playlistUrl: job.key,
    separate: job.separate === true,
    audioOnly: job.audioOnly === true,
  }
  if (job.representationId) message.representationId = job.representationId
  if (job.title) message.title = job.title
  if (job.index !== undefined) message.index = job.index
  const started = await sendOffscreen(message)
  if (started === undefined) {
    await failDispatch(job, HLS_TEXT.offscreen)
    return
  }
  if (isFailure(started)) await failDispatch(job, started.error)
}

async function dispatchBilibili(job: BilibiliQueueJob): Promise<void> {
  let title = job.title
  let index = job.index
  if (!title || index === undefined) {
    const context = await downloadContext(job.tabId, job.key)
    if (!title) title = context.title
    if (index === undefined) index = context.index
  }
  const result = await runBilibiliWithReferer(
    { pageUrl: job.pageUrl, mediaUrls: job.files.map((file) => file.url), jobKey: job.key },
    async () => {
      const pending = waitForBilibiliDownload(job.key)
      const payload: Record<string, unknown> = {
        type: BILIBILI_OFFSCREEN.DOWNLOAD,
        key: job.key,
        files: job.files,
      }
      if (title) payload.title = title
      if (index !== undefined) payload.index = index
      if (job.separate === true) payload.separate = true
      const started = await sendOffscreen(payload)
      if (started === undefined) {
        finishBilibiliDownload(job.key, { ok: false, error: HLS_TEXT.offscreen })
        return pending
      }
      if (isFailure(started)) {
        finishBilibiliDownload(job.key, { ok: false, error: started.error })
      }
      return pending
    },
    { allowConcurrent: true },
  )
  if (!result.ok && !result.cancelled) {
    await setJobFailedIfPending(job, result.error ?? HLS_TEXT.internal)
  }
  await finishQueueJob(job.id)
}

function dispatch(job: QueueJob): void {
  const run =
    job.kind === 'hls'
      ? dispatchHls(job)
      : job.kind === 'dash'
        ? dispatchDash(job)
        : dispatchBilibili(job)
  void run.catch((error: unknown) => {
      warn('下载队列启动任务失败', error)
      void failDispatch(job, HLS_TEXT.internal).catch((failure: unknown) => {
        warn('记录下载失败状态失败', failure)
      })
    })
}

/** 已经写进 running 的任务交给 offscreen。调用前队列状态已经保存。 */
function dispatchStarted(started: readonly QueueJob[]): void {
  for (const job of started) dispatch(job)
}

async function discoverActiveKeys(): Promise<string[]> {
  if (!(await offscreenExists())) return []
  const response = await sendOffscreen({ type: 'HLS_OFFSCREEN_SYNC' })
  return readOffscreenActiveKeys(response)
}

async function markLost(lost: readonly QueueJob[]): Promise<void> {
  for (const job of lost) {
    try {
      await setJobFailedIfPending(job, QUEUE_INTERRUPTED_TEXT)
    } catch (error) {
      warn('标记中断任务失败', error)
    }
  }
}

/** 读队列、清理僵尸、补位。调用方已经持有队列串行锁。 */
async function pumpLocked(): Promise<DownloadQueueState> {
  let state = await readState()
  const expired = expireWaiting(state, Date.now())
  state = expired.state
  for (const job of expired.expired) {
    try {
      await updateStoredJob(storageKeyOf(job.kind), job.key, (current) => {
        if (current && current.phase !== 'queued') return current
        if (!current) {
          return {
            phase: 'failed',
            message: QUEUE_EXPIRED_TEXT,
            completed: 0,
            total: 0,
            updatedAt: Date.now(),
          }
        }
        return { ...current, phase: 'failed', message: QUEUE_EXPIRED_TEXT, updatedAt: Date.now() }
      })
    } catch (error) {
      warn('清理超时排队任务失败', error)
    }
  }

  const taken = takeStartable(state, MAX_CONCURRENT_JOBS)
  state = taken.state
  await saveState(state)
  await refreshQueuedPositions(state)
  for (const job of taken.started) {
    try {
      await setStartingStatus(job)
    } catch (error) {
      warn('更新开始状态失败', error)
    }
  }
  dispatchStarted(taken.started)
  return state
}

/** 当前队列快照。popup 直接读 storage，这里给后台自检和测试用。 */
export function readDownloadQueueState(): Promise<DownloadQueueState> {
  return readState()
}

/** 新任务入队，必要时立即启动队首。 */
function enqueueNew(job: QueueJob): Promise<Result> {
  return enqueue(async () => {
    let state = await readState()
    const existingRunning = state.running.find((entry) => sameKey(entry, job.kind, job.key))
    if (existingRunning) return { ok: false as const, error: HLS_TEXT.busy }
    const existingWaiting = state.waiting.find((entry) => sameKey(entry, job.kind, job.key))
    if (existingWaiting) {
      const removed = removeWaiting(state, existingWaiting.id)
      state = removed.state
    }
    if (state.waiting.length >= MAX_WAITING_JOBS) {
      return { ok: false as const, error: QUEUE_FULL_TEXT }
    }
    state = enqueueJob(state, job)
    await saveState(state)
    const position = state.waiting.findIndex((entry) => entry.id === job.id) + 1
    await setQueuedStatus(job, queuedStatusText(position), true)
    await pumpLocked()
    return { ok: true as const }
  })
}

export function enqueueHlsJob(input: {
  key: string
  mediaUrl: string
  live?: boolean
  includeExisting?: boolean
  tabId?: number
  title?: string
  index?: number
}): Promise<Result> {
  const job: HlsQueueJob = {
    id: newId(),
    kind: 'hls',
    key: input.key,
    mediaUrl: input.mediaUrl,
    enqueuedAt: Date.now(),
  }
  if (input.live === true) job.live = true
  if (input.live === true && input.includeExisting === true) job.includeExisting = true
  if (input.tabId !== undefined) job.tabId = input.tabId
  if (input.title) job.title = input.title
  if (input.index !== undefined) job.index = input.index
  return enqueueNew(job)
}

export function enqueueDashJob(input: {
  key: string
  representationId?: string
  separate?: boolean
  audioOnly?: boolean
  tabId?: number
  title?: string
  index?: number
}): Promise<Result> {
  const job: DashQueueJob = {
    id: newId(),
    kind: 'dash',
    key: input.key,
    enqueuedAt: Date.now(),
  }
  if (input.representationId) job.representationId = input.representationId
  if (input.separate === true) job.separate = true
  if (input.audioOnly === true) job.audioOnly = true
  if (input.tabId !== undefined) job.tabId = input.tabId
  if (input.title) job.title = input.title
  if (input.index !== undefined) job.index = input.index
  return enqueueNew(job)
}

export function enqueueBilibiliJob(input: {
  key: string
  pageUrl: string
  files: BilibiliQueueJob['files']
  separate?: boolean
  tabId?: number
  title?: string
  index?: number
}): Promise<Result> {
  const job: BilibiliQueueJob = {
    id: newId(),
    kind: 'bilibili',
    key: input.key,
    pageUrl: input.pageUrl,
    files: input.files,
    enqueuedAt: Date.now(),
  }
  if (input.separate === true) job.separate = true
  if (input.tabId !== undefined) job.tabId = input.tabId
  if (input.title) job.title = input.title
  if (input.index !== undefined) job.index = input.index
  return enqueueNew(job)
}

/** 取消排队中的任务。返回 true 表示根本不用再问 offscreen。 */
export function cancelQueuedJob(kind: QueueJobKind, key: string): Promise<boolean> {
  return enqueue(async () => {
    let state = await readState()
    const job = state.waiting.find((entry) => sameKey(entry, kind, key))
    if (!job) return false
    const removed = removeWaiting(state, job.id)
    state = removed.state
    await saveState(state)
    await setJobCancelledIfQueued(job)
    await refreshQueuedPositions(state)
    return true
  })
}

/** 完成、失败或取消后腾出槽位并补位。 */
export function finishQueueJob(id: string): Promise<void> {
  return enqueue(async () => {
    const state = await readState()
    if (!state.running.some((job) => job.id === id)) return
    await saveState(finishRunning(state, id))
    await pumpLocked()
  })
}

async function finishByStorageKey(storageKey: string, key: string): Promise<void> {
  const kind: QueueJobKind =
    storageKey === DASH_JOB_STORAGE_KEY ? 'dash' : storageKey === BILIBILI_JOB_STORAGE_KEY ? 'bilibili' : 'hls'
  await enqueue(async () => {
    const state = await readState()
    if (!state.running.some((job) => sameKey(job, kind, key))) return
    await saveState(finishRunningByKey(state, key))
    await pumpLocked()
  })
}

/** HLS / DASH 任务写进终态时，队列自动补位。 */
function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName): void {
  if (area !== 'session') return
  for (const storageKey of [HLS_JOB_STORAGE_KEY, DASH_JOB_STORAGE_KEY]) {
    if (!(storageKey in changes)) continue
    const map: HlsJobMap = readHlsJobMap(changes[storageKey]?.newValue)
    for (const [key, record] of Object.entries(map)) {
      if (record.phase !== 'complete' && record.phase !== 'failed' && record.phase !== 'cancelled') continue
      void finishByStorageKey(storageKey, key).catch((error: unknown) => {
        warn('同步下载队列完成状态失败', error)
      })
    }
  }
}

/**
 * 恢复队列：offscreen 还活着的 running 保留，不在的标成中断；
 * 排队太久或过量的清理掉，然后继续补位。不会留下永远「排队中」的任务。
 */
export function reconcileDownloadQueue(activeKeys?: readonly string[]): Promise<void> {
  return enqueue(async () => {
    let state = await readState()
    const keys = activeKeys ?? (await discoverActiveKeys())
    const live = new Set(keys)
    const reconciled = reconcileRunning(state, live)
    if (reconciled.lost.length > 0) {
      state = reconciled.state
      await saveState(state)
      await markLost(reconciled.lost)
    }
    await pumpLocked()
  })
}

/** service worker 启动时接一次。重复调用不会叠加监听。 */
export function initDownloadQueue(): void {
  if (initialized) return
  initialized = true
  if (!listening) {
    listening = true
    try {
      chrome.storage.onChanged.addListener(onStorageChanged)
    } catch (error) {
      warn('监听任务状态失败', error)
    }
  }
  void reconcileDownloadQueue().catch((error: unknown) => {
    warn('恢复下载队列失败', error)
  })
}

export { MAX_CONCURRENT_JOBS }
