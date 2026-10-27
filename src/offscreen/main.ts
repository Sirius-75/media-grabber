/**
 * 后台下载页。chrome.offscreen 打开它，不给用户看。
 *
 * Service worker 会被回收，分片下载和拼接不能放在那里。
 * 这里按清单顺序把分片拉进内存，拼成一个 Blob，再交给 chrome.downloads。
 * MPEG-TS 在保存前转封装成 mp4。转失败就仍保存原来的 .ts。
 * 带 EXT-X-MAP 的 fMP4 不再转一次。不设置请求头，也不伪造 Referer。
 */

import { describeInterruptReason } from '../shared/download-status'
import { buildDownloadFilename } from '../shared/filename'
import { downloadSegmentsInOrder } from '../shared/hls-download'
import { fetchPlaylistText, fetchSegmentBytes } from '../shared/hls-fetch'
import { planHlsSave, type HlsSavePlan } from '../shared/hls-remux'
import { transmuxTsSegment } from '../shared/hls-remux-mux'
import {
  HLS_TEXT,
  describePlaylistStatus,
  hlsProgressText,
  mediaDownloadWarning,
  parseHlsPlaylist,
  type HlsPlaylist,
} from '../shared/hls'
import { abortDashInspect, inspectDash, startDashDownload, type DashHost } from './dash-task'
import { DASH_JOB_STORAGE_KEY } from '../shared/dash-job'
import {
  HLS_JOB_STORAGE_KEY,
  readHlsJobMap,
  toVariantChoice,
  trimHlsJobs,
  type HlsJobMap,
  type HlsJobRecord,
} from '../shared/hls-job'

const ROLE = 'offscreen'

interface DownloadRequest {
  playlistUrl: string
  mediaUrl: string
  title?: string
  index?: number
}

interface ActiveDownload {
  key: string
  controller: AbortController
}

let active: ActiveDownload | undefined
let inspecting: { key: string; controller: AbortController } | undefined
let writeQueue: Promise<void> = Promise.resolve()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function readMap(storageKey = HLS_JOB_STORAGE_KEY): Promise<HlsJobMap> {
  const stored = await chrome.storage.session.get(storageKey)
  return readHlsJobMap(stored[storageKey])
}

async function saveMap(map: HlsJobMap, storageKey = HLS_JOB_STORAGE_KEY): Promise<void> {
  await chrome.storage.session.set({ [storageKey]: trimHlsJobs(map) })
}

function writeJob(
  key: string,
  record: HlsJobRecord,
  controller?: AbortController,
  storageKey = HLS_JOB_STORAGE_KEY,
): Promise<void> {
  return enqueue(async () => {
    // 同一个清单被重新开始之后，旧任务晚到的进度不能把新任务盖掉。
    if (controller && active?.controller !== controller) return
    const map = await readMap(storageKey)
    map[key] = record
    await saveMap(map, storageKey)
  })
}

function job(input: Omit<HlsJobRecord, 'updatedAt'>): HlsJobRecord {
  const record: HlsJobRecord = {
    phase: input.phase,
    message: input.message,
    completed: input.completed,
    total: input.total,
    updatedAt: Date.now(),
  }
  if (input.warning) record.warning = input.warning
  if (input.variants) record.variants = input.variants
  return record
}

function stillCurrent(controller: AbortController): boolean {
  return active?.controller === controller
}

async function loadPlaylist(url: string, signal: AbortSignal): Promise<HlsPlaylist> {
  const fetched = await fetchPlaylistText(url, signal)
  if (!fetched.ok) return { ok: false, error: describePlaylistStatus(fetched.status, fetched.reason) }
  return parseHlsPlaylist(fetched.text, url)
}

async function inspect(playlistUrl: string): Promise<unknown> {
  if (active?.key === playlistUrl) return { ok: false, error: HLS_TEXT.busy }
  inspecting?.controller.abort()
  const controller = new AbortController()
  inspecting = { key: playlistUrl, controller }
  try {
    const parsed = await loadPlaylist(playlistUrl, controller.signal)
    if (!parsed.ok) {
      await writeJob(playlistUrl, job({ phase: 'failed', message: parsed.error, completed: 0, total: 0 }))
      return { ok: false, error: parsed.error }
    }
    if (parsed.kind === 'master') {
      const variants = parsed.variants.map(toVariantChoice)
      await writeJob(
        playlistUrl,
        job({
          phase: 'picking',
          message: HLS_TEXT.picking,
          completed: 0,
          total: 0,
          variants,
        }),
      )
      return { ok: true, kind: 'master', variants }
    }
    const total = parsed.media.segmentCount + (parsed.media.initUrl ? 1 : 0)
    const assessment = mediaDownloadWarning({
      segmentCount: parsed.media.segmentCount,
      durationSeconds: parsed.media.durationSeconds,
    })
    if (!assessment.ok) {
      await writeJob(playlistUrl, job({ phase: 'failed', message: assessment.error, completed: 0, total: 0 }))
      return { ok: false, error: assessment.error }
    }
    const response: {
      ok: true
      kind: 'media'
      total: number
      container: 'ts' | 'mp4'
      warning?: string
    } = {
      ok: true,
      kind: 'media',
      total,
      container: parsed.media.container,
    }
    if (assessment.warning) response.warning = assessment.warning
    return response
  } catch (error) {
    if (controller.signal.aborted) {
      if (inspecting?.controller === controller) {
        await writeJob(playlistUrl, job({ phase: 'cancelled', message: HLS_TEXT.cancelled, completed: 0, total: 0 }))
      }
      return { ok: false, error: HLS_TEXT.cancelled }
    }
    warn('读取清单失败', error)
    return { ok: false, error: HLS_TEXT.network }
  } finally {
    if (inspecting?.controller === controller) inspecting = undefined
  }
}

function readDownload(value: Record<string, unknown>): DownloadRequest | undefined {
  if (typeof value.playlistUrl !== 'string' || value.playlistUrl.trim() === '') return undefined
  if (typeof value.mediaUrl !== 'string' || value.mediaUrl.trim() === '') return undefined
  const request: DownloadRequest = {
    playlistUrl: value.playlistUrl.trim(),
    mediaUrl: value.mediaUrl.trim(),
  }
  if (typeof value.title === 'string' && value.title.trim()) request.title = value.title
  if (typeof value.index === 'number' && Number.isInteger(value.index) && value.index >= 1) request.index = value.index
  return request
}

function acceptDownload(request: DownloadRequest): { ok: true } | { ok: false; error: string } {
  if (active && active.key !== request.playlistUrl) return { ok: false, error: HLS_TEXT.busy }
  if (active?.key === request.playlistUrl) active.controller.abort()
  const controller = new AbortController()
  // 先占住，避免同步检查把正在开始的任务当成已经中断。
  active = { key: request.playlistUrl, controller }
  void runDownload(request, controller)
  return { ok: true }
}

async function failJob(key: string, controller: AbortController, message: string, total = 0): Promise<void> {
  await writeJob(key, job({ phase: 'failed', message, completed: 0, total }), controller)
}

async function runDownload(request: DownloadRequest, controller: AbortController): Promise<void> {
  const signal = controller.signal
  const key = request.playlistUrl
  let objectUrl: string | undefined
  try {
    let bandwidth: number | undefined
    let separateAudio = false
    if (request.mediaUrl !== request.playlistUrl) {
      const master = await loadPlaylist(request.playlistUrl, signal)
      if (!stillCurrent(controller)) return
      if (!master.ok) {
        await failJob(key, controller, master.error)
        return
      }
      if (master.kind !== 'master') {
        await failJob(key, controller, HLS_TEXT.nestedMaster)
        return
      }
      const variant = master.variants.find((item) => item.url === request.mediaUrl)
      if (!variant) {
        await failJob(key, controller, HLS_TEXT.variantMissing)
        return
      }
      bandwidth = variant.bandwidth > 0 ? variant.bandwidth : undefined
      separateAudio = variant.separateAudio
    }

    const parsed = await loadPlaylist(request.mediaUrl, signal)
    if (!stillCurrent(controller)) return
    if (!parsed.ok) {
      await failJob(key, controller, parsed.error)
      return
    }
    if (parsed.kind !== 'media') {
      await failJob(key, controller, HLS_TEXT.nestedMaster)
      return
    }

    const media = parsed.media
    const assessment = mediaDownloadWarning({
      segmentCount: media.segmentCount,
      durationSeconds: media.durationSeconds,
      bandwidth,
      separateAudio,
    })
    if (!assessment.ok) {
      await failJob(key, controller, assessment.error)
      return
    }

    const urls: string[] = []
    if (media.initUrl) urls.push(media.initUrl)
    for (const segment of media.segments) urls.push(segment.url)
    const total = urls.length
    const initCount = media.initUrl ? 1 : 0
    let completed = 0
    await writeJob(
      key,
      job({
        phase: 'downloading',
        message: hlsProgressText(0, total),
        completed: 0,
        total,
        warning: assessment.warning,
      }),
      controller,
    )
    if (!stillCurrent(controller)) return

    const result = await downloadSegmentsInOrder({
      urls,
      initCount,
      signal,
      retryDelayMs: 200,
      fetchSegment: (url, inner) => fetchSegmentBytes(url, inner),
      onProgress(progress) {
        if (!stillCurrent(controller)) return
        completed = progress.completed
        void writeJob(
          key,
          job({
            phase: 'downloading',
            message: hlsProgressText(progress.completed, progress.total),
            completed: progress.completed,
            total: progress.total,
            warning: assessment.warning,
          }),
          controller,
        )
      },
    })
    if (!stillCurrent(controller)) return
    if (!result.ok) {
      await writeJob(
        key,
        job({
          phase: result.cancelled ? 'cancelled' : 'failed',
          message: result.error,
          completed,
          total,
          warning: assessment.warning,
        }),
        controller,
      )
      return
    }

    let planned: HlsSavePlan
    try {
      planned = await planHlsSave({
        container: media.container,
        parts: result.parts,
        transmux: transmuxTsSegment,
        signal,
        // 每片转完让出一次事件循环，取消才能插进来。转封装本身仍在这个页面里，不进 service worker。
        yield: () =>
          new Promise((resolve) => {
            setTimeout(resolve, 0)
          }),
        onRemuxStart: () =>
          writeJob(
            key,
            job({
              phase: 'remuxing',
              message: HLS_TEXT.remuxing,
              completed: total,
              total,
              warning: assessment.warning,
            }),
            controller,
          ),
      })
    } catch (error) {
      // fMP4 不走转封装。TS 转封装出了预料之外的错，也要留下 .ts，不能让整次下载失败。
      if (media.container !== 'ts') throw error
      if (!stillCurrent(controller)) return
      if (signal.aborted) {
        await writeJob(key, job({ phase: 'cancelled', message: HLS_TEXT.cancelled, completed: total, total }), controller)
        return
      }
      warn('转封装失败，改为保存 TS', error)
      planned = {
        ok: true,
        ext: 'ts',
        mime: 'video/mp2t',
        parts: result.parts,
        message: HLS_TEXT.remuxFallback,
      }
    }
    if (!stillCurrent(controller)) return
    if (!planned.ok) {
      await writeJob(key, job({ phase: 'cancelled', message: HLS_TEXT.cancelled, completed: total, total }), controller)
      return
    }

    const filename = buildDownloadFilename({
      title: request.title,
      url: key,
      ext: planned.ext,
      index: request.index,
    })
    // 分片已经是独立的 Uint8Array。这里只做一次类型断言，不再复制一份，避免峰值内存再翻一倍。
    const blob = new Blob(planned.parts as BlobPart[], { type: planned.mime })
    objectUrl = URL.createObjectURL(blob)
    // 只传 url / filename / saveAs / conflictAction，不加 headers。
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    })
    if (!stillCurrent(controller)) return
    if (typeof downloadId !== 'number') {
      await failJob(key, controller, '保存文件失败', total)
      return
    }
    console.info('[media-grabber] HLS 已保存', downloadId, filename)
    await writeJob(
      key,
      job({
        phase: 'complete',
        message: planned.message,
        completed: total,
        total,
        warning: assessment.warning,
      }),
      controller,
    )
  } catch (error) {
    if (!stillCurrent(controller)) return
    if (signal.aborted) {
      await writeJob(key, job({ phase: 'cancelled', message: HLS_TEXT.cancelled, completed: 0, total: 0 }), controller)
      return
    }
    warn('HLS 下载失败', error)
    const message = describeInterruptReason(error instanceof Error ? error.message : undefined)
    await failJob(key, controller, message)
  } finally {
    if (objectUrl) {
      const url = objectUrl
      // chrome.downloads 读取 blob 地址是异步的，马上 revoke 会让保存失败。
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
    if (active?.controller === controller) active = undefined
  }
}

async function syncStorage(storageKey: string, phases: ReadonlySet<string>): Promise<void> {
  await enqueue(async () => {
    const map = await readMap(storageKey)
    let changed = false
    for (const [key, record] of Object.entries(map)) {
      if (!phases.has(record.phase)) continue
      if (active?.key === key) continue
      map[key] = {
        ...record,
        phase: 'failed',
        message: HLS_TEXT.interrupted,
        updatedAt: Date.now(),
      }
      changed = true
    }
    if (changed) await saveMap(map, storageKey)
  })
}

const HLS_ACTIVE_PHASES = new Set(['downloading', 'inspecting', 'remuxing'])
const DASH_ACTIVE_PHASES = new Set(['downloading', 'inspecting'])

async function syncJobs(): Promise<{ ok: true }> {
  await syncStorage(HLS_JOB_STORAGE_KEY, HLS_ACTIVE_PHASES)
  await syncStorage(DASH_JOB_STORAGE_KEY, DASH_ACTIVE_PHASES)
  return { ok: true }
}

const dashHost: DashHost = {
  isActive(key) {
    return active?.key === key
  },
  busyOther(key) {
    return active && active.key !== key ? HLS_TEXT.busy : undefined
  },
  abortSame(key) {
    if (active?.key === key) active.controller.abort()
  },
  setActive(key, controller) {
    active = { key, controller }
  },
  still(controller) {
    return active?.controller === controller
  },
  clear(controller) {
    if (active?.controller === controller) active = undefined
  },
  write(key, record, controller) {
    return writeJob(key, record, controller, DASH_JOB_STORAGE_KEY)
  },
}

function cancelJob(playlistUrl: string): { ok: true } {
  if (active?.key === playlistUrl) {
    active.controller.abort()
    return { ok: true }
  }
  if (inspecting?.key === playlistUrl) inspecting.controller.abort()
  void enqueue(async () => {
    const map = await readMap()
    const record = map[playlistUrl]
    if (!record) return
    if (
      record.phase !== 'downloading' &&
      record.phase !== 'inspecting' &&
      record.phase !== 'picking' &&
      record.phase !== 'remuxing'
    ) {
      return
    }
    map[playlistUrl] = {
      ...record,
      phase: 'cancelled',
      message: HLS_TEXT.cancelled,
      updatedAt: Date.now(),
    }
    await saveMap(map)
  })
  return { ok: true }
}

function cancelDash(playlistUrl: string): { ok: true } {
  abortDashInspect(playlistUrl)
  if (active?.key === playlistUrl) {
    active.controller.abort()
    return { ok: true }
  }
  void enqueue(async () => {
    const map = await readMap(DASH_JOB_STORAGE_KEY)
    const record = map[playlistUrl]
    if (!record) return
    if (record.phase !== 'downloading' && record.phase !== 'inspecting' && record.phase !== 'picking') return
    map[playlistUrl] = {
      ...record,
      phase: 'cancelled',
      message: HLS_TEXT.cancelled,
      updatedAt: Date.now(),
    }
    await saveMap(map, DASH_JOB_STORAGE_KEY)
  })
  return { ok: true }
}

function readDashRequest(value: Record<string, unknown>): { playlistUrl: string; representationId?: string; title?: string; index?: number } | undefined {
  if (typeof value.playlistUrl !== 'string' || value.playlistUrl.trim() === '') return undefined
  const request: { playlistUrl: string; representationId?: string; title?: string; index?: number } = {
    playlistUrl: value.playlistUrl.trim(),
  }
  if (typeof value.representationId === 'string' && value.representationId.trim()) {
    request.representationId = value.representationId.trim()
  }
  if (typeof value.title === 'string' && value.title.trim()) request.title = value.title
  if (typeof value.index === 'number' && Number.isInteger(value.index) && value.index >= 1) request.index = value.index
  return request
}

function start(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isRecord(message) || typeof message.type !== 'string') return undefined
    if (message.type === 'HLS_OFFSCREEN_INSPECT') {
      if (typeof message.playlistUrl !== 'string' || message.playlistUrl.trim() === '') {
        sendResponse({ ok: false, error: HLS_TEXT.badPlaylistUrl })
        return undefined
      }
      void inspect(message.playlistUrl.trim()).then(sendResponse, (error: unknown) => {
        warn('检查清单失败', error)
        sendResponse({ ok: false, error: HLS_TEXT.network })
      })
      return true
    }
    if (message.type === 'HLS_OFFSCREEN_DOWNLOAD') {
      const request = readDownload(message)
      if (!request) {
        sendResponse({ ok: false, error: '下载请求无效' })
        return undefined
      }
      sendResponse(acceptDownload(request))
      return undefined
    }
    if (message.type === 'HLS_OFFSCREEN_CANCEL') {
      if (typeof message.playlistUrl !== 'string') return undefined
      sendResponse(cancelJob(message.playlistUrl))
      return undefined
    }
    if (message.type === 'DASH_OFFSCREEN_INSPECT') {
      if (typeof message.playlistUrl !== 'string' || message.playlistUrl.trim() === '') {
        sendResponse({ ok: false, error: HLS_TEXT.badPlaylistUrl })
        return undefined
      }
      void inspectDash(message.playlistUrl.trim(), dashHost).then(sendResponse, (error: unknown) => {
        warn('检查 DASH 清单失败', error)
        sendResponse({ ok: false, error: HLS_TEXT.network })
      })
      return true
    }
    if (message.type === 'DASH_OFFSCREEN_DOWNLOAD') {
      const request = readDashRequest(message)
      if (!request) {
        sendResponse({ ok: false, error: '下载请求无效' })
        return undefined
      }
      sendResponse(startDashDownload(request, dashHost))
      return undefined
    }
    if (message.type === 'DASH_OFFSCREEN_CANCEL') {
      if (typeof message.playlistUrl !== 'string') return undefined
      sendResponse(cancelDash(message.playlistUrl))
      return undefined
    }
    if (message.type === 'DASH_OFFSCREEN_SYNC' || message.type === 'HLS_OFFSCREEN_SYNC') {
      void syncJobs().then(sendResponse, (error: unknown) => {
        warn('同步 HLS 状态失败', error)
        sendResponse({ ok: true })
      })
      return true
    }
    return undefined
  })
}

const params = new URLSearchParams(location.search)
if (params.get('role') === ROLE) {
  start()
} else {
  const note = document.querySelector('#note')
  if (note) note.textContent = '这是后台下载用的页面，请关闭。下载请点工具栏上的 Media Grabber。'
}
