/**
 * 在 offscreen 文档里下载 DASH 分片。
 * 不在 service worker 里跑。不设置请求头。
 * 视频和音频默认合并成一个 mp4。合并失败、超过 1GB，或用户选择分开时，仍各存一份。
 * 拼好的 Blob 交给后台保存。这里不调用下载 API。
 */

import { describeDashFetchFailure, parseMpd, planDashDownload } from '../shared/dash'
import { DASH_TEXT } from '../shared/dash-text'
import { FMP4_MERGE_TEXT } from '../shared/fmp4-merge'
import { buildDownloadFilename } from '../shared/filename'
import { downloadSegmentsInOrder } from '../shared/hls-download'
import { fetchPlaylistText, fetchSegmentBytes } from '../shared/hls-fetch'
import { HLS_TEXT, describePlaylistStatus, hlsProgressText } from '../shared/hls'
import type { HlsJobRecord } from '../shared/hls-job'
import { inspectFailureMessage, settleJob } from './failure'
import { saveVideoAndAudio } from './merged-save'
import { saveBlobFile } from './runtime-bridge'

export interface DashRequest {
  playlistUrl: string
  representationId?: string
  title?: string
  index?: number
  /** 用户勾选了分开保存。默认合并。 */
  separate?: boolean
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

function chosenWarning(warning: string | undefined, separate: boolean): string | undefined {
  if (!warning || !separate) return warning
  if (!warning.includes(DASH_TEXT.separatePlan)) return warning
  return warning.split(DASH_TEXT.separatePlan).join(DASH_TEXT.separateChosenPlan)
}

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

export async function inspectDash(playlistUrl: string, host: DashHost, separate = false): Promise<unknown> {
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
          warning: chosenWarning(plan.warning, separate),
          variants: plan.variants,
        }),
      )
      const response: { ok: true; kind: 'master'; variants: typeof plan.variants; warning?: string } = {
        ok: true,
        kind: 'master',
        variants: plan.variants,
      }
      const warning = chosenWarning(plan.warning, separate)
      if (warning) response.warning = warning
      return response
    }
    const response: { ok: true; kind: 'media'; total: number; container: 'mp4'; warning?: string } = {
      ok: true,
      kind: 'media',
      total: plan.total,
      container: 'mp4',
    }
    const warning = chosenWarning(plan.warning, separate)
    if (warning) response.warning = warning
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
    const warning = chosenWarning(plan.warning, request.separate === true)
    if (warning) plan.warning = warning
    else delete plan.warning

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
    const groups = plan.files.map((file) => {
      const parts = result.parts.slice(offset, offset + file.urls.length)
      offset += file.urls.length
      return { file, parts }
    })
    const videoGroup = groups.find((group) => group.file.kind === 'video')
    const audioGroup = groups.find((group) => group.file.kind === 'audio')
    const wantMerge = request.separate !== true && groups.length === 2 && videoGroup !== undefined && audioGroup !== undefined
    if (wantMerge && videoGroup && audioGroup) {
      const outcome = await saveVideoAndAudio({
        separate: false,
        signal,
        still: () => host.still(controller),
        writeMerging: () =>
          host.write(
            key,
            job({
              phase: 'merging',
              message: FMP4_MERGE_TEXT.merging,
              completed: total,
              total,
              warning: plan.warning,
            }),
            controller,
          ),
        save: saveBlobFile,
        video: {
          parts: videoGroup.parts,
          mime: videoGroup.file.mime,
          filename: buildDownloadFilename({ title: request.title, url: key, ext: videoGroup.file.ext, index: request.index }),
        },
        audio: {
          parts: audioGroup.parts,
          mime: audioGroup.file.mime,
          filename: buildDownloadFilename({ title: request.title, url: key, ext: audioGroup.file.ext, index: request.index }),
        },
        mergedFilename: buildDownloadFilename({ title: request.title, url: key, ext: 'mp4', index: request.index }),
      })
      if (!host.still(controller)) return
      if (!outcome.ok) {
        await settleJob(() =>
          host.write(
            key,
            job({
              phase: 'cancelled' in outcome && outcome.cancelled ? 'cancelled' : 'failed',
              message: outcome.error,
              completed: total,
              total,
              warning: plan.warning,
            }),
            controller,
          ),
        )
        return
      }
      await host.write(
        key,
        job({ phase: 'complete', message: outcome.message, completed: total, total, warning: plan.warning }),
        controller,
      )
      return
    }

    const saved: string[] = []
    for (const group of groups) {
      const filename = buildDownloadFilename({
        title: request.title,
        url: key,
        ext: group.file.ext,
        index: request.index,
      })
      const savedFile = await saveBlobFile(group.parts, group.file.mime, filename)
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

    const separateMessage =
      request.separate === true && plan.separateAudio ? FMP4_MERGE_TEXT.separateChosen : HLS_TEXT.complete
    await host.write(
      key,
      job({
        phase: 'complete',
        message: separateMessage,
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
