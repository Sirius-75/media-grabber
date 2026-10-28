/**
 * 视频和音频都已经在内存里。默认合成一个 mp4。
 * 用户选择分开、合计超过 1GB，或合并器拒绝时，仍按原来的方式存两个文件。
 * 合并过程中取消则不保存。这里不调用扩展 API，保存由调用方注入。
 */

import { DASH_TEXT } from '../shared/dash-text'
import { FMP4_MERGE_TEXT, fmp4MergeExceedsLimit, mergeFmp4 } from '../shared/fmp4-merge'
import { HLS_TEXT } from '../shared/hls'

export interface MergeSaveFile {
  parts: Uint8Array[]
  mime: string
  filename: string
}

export interface MergeSaveDeps {
  separate: boolean
  signal: AbortSignal
  still(): boolean
  writeMerging(): Promise<void>
  save(
    parts: Uint8Array[],
    mime: string,
    filename: string,
  ): Promise<{ ok: true; downloadId: number } | { ok: false; error: string }>
  video: MergeSaveFile
  audio: MergeSaveFile
  mergedFilename: string
}

export type MergeSaveOutcome =
  | { ok: true; message: string }
  | { ok: false; cancelled: true; error: string }
  | { ok: false; error: string; videoSaved: boolean }

function byteLength(parts: Uint8Array[]): number {
  let total = 0
  for (const part of parts) total += part.byteLength
  return total
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(byteLength(parts))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function yieldTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function saveBoth(deps: MergeSaveDeps, message: string): Promise<MergeSaveOutcome> {
  const video = await deps.save(deps.video.parts, deps.video.mime, deps.video.filename)
  if (!deps.still() || deps.signal.aborted) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
  if (!video.ok) return { ok: false, error: video.error, videoSaved: false }
  const audio = await deps.save(deps.audio.parts, deps.audio.mime, deps.audio.filename)
  if (!deps.still() || deps.signal.aborted) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
  if (!audio.ok) return { ok: false, error: `${DASH_TEXT.audioSaveFailed}：${audio.error}`, videoSaved: true }
  return { ok: true, message }
}

export async function saveVideoAndAudio(deps: MergeSaveDeps): Promise<MergeSaveOutcome> {
  if (deps.separate) return saveBoth(deps, FMP4_MERGE_TEXT.separateChosen)
  if (fmp4MergeExceedsLimit(byteLength(deps.video.parts), byteLength(deps.audio.parts))) {
    return saveBoth(deps, FMP4_MERGE_TEXT.tooLarge)
  }
  const video = concatBytes(deps.video.parts)
  const audio = concatBytes(deps.audio.parts)
  await deps.writeMerging()
  await yieldTurn()
  if (!deps.still() || deps.signal.aborted) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
  let merged: ReturnType<typeof mergeFmp4>
  try {
    merged = mergeFmp4(video, audio, { shouldAbort: () => deps.signal.aborted || !deps.still() })
  } catch {
    return saveBoth(deps, FMP4_MERGE_TEXT.failed('合并时出现内部错误'))
  }
  if (!deps.still() || deps.signal.aborted || (!merged.ok && merged.cancelled)) {
    return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
  }
  if (!merged.ok) return saveBoth(deps, FMP4_MERGE_TEXT.failed(merged.error))
  const saved = await deps.save([merged.bytes], 'video/mp4', deps.mergedFilename)
  if (!deps.still() || deps.signal.aborted) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
  if (!saved.ok) return { ok: false, error: saved.error, videoSaved: false }
  return { ok: true, message: FMP4_MERGE_TEXT.merged }
}
