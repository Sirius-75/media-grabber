/**
 * 下载队列的纯函数部分。
 * 队列状态由 service worker 写进 chrome.storage.session，这里不访问浏览器 API。
 * 只调度经 offscreen 的 HLS / DASH / B 站任务，普通 chrome.downloads 直链不占槽位。
 */

import { BILIBILI_ROLES, type BilibiliRole } from './types'

/** 全局最多同时跑两个 offscreen 下载任务。 */
export const MAX_CONCURRENT_JOBS = 2

/** 排队的任务也不宜无限增长。超出时拒绝新的任务。 */
export const MAX_WAITING_JOBS = 50

/** 排队超过这个时间仍未开始，就安全清理，避免留下永远「排队中」的条目。 */
export const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000

export const JOB_QUEUE_STORAGE_KEY = 'download-queue'

export type QueueJobKind = 'hls' | 'dash' | 'bilibili'

export interface QueueJobBase {
  id: string
  kind: QueueJobKind
  /** 对应任务存储里的 key。HLS / DASH 是清单地址，B 站是主分轨地址。 */
  key: string
  /** 开始排队的时间。 */
  enqueuedAt: number
  /** 触发下载的标签页。开始下载时用它取页面标题。 */
  tabId?: number
  /** 排队时记下的页面标题和列表序号，开始下载后直接用来命名。 */
  title?: string
  index?: number
}

export interface HlsQueueJob extends QueueJobBase {
  kind: 'hls'
  mediaUrl: string
  /** 这是直播录制。派发时走 HLS_OFFSCREEN_LIVE_START，而不是点播下载。 */
  live?: boolean
}

export interface DashQueueJob extends QueueJobBase {
  kind: 'dash'
  representationId?: string
  separate?: boolean
  audioOnly?: boolean
}

export interface BilibiliQueueJob extends QueueJobBase {
  kind: 'bilibili'
  pageUrl: string
  files: Array<{ url: string; role: BilibiliRole; quality?: string }>
  separate?: boolean
}

export type QueueJob = HlsQueueJob | DashQueueJob | BilibiliQueueJob

export interface DownloadQueueState {
  /** 已经交给 offscreen、还没结束的任务。 */
  running: QueueJob[]
  /** 还没开始的排队任务，顺序就是启动顺序。 */
  waiting: QueueJob[]
}

export function emptyQueue(): DownloadQueueState {
  return { running: [], waiting: [] }
}

export function queuedStatusText(position: number): string {
  return `排队中（第 ${position} 位）`
}

/** 排队太久被清理时的中文原因。 */
export const QUEUE_EXPIRED_TEXT = '排队超时，已取消，请重新下载'
/** 排队任务过多时的中文原因。 */
export const QUEUE_FULL_TEXT = '排队任务太多，请等前面的下载完成后再试'
/** 后台页重启后找不到原来的任务。 */
export const QUEUE_INTERRUPTED_TEXT = '下载已中断，请重试'

/** 新任务放到队尾。 */
export function enqueueJob(state: DownloadQueueState, job: QueueJob): DownloadQueueState {
  return { running: [...state.running], waiting: [...state.waiting, job] }
}

/** 排队中的位置，从 1 开始。不在队列里返回 undefined。 */
export function queuePosition(state: DownloadQueueState, id: string): number | undefined {
  const index = state.waiting.findIndex((job) => job.id === id)
  return index >= 0 ? index + 1 : undefined
}

/** 按 key 找排队的任务。同一个地址再次排队时，先取消旧的再入队。 */
export function findWaitingByKey(state: DownloadQueueState, key: string): QueueJob | undefined {
  return state.waiting.find((job) => job.key === key)
}

export function removeWaiting(
  state: DownloadQueueState,
  id: string,
): { state: DownloadQueueState; job?: QueueJob } {
  const index = state.waiting.findIndex((job) => job.id === id)
  if (index < 0) return { state }
  const waiting = [...state.waiting]
  const [job] = waiting.splice(index, 1)
  return { state: { running: [...state.running], waiting }, job }
}

export function removeWaitingByKey(
  state: DownloadQueueState,
  key: string,
): { state: DownloadQueueState; job?: QueueJob } {
  const job = findWaitingByKey(state, key)
  if (!job) return { state }
  return removeWaiting(state, job.id)
}

/**
 * 从队首开始补位，直到 running 达到上限。
 * canStart 用来处理不能并行的任务（例如两条 B 站下载共用 Referer 规则时）。
 * 不可启动的任务会留在队列里，先启动它后面能启动的任务，避免空占槽位。
 */
export function takeStartable(
  state: DownloadQueueState,
  max = MAX_CONCURRENT_JOBS,
  canStart: (job: QueueJob, running: readonly QueueJob[]) => boolean = () => true,
): { state: DownloadQueueState; started: QueueJob[] } {
  const running = [...state.running]
  const waiting = [...state.waiting]
  const started: QueueJob[] = []
  while (running.length < max) {
    const index = waiting.findIndex((job) => canStart(job, running))
    if (index < 0) break
    const [job] = waiting.splice(index, 1)
    if (!job) break
    running.push(job)
    started.push(job)
  }
  return { state: { running, waiting }, started }
}

/** 一个任务结束（完成、失败或取消）后腾出槽位。 */
export function finishRunning(state: DownloadQueueState, id: string): DownloadQueueState {
  return {
    running: state.running.filter((job) => job.id !== id),
    waiting: [...state.waiting],
  }
}

export function finishRunningByKey(state: DownloadQueueState, key: string): DownloadQueueState {
  return {
    running: state.running.filter((job) => job.key !== key),
    waiting: [...state.waiting],
  }
}

/**
 * 清掉已经不在 offscreen 里、也不会再写进度的僵尸运行任务。
 * liveKeys 是 offscreen 当前还活着的任务 key。返回需要标成中断的任务。
 */
export function reconcileRunning(
  state: DownloadQueueState,
  liveKeys: ReadonlySet<string>,
): { state: DownloadQueueState; lost: QueueJob[] } {
  const lost: QueueJob[] = []
  const running: QueueJob[] = []
  for (const job of state.running) {
    if (liveKeys.has(job.key)) running.push(job)
    else lost.push(job)
  }
  return { state: { running, waiting: [...state.waiting] }, lost }
}

/** 排队太久或超过上限的等待任务。返回清理后的队列和要标成失败的条目。 */
export function expireWaiting(
  state: DownloadQueueState,
  now: number,
  maxAgeMs = MAX_QUEUE_AGE_MS,
  maxWaiting = MAX_WAITING_JOBS,
): { state: DownloadQueueState; expired: QueueJob[] } {
  const expired: QueueJob[] = []
  const waiting: QueueJob[] = []
  for (const job of state.waiting) {
    if (now - job.enqueuedAt > maxAgeMs) expired.push(job)
    else waiting.push(job)
  }
  while (waiting.length > maxWaiting) {
    const job = waiting.pop()
    if (job) expired.push(job)
  }
  return {
    state: { running: [...state.running], waiting },
    expired,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (isFiniteNumber(value) && Number.isInteger(value) && value >= 0)
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isBilibiliRole(value: unknown): value is BilibiliRole {
  return typeof value === 'string' && (BILIBILI_ROLES as readonly string[]).includes(value)
}

function parseBase(value: Record<string, unknown>): QueueJobBase | undefined {
  if (!nonEmptyString(value.id) || !nonEmptyString(value.key)) return undefined
  if (!isFiniteNumber(value.enqueuedAt)) return undefined
  if (!optionalNumber(value.tabId) || !optionalNumber(value.index)) return undefined
  const job: QueueJobBase = {
    id: value.id.trim(),
    kind: 'hls',
    key: value.key.trim(),
    enqueuedAt: value.enqueuedAt,
  }
  if (typeof value.tabId === 'number') job.tabId = value.tabId
  if (value.title !== undefined) {
    if (!nonEmptyString(value.title)) return undefined
    job.title = value.title.trim()
  }
  if (typeof value.index === 'number') job.index = value.index
  return job
}

function parseJob(value: unknown): QueueJob | undefined {
  if (!isRecord(value)) return undefined
  const base = parseBase(value)
  if (!base) return undefined
  if (value.kind === 'hls') {
    if (!nonEmptyString(value.mediaUrl)) return undefined
    if (!optionalBoolean(value.live)) return undefined
    const job: HlsQueueJob = { ...base, kind: 'hls', mediaUrl: value.mediaUrl.trim() }
    if (value.live === true) job.live = true
    return job
  }
  if (value.kind === 'dash') {
    if (!optionalBoolean(value.separate) || !optionalBoolean(value.audioOnly)) return undefined
    const job: DashQueueJob = { ...base, kind: 'dash' }
    if (value.representationId !== undefined) {
      if (!nonEmptyString(value.representationId)) return undefined
      job.representationId = value.representationId.trim()
    }
    if (value.separate === true) job.separate = true
    if (value.audioOnly === true) job.audioOnly = true
    return job
  }
  if (value.kind === 'bilibili') {
    if (!nonEmptyString(value.pageUrl) || !Array.isArray(value.files) || value.files.length === 0) return undefined
    const files: BilibiliQueueJob['files'] = []
    for (const entry of value.files) {
      if (!isRecord(entry) || !nonEmptyString(entry.url) || !isBilibiliRole(entry.role)) return undefined
      const file: BilibiliQueueJob['files'][number] = { url: entry.url.trim(), role: entry.role }
      if (entry.quality !== undefined) {
        if (!nonEmptyString(entry.quality)) return undefined
        file.quality = entry.quality.trim()
      }
      files.push(file)
    }
    const job: BilibiliQueueJob = {
      ...base,
      kind: 'bilibili',
      pageUrl: value.pageUrl.trim(),
      files,
    }
    if (value.separate === true) job.separate = true
    return job
  }
  return undefined
}

function parseList(value: unknown): QueueJob[] | undefined {
  if (!Array.isArray(value)) return undefined
  const jobs: QueueJob[] = []
  for (const entry of value) {
    const job = parseJob(entry)
    if (!job) return undefined
    jobs.push(job)
  }
  return jobs
}

/** session 里的值可能写坏。认不出的队列整个丢掉，不让 service worker 崩。 */
export function readDownloadQueue(value: unknown): DownloadQueueState {
  if (!isRecord(value)) return emptyQueue()
  const running = parseList(value.running)
  const waiting = parseList(value.waiting)
  if (!running || !waiting) return emptyQueue()
  return { running, waiting }
}

/** 同一个 id 只留一次，避免写坏的存储反复启动同一条任务。 */
export function dedupeQueue(state: DownloadQueueState): DownloadQueueState {
  const seen = new Set<string>()
  const keep = (job: QueueJob): boolean => {
    if (seen.has(job.id)) return false
    seen.add(job.id)
    return true
  }
  return {
    running: state.running.filter(keep),
    waiting: state.waiting.filter(keep),
  }
}
