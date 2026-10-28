/**
 * 在后台下载页里保存 B 站的视频和音频。
 * 两路都下到时默认合并成一个 mp4。合并失败、超过 1GB，或用户选择分开时，仍各存一个文件。
 * fetch 只在大文件分段时带 Range，其它请求头不在这里设置。
 * 进度和保存文件都交给调用方，这里不碰扩展 API。
 */

import {
  BILIBILI_TEXT,
  type BilibiliDownloadFile,
} from '../shared/bilibili'
import { fetchBilibiliFile, type BilibiliFetchResult } from '../shared/bilibili-file'
import { DASH_TEXT } from '../shared/dash-text'
import { FMP4_MERGE_TEXT } from '../shared/fmp4-merge'
import { buildDownloadFilename } from '../shared/filename'
import { formatBytes, slidingMegabyteRate } from '../shared/format'
import { HLS_TEXT } from '../shared/hls'
import type { FetchLike } from '../shared/hls-fetch'
import type { HlsJobRecord } from '../shared/hls-job'
import type { BilibiliRole } from '../shared/types'
import { inspectFailureMessage, settleJob } from './failure'
import { saveVideoAndAudio } from './merged-save'
import { saveBlobFile } from './runtime-bridge'

export interface BilibiliRunRequest {
  key: string
  files: BilibiliDownloadFile[]
  title?: string
  index?: number
  /** 用户勾选了分开保存。默认合并。 */
  separate?: boolean
}

export interface BilibiliHost {
  still(controller: AbortController): boolean
  clear(controller: AbortController): void
  write(key: string, record: HlsJobRecord, controller?: AbortController): Promise<void>
}

export interface BilibiliOutcome {
  ok: boolean
  error?: string
  cancelled?: boolean
}

export interface BilibiliRunDeps {
  fetchImpl?: FetchLike
  save?: typeof saveBlobFile
}

const PROGRESS_TOTAL = 1000

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
  return record
}

function roleText(role: BilibiliRole): string {
  if (role === 'audio') return '音频'
  if (role === 'unknown') return '文件'
  return '视频'
}

/** 弹窗上的进度。速度是最近几秒的滑动平均，样本不够时只显示已有的字节。 */
export function bilibiliProgressText(
  role: BilibiliRole,
  received: number,
  total: number | undefined,
  speed?: string,
): string {
  const name = roleText(role)
  const base =
    total !== undefined && total > 0
      ? `正在下载${name} ${formatBytes(received)} / ${formatBytes(total)}`
      : `正在下载${name} ${formatBytes(received)}`
  if (!speed) return base
  return `${base}（${speed}）`
}

function spanOf(index: number, count: number): { start: number; end: number } {
  const start = Math.round((index * PROGRESS_TOTAL) / count)
  const end = Math.round(((index + 1) * PROGRESS_TOTAL) / count)
  return { start, end }
}

function audioFailed(error: string): string {
  return `${DASH_TEXT.audioSaveFailed}：${error}`
}

export async function runBilibiliDownload(
  request: BilibiliRunRequest,
  controller: AbortController,
  host: BilibiliHost,
  deps: BilibiliRunDeps = {},
): Promise<BilibiliOutcome> {
  const signal = controller.signal
  const key = request.key
  const save = deps.save ?? saveBlobFile
  let savedVideo = false
  let warning: string | undefined
  try {
    if (request.files.length === 0) {
      await host.write(key, job({ phase: 'failed', message: BILIBILI_TEXT.badMedia, completed: 0, total: 0 }), controller)
      return { ok: false, error: BILIBILI_TEXT.badMedia }
    }
    await host.write(
      key,
      job({ phase: 'downloading', message: BILIBILI_TEXT.preparing, completed: 0, total: PROGRESS_TOTAL }),
      controller,
    )
    const notes: string[] = []
    const wantMerge =
      request.separate !== true &&
      request.files.length === 2 &&
      request.files.filter((file) => file.role === 'audio').length === 1
    const held: Array<{ url: string; role: BilibiliRole; bytes: Uint8Array; ext: string; mime: string }> = []
    const withNotes = (message: string): string => (notes.length > 0 ? `${message}。${notes.join(' ')}` : message)
    /** 合并前音频失败或取消时，先把已经下完的视频落盘，避免白下。 */
    const keepVideo = async (): Promise<BilibiliOutcome | undefined> => {
      if (!wantMerge || savedVideo) return undefined
      const videoHeld = held.find((item) => item.role !== 'audio')
      if (!videoHeld) return undefined
      const filename = buildDownloadFilename({
        title: request.title,
        url: videoHeld.url,
        ext: videoHeld.ext,
        index: request.index,
      })
      const saved = await save([videoHeld.bytes], videoHeld.mime, filename)
      if (!host.still(controller)) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
      if (!saved.ok) {
        await settleJob(() =>
          host.write(
            key,
            job({ phase: 'failed', message: saved.error, completed: 0, total: PROGRESS_TOTAL, warning }),
            controller,
          ),
        )
        return { ok: false, error: saved.error }
      }
      savedVideo = true
      console.info('[media-grabber] B站文件已保存', saved.downloadId, filename)
      return undefined
    }
    for (let index = 0; index < request.files.length; index += 1) {
      const file = request.files[index]
      if (!file) continue
      if (!host.still(controller)) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
      const bounds = spanOf(index, request.files.length)
      let lastPaint = 0
      const rateSamples: Array<{ at: number; bytes: number }> = []
      const fetched: BilibiliFetchResult = await fetchBilibiliFile(file.url, signal, {
        fetchImpl: deps.fetchImpl,
        role: file.role,
        onProgress(received, total) {
          const now = Date.now()
          const speed = slidingMegabyteRate(rateSamples, now, received)
          if (now - lastPaint < 200 && received !== total) return
          lastPaint = now
          const fraction = total && total > 0 ? Math.min(1, received / total) : 0
          const completed = bounds.start + Math.round((bounds.end - bounds.start) * fraction)
          if (!host.still(controller)) return
          void host
            .write(
              key,
              job({
                phase: 'downloading',
                message: bilibiliProgressText(file.role, received, total, speed),
                completed,
                total: PROGRESS_TOTAL,
                warning,
              }),
              controller,
            )
            .catch((error: unknown) => {
              warn('写入进度失败', error)
            })
        },
      })
      if (!host.still(controller) || signal.aborted) {
        const kept = await keepVideo()
        if (kept) return kept
        const message = savedVideo ? BILIBILI_TEXT.audioCancelled : HLS_TEXT.cancelled
        await settleJob(() =>
          host.write(
            key,
            job({ phase: 'cancelled', message, completed: bounds.start, total: PROGRESS_TOTAL, warning }),
            controller,
          ),
        )
        return { ok: false, cancelled: true, error: message }
      }
      if (!fetched.ok) {
        const kept = await keepVideo()
        if (kept) return kept
        const message = savedVideo ? audioFailed(fetched.error) : fetched.error
        await settleJob(() =>
          host.write(
            key,
            job({
              phase: fetched.cancelled ? 'cancelled' : 'failed',
              message,
              completed: bounds.start,
              total: PROGRESS_TOTAL,
              warning,
            }),
            controller,
          ),
        )
        return { ok: false, cancelled: fetched.cancelled, error: message }
      }
      if (fetched.file.warning) warning = fetched.file.warning
      if (fetched.file.note) notes.push(fetched.file.note)
      if (wantMerge) {
        held.push({
          url: file.url,
          role: file.role,
          bytes: fetched.file.bytes,
          ext: fetched.file.ext,
          mime: fetched.file.mime,
        })
        continue
      }
      const filename = buildDownloadFilename({
        title: request.title,
        url: file.url,
        ext: fetched.file.ext,
        index: request.index,
      })
      const saved = await save([fetched.file.bytes], fetched.file.mime, filename)
      if (!host.still(controller)) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
      if (!saved.ok) {
        const message = savedVideo ? audioFailed(saved.error) : saved.error
        await settleJob(() =>
          host.write(
            key,
            job({ phase: 'failed', message, completed: bounds.end, total: PROGRESS_TOTAL, warning }),
            controller,
          ),
        )
        return { ok: false, error: message }
      }
      if (file.role !== 'audio') savedVideo = true
      console.info('[media-grabber] B站文件已保存', saved.downloadId, filename)
    }

    let message: string = HLS_TEXT.complete
    if (wantMerge) {
      const audioHeld = held.find((item) => item.role === 'audio')
      const videoHeld = held.find((item) => item.role !== 'audio')
      if (!audioHeld || !videoHeld) {
        for (const item of held) {
          const filename = buildDownloadFilename({
            title: request.title,
            url: item.url,
            ext: item.ext,
            index: request.index,
          })
          const saved = await save([item.bytes], item.mime, filename)
          if (!host.still(controller)) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
          if (!saved.ok) {
            await settleJob(() =>
              host.write(
                key,
                job({ phase: 'failed', message: saved.error, completed: PROGRESS_TOTAL, total: PROGRESS_TOTAL, warning }),
                controller,
              ),
            )
            return { ok: false, error: saved.error }
          }
        }
        message = FMP4_MERGE_TEXT.failed('没有一路视频和一路音频')
      } else {
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
                completed: PROGRESS_TOTAL,
                total: PROGRESS_TOTAL,
                warning,
              }),
              controller,
            ),
          save,
          video: {
            parts: [videoHeld.bytes],
            mime: videoHeld.mime,
            filename: buildDownloadFilename({
              title: request.title,
              url: videoHeld.url,
              ext: videoHeld.ext,
              index: request.index,
            }),
          },
          audio: {
            parts: [audioHeld.bytes],
            mime: audioHeld.mime,
            filename: buildDownloadFilename({
              title: request.title,
              url: audioHeld.url,
              ext: audioHeld.ext,
              index: request.index,
            }),
          },
          mergedFilename: buildDownloadFilename({
            title: request.title,
            url: videoHeld.url,
            ext: 'mp4',
            index: request.index,
          }),
        })
        if (!outcome.ok) {
          const cancelled = 'cancelled' in outcome && outcome.cancelled === true
          await settleJob(() =>
            host.write(
              key,
              job({
                phase: cancelled ? 'cancelled' : 'failed',
                message: outcome.error,
                completed: PROGRESS_TOTAL,
                total: PROGRESS_TOTAL,
                warning,
              }),
              controller,
            ),
          )
          const failure: BilibiliOutcome = { ok: false, error: outcome.error }
          if (cancelled) failure.cancelled = true
          return failure
        }
        message = outcome.message
      }
    } else if (request.files.length > 1) {
      message = request.separate === true ? FMP4_MERGE_TEXT.separateChosen : FMP4_MERGE_TEXT.failed('没有一路视频和一路音频')
    }
    message = withNotes(message)
    await host.write(
      key,
      job({ phase: 'complete', message, completed: PROGRESS_TOTAL, total: PROGRESS_TOTAL, warning }),
      controller,
    )
    return { ok: true }
  } catch (error) {
    if (!host.still(controller) || signal.aborted) {
      const message = savedVideo ? BILIBILI_TEXT.audioCancelled : HLS_TEXT.cancelled
      await settleJob(() =>
        host.write(key, job({ phase: 'cancelled', message, completed: 0, total: PROGRESS_TOTAL }), controller),
      )
      return { ok: false, cancelled: true, error: message }
    }
    warn('B站下载失败', error)
    const message = savedVideo ? audioFailed(inspectFailureMessage(error)) : inspectFailureMessage(error)
    await settleJob(() =>
      host.write(key, job({ phase: 'failed', message, completed: 0, total: 0, warning }), controller),
    )
    return { ok: false, error: message }
  } finally {
    host.clear(controller)
  }
}
