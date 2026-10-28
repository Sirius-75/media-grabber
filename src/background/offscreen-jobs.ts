/**
 * offscreen 不能使用会话存储，也不能调用 chrome.downloads。
 * 进度和保存文件都从这里串行处理。分片字节不经过 service worker。
 */

import { describeInterruptReason } from '../shared/interrupt-reason'
import { BILIBILI_JOB_STORAGE_KEY } from '../shared/bilibili'
import { DASH_JOB_STORAGE_KEY } from '../shared/dash-job'
import { HLS_TEXT } from '../shared/hls'
import { HLS_JOB_STORAGE_KEY, readHlsJobMap, trimHlsJobs, type HlsJobMap, type HlsJobRecord } from '../shared/hls-job'
import {
  readCancelJobMessage,
  readSaveBlobMessage,
  readWriteJobMessage,
  type OffscreenCancelJob,
  type OffscreenSaveBlob,
  type OffscreenWriteJob,
} from '../shared/offscreen-bridge'

const HLS_ACTIVE_PHASES = new Set(['downloading', 'inspecting', 'remuxing'])
const DASH_ACTIVE_PHASES = new Set(['downloading', 'inspecting', 'merging'])
const BILIBILI_ACTIVE_PHASES = new Set(['downloading', 'merging'])

type Ack = { ok: true } | { ok: false; error: string }

let writeQueue: Promise<void> = Promise.resolve()
let listening = false

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function readMap(storageKey: string): Promise<HlsJobMap> {
  const stored = (await chrome.storage.session.get(storageKey)) as Record<string, unknown>
  return readHlsJobMap(stored[storageKey])
}

async function saveMap(storageKey: string, map: HlsJobMap): Promise<void> {
  await chrome.storage.session.set({ [storageKey]: trimHlsJobs(map) })
}

function keepEpoch(current: HlsJobRecord | undefined, incoming: HlsJobRecord): HlsJobRecord {
  if (typeof incoming.epoch === 'number') return incoming
  if (typeof current?.epoch !== 'number') return incoming
  return { ...incoming, epoch: current.epoch }
}

function putJob(input: OffscreenWriteJob): Promise<Ack> {
  return enqueue(async () => {
    const parsed = readHlsJobMap({ [input.key]: input.record })[input.key]
    if (!parsed) return { ok: false, error: '任务记录无效' }
    const map = await readMap(input.storageKey)
    const current = map[input.key]
    const next = keepEpoch(current, parsed)
    // 同一个清单被重新开始之后，旧任务晚到的进度不能把新任务盖掉。
    if (typeof next.epoch === 'number' && typeof current?.epoch === 'number' && next.epoch < current.epoch) {
      return { ok: true }
    }
    map[input.key] = next
    await saveMap(input.storageKey, map)
    return { ok: true }
  })
}

function cancelStored(input: OffscreenCancelJob): Promise<Ack> {
  return enqueue(async () => {
    const map = await readMap(input.storageKey)
    const record = map[input.key]
    if (!record || !input.phases.includes(record.phase)) return { ok: true }
    map[input.key] = {
      ...record,
      phase: 'cancelled',
      message: HLS_TEXT.cancelled,
      updatedAt: Date.now(),
    }
    await saveMap(input.storageKey, map)
    return { ok: true }
  })
}

async function interrupt(storageKey: string, phases: ReadonlySet<string>, activeKey: string | undefined): Promise<void> {
  const map = await readMap(storageKey)
  let changed = false
  for (const [key, record] of Object.entries(map)) {
    if (!phases.has(record.phase)) continue
    if (activeKey !== undefined && key === activeKey) continue
    map[key] = {
      ...record,
      phase: 'failed',
      message: HLS_TEXT.interrupted,
      updatedAt: Date.now(),
    }
    changed = true
  }
  if (changed) await saveMap(storageKey, map)
}

/** 把已经不在下载的进度标成中断。activeKey 是 offscreen 里还活着的那一条。 */
export function syncStoredJobs(activeKey?: string): Promise<void> {
  return enqueue(async () => {
    await interrupt(HLS_JOB_STORAGE_KEY, HLS_ACTIVE_PHASES, activeKey)
    await interrupt(DASH_JOB_STORAGE_KEY, DASH_ACTIVE_PHASES, activeKey)
    await interrupt(BILIBILI_JOB_STORAGE_KEY, BILIBILI_ACTIVE_PHASES, activeKey)
  })
}

function saveBlob(input: OffscreenSaveBlob): Promise<Ack & { downloadId?: number }> {
  // 只传 url / filename / saveAs / conflictAction，不加 headers。
  const options: chrome.downloads.DownloadOptions = {
    url: input.url,
    filename: input.filename,
    saveAs: false,
    conflictAction: 'uniquify',
  }
  return (async () => {
    try {
      const downloadId = await chrome.downloads.download(options)
      if (typeof downloadId !== 'number') return { ok: false as const, error: '保存文件失败' }
      console.info('[media-grabber] 开始保存拼接文件', downloadId, input.filename)
      return { ok: true as const, downloadId }
    } catch (error) {
      warn('保存拼接文件失败', error)
      return { ok: false as const, error: describeInterruptReason(error instanceof Error ? error.message : undefined) }
    }
  })()
}

export function handleOffscreenBridgeMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (!isRecord(message) || typeof message.type !== 'string') return undefined
  if (message.type === 'OFFSCREEN_WRITE_JOB') {
    const write = readWriteJobMessage(message)
    if (!write) {
      sendResponse({ ok: false, error: '任务记录无效' })
      return true
    }
    void putJob(write).then(sendResponse, (error: unknown) => {
      warn('写入任务进度失败', error)
      sendResponse({ ok: false, error: '写入任务状态失败' })
    })
    return true
  }
  if (message.type === 'OFFSCREEN_CANCEL_JOB') {
    const cancel = readCancelJobMessage(message)
    if (!cancel) {
      sendResponse({ ok: false, error: '任务记录无效' })
      return true
    }
    void cancelStored(cancel).then(sendResponse, (error: unknown) => {
      warn('取消任务状态失败', error)
      sendResponse({ ok: false, error: '写入任务状态失败' })
    })
    return true
  }
  if (message.type === 'OFFSCREEN_SAVE_BLOB') {
    const save = readSaveBlobMessage(message)
    if (!save) {
      sendResponse({ ok: false, error: '保存文件失败' })
      return true
    }
    void saveBlob(save).then(sendResponse, (error: unknown) => {
      warn('保存拼接文件失败', error)
      sendResponse({ ok: false, error: '保存文件失败' })
    })
    return true
  }
  return undefined
}

/** 重复调用不会叠两层监听。 */
export function listenForOffscreenJobs(): void {
  if (listening) return
  listening = true
  chrome.runtime.onMessage.addListener(handleOffscreenBridgeMessage)
}
