/**
 * 在 offscreen 文档里下载 DASH 分片。
 * 不在 service worker 里跑。不设置请求头。
 * 视频和音频分开保存，不尝试把两路 fMP4 合成一个文件。
 * 拼好的 Blob 交给后台保存。这里不调用下载 API。
 */

import { describeDashFetchFailure, parseMpd, planDashDownload } from '../shared/dash'
import { DASH_TEXT } from '../shared/dash-text'
import { buildDownloadFilename } from '../shared/filename'
import { downloadSegmentsInOrder } from '../shared/hls-download'
import { fetchPlaylistText, fetchSegmentBytes } from '../shared/hls-fetch'
import { HLS_TEXT, describePlaylistStatus, hlsProgressText } from '../shared/hls'
import type { HlsJobRecord } from '../shared/hls-job'
import { inspectFailureMessage, settleJob } from './failure'
import { saveBlobFile } from './runtime-bridge'

export interface DashRequest {
  playlistUrl: string
  representationId?: string
  title?: string
  index?: number
}

export interface DashHost {
  isActive(key: string): boolean
  busyOther(key: string): string | undefined
  abortSame(key: string): void
  setActive(key: string, controller: AbortController): void
  still(controller: AbortController): boolean
  clear(controller: AbortController): void
  write(key: string, record: HlsJobRecord, controller?: AbortController): Promise<void>
}

let inspecting: { key: string; controller: AbortController } | undefined

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
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

export function abortDashInspect(playlistUrl: string): void {
  if (inspecting?.key === playlistUrl) inspecting.controller.abort()
}

async function loadManifest(url: string, signal: AbortSignal) {
  const fetched = await fetchPlaylistText(url, signal)
  if (!fetched.ok) return { ok: false as const, error: describePlaylistStatus(fetched.status, fetched.reason) }
  return parseMpd(fetched.text, url)
}

export async function inspectDash(playlistUrl: string, host: DashHost): Promise<unknown> {
  if (host.isActive(playlistUrl)) return { ok: false, error: HLS_TEXT.busy }
  inspecting?.controller.abort()
  const controller = new AbortController()
  inspecting = { key: playlistUrl, controller }
  try {
    const parsed = await loadManifest(playlistUrl, controller.signal)
    if (!parsed.ok) {
      await host.write(playlistUrl, job({ phase: 'failed', message: parsed.error, completed: 0, total: 0 }))
      return { ok: false, error: parsed.error }
    }
    const plan = planDashDownload(parsed)
    if (!plan.ok) {
      await host.write(playlistUrl, job({ phase: 'failed', message: plan.error, completed: 0, total: 0 }))
      return { ok: false, error: plan.error }
    }
    if (plan.files.length === 0) {
      await host.write(
        playlistUrl,
        job({
          phase: 'picking',
          message: DASH_TEXT.picking,
          completed: 0,
          total: 0,
          warning: plan.warning,
          variants: plan.variants,
        }),
      )
      const response: { ok: true; kind: 'master'; variants: typeof plan.variants; warning?: string } = {
        ok: true,
        kind: 'master',
        variants: plan.variants,
      }
      if (plan.warning) response.warning = plan.warning
      return response
    }
    const response: { ok: true; kind: 'media'; total: number; container: 'mp4'; warning?: string } = {
      ok: true,
      kind: 'media',
      total: plan.total,
      container: 'mp4',
    }
    if (plan.warning) response.warning = plan.warning
    return response
  } catch (error) {
    if (controller.signal.aborted) {
      if (inspecting?.controller === controller) {
        await settleJob(() =>
          host.write(playlistUrl, job({ phase: 'cancelled', message: HLS_TEXT.cancelled, completed: 0, total: 0 })),
        )
      }
      return { ok: false, error: HLS_TEXT.cancelled }
    }
    warn('读取 DASH 清单失败', error)
    return { ok: false, error: inspectFailureMessage(error) }
  } finally {
    if (inspecting?.controller === controller) inspecting = undefined
  }
}

async function runDash(request: DashRequest, controller: AbortController, host: DashHost): Promise<void> {
  const signal = controller.signal
  const key = request.playlistUrl
  try {
    const parsed = await loadManifest(key, signal)
    if (!host.still(controller)) return
    if (!parsed.ok) {
      await host.write(key, job({ phase: 'failed', message: parsed.error, completed: 0, total: 0 }), controller)
      return
    }
    const plan = planDashDownload(parsed, request.representationId)
    if (!host.still(controller)) return
    if (!plan.ok) {
      await host.write(key, job({ phase: 'failed', message: plan.error, completed: 0, total: 0 }), controller)
      return
    }
    if (plan.files.length === 0) {
      await host.write(key, job({ phase: 'failed', message: DASH_TEXT.picking, completed: 0, total: 0 }), controller)
      return
    }

    const total = plan.total
    let completed = 0
    await host.write(
      key,
      job({
        phase: 'downloading',
        message: hlsProgressText(0, total),
        completed: 0,
        total,
        warning: plan.warning,
      }),
      controller,
    )
    if (!host.still(controller)) return

    const result = await downloadSegmentsInOrder({
      urls: plan.urls,
      signal,
      retryDelayMs: 200,
      fetchSegment: (url, inner) => fetchSegmentBytes(url, inner),
      onProgress(progress) {
        if (!host.still(controller)) return
        completed = progress.completed
        void host
          .write(
            key,
            job({
              phase: 'downloading',
              message: hlsProgressText(progress.completed, progress.total),
              completed: progress.completed,
              total: progress.total,
              warning: plan.warning,
            }),
            controller,
          )
          .catch((error: unknown) => {
            warn('写入进度失败', error)
          })
      },
    })
    if (!host.still(controller)) return
    if (!result.ok) {
      const message = result.cancelled
        ? HLS_TEXT.cancelled
        : result.status === undefined
          ? result.error
          : describeDashFetchFailure(plan, result.index ?? 0, result.status)
      await host.write(
        key,
        job({
          phase: result.cancelled ? 'cancelled' : 'failed',
          message,
          completed,
          total,
          warning: plan.warning,
        }),
        controller,
      )
      return
    }

    let offset = 0
    const saved: string[] = []
    for (const file of plan.files) {
      const parts = result.parts.slice(offset, offset + file.urls.length)
      offset += file.urls.length
      const filename = buildDownloadFilename({
        title: request.title,
        url: key,
        ext: file.ext,
        index: request.index,
      })
      const savedFile = await saveBlobFile(parts, file.mime, filename)
      if (!host.still(controller)) return
      if (!savedFile.ok) {
        const message = saved.length > 0 ? DASH_TEXT.audioSaveFailed : savedFile.error
        await settleJob(() =>
          host.write(key, job({ phase: 'failed', message, completed: total, total, warning: plan.warning }), controller),
        )
        return
      }
      saved.push(filename)
      console.info('[media-grabber] DASH 已保存', savedFile.downloadId, filename)
    }

    await host.write(
      key,
      job({
        phase: 'complete',
        message: plan.separateAudio ? DASH_TEXT.separateDone : HLS_TEXT.complete,
        completed: total,
        total,
        warning: plan.warning,
      }),
      controller,
    )
  } catch (error) {
    if (!host.still(controller)) return
    if (signal.aborted) {
      await settleJob(() =>
        host.write(key, job({ phase: 'cancelled', message: HLS_TEXT.cancelled, completed: 0, total: 0 }), controller),
      )
      return
    }
    warn('DASH 下载失败', error)
    await settleJob(() =>
      host.write(
        key,
        job({ phase: 'failed', message: inspectFailureMessage(error), completed: 0, total: 0 }),
        controller,
      ),
    )
  } finally {
    host.clear(controller)
  }
}

export function startDashDownload(request: DashRequest, host: DashHost): { ok: true } | { ok: false; error: string } {
  const busy = host.busyOther(request.playlistUrl)
  if (busy) return { ok: false, error: busy }
  host.abortSame(request.playlistUrl)
  const controller = new AbortController()
  host.setActive(request.playlistUrl, controller)
  void runDash(request, controller, host).catch((error: unknown) => {
    warn('DASH 下载任务异常', error)
  })
  return { ok: true }
}
