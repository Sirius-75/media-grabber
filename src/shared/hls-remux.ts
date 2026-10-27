/**
 * 把已经下好的 MPEG-TS 分片转成 mp4 的计划。
 * 不访问 chrome，也不绑定具体库。真正的转封装函数由调用方注入。
 *
 * 带 EXT-X-MAP 的 fMP4 已经是 mp4，这里原样返回，不再转一次。
 * 转封装失败、或文件大到再复制一份可能超过内存上限时，仍返回原来的 TS，
 * 让下载本身成功。取消则什么都不保存。
 *
 * 每一片单独转，下一片的时间轴接在上一片结束之后。
 * 这样 EXT-X-DISCONTINUITY 里时间戳归零也不会叠在一起。不做重编码。
 *
 * 全部转完后，用最后一片的 90kHz 终点回填初始化段里的时长。
 * mux.js 原本写成未知（0xFFFFFFFF），只读文件头的播放器会显示成约 13 小时。
 */

import { HLS_HARD_BYTE_LIMIT, HLS_TEXT } from './hls'
import { patchInitSegmentDuration } from './hls-remux-duration'

/** 转封装时内存里会同时有 TS 和 mp4。输入超过这个值就不再转，直接存 .ts。 */
export const HLS_REMUX_MAX_INPUT_BYTES = HLS_HARD_BYTE_LIMIT / 2

export interface TransmuxedSegment {
  initSegment: Uint8Array
  data: Uint8Array
  /** 下一片应该使用的 90kHz 起点。必须比这一片的起点更晚。 */
  nextBaseMediaDecodeTime: number
}

/** 转一片 TS。认不出编码时返回 undefined，不要抛出给界面。 */
export type TsSegmentTransmuxer = (
  segment: Uint8Array,
  baseMediaDecodeTime: number,
  sequenceNumber: number,
) => TransmuxedSegment | undefined

export type RemuxFailureReason = 'empty' | 'no-output' | 'init-changed' | 'timeline' | 'too-big' | 'threw'

export type RemuxTsResult =
  | { ok: true; parts: Uint8Array[] }
  | { ok: false; cancelled: true }
  | { ok: false; error: string; reason: RemuxFailureReason }

export type HlsSavePlan =
  | { ok: true; ext: 'ts' | 'mp4'; mime: string; parts: Uint8Array[]; message: string }
  | { ok: false; cancelled: true }

function totalBytes(parts: readonly Uint8Array[]): number {
  let total = 0
  for (const part of parts) total += part.byteLength
  return total
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function tsFallback(parts: readonly Uint8Array[], message: string): HlsSavePlan {
  return {
    ok: true,
    ext: 'ts',
    mime: 'video/mp2t',
    parts: [...parts],
    message,
  }
}

function failure(reason: RemuxFailureReason): RemuxTsResult {
  const error = reason === 'too-big' ? HLS_TEXT.remuxTooBig : HLS_TEXT.remuxFallback
  return { ok: false, error, reason }
}

/**
 * 按分片顺序转封装。
 * 第一片的初始化段留下，后面的必须和它一致，否则说明编码中途变了，拼不成一个文件。
 */
export async function remuxTsSegments(input: {
  segments: readonly Uint8Array[]
  transmux: TsSegmentTransmuxer
  signal?: AbortSignal
  yield?: () => Promise<void>
  maxOutputBytes?: number
}): Promise<RemuxTsResult> {
  if (input.segments.length === 0) return failure('empty')
  const maxOutputBytes = input.maxOutputBytes ?? HLS_HARD_BYTE_LIMIT
  let initSegment: Uint8Array | undefined
  const media: Uint8Array[] = []
  let baseMediaDecodeTime = 0
  let produced = 0

  for (let index = 0; index < input.segments.length; index += 1) {
    if (input.signal?.aborted) return { ok: false, cancelled: true }
    const segment = input.segments[index]
    if (!segment || segment.byteLength === 0) return failure('no-output')
    let transmuxed: TransmuxedSegment | undefined
    try {
      transmuxed = input.transmux(segment, baseMediaDecodeTime, index)
    } catch {
      return failure('threw')
    }
    if (!transmuxed?.initSegment?.byteLength || !transmuxed.data?.byteLength) return failure('no-output')
    if (!initSegment) {
      initSegment = transmuxed.initSegment
    } else if (!sameBytes(initSegment, transmuxed.initSegment)) {
      return failure('init-changed')
    }
    if (
      !Number.isFinite(transmuxed.nextBaseMediaDecodeTime) ||
      transmuxed.nextBaseMediaDecodeTime <= baseMediaDecodeTime
    ) {
      return failure('timeline')
    }
    produced += transmuxed.data.byteLength
    if (initSegment.byteLength + produced > maxOutputBytes) return failure('too-big')
    media.push(transmuxed.data)
    baseMediaDecodeTime = transmuxed.nextBaseMediaDecodeTime
    if (index < input.segments.length - 1) await input.yield?.()
  }

  if (!initSegment) return failure('no-output')
  // baseMediaDecodeTime 此刻是最后一片的 nextBaseMediaDecodeTime。
  return { ok: true, parts: [patchInitSegmentDuration(initSegment, baseMediaDecodeTime), ...media] }
}

/**
 * 决定最终保存成什么。
 * container 为 mp4 时是 fMP4 路径，分片字节和扩展名都不变。
 */
export async function planHlsSave(input: {
  container: 'ts' | 'mp4'
  parts: readonly Uint8Array[]
  transmux: TsSegmentTransmuxer
  signal?: AbortSignal
  yield?: () => Promise<void>
  onRemuxStart?: () => Promise<void> | void
  maxInputBytes?: number
  maxOutputBytes?: number
}): Promise<HlsSavePlan> {
  if (input.container === 'mp4') {
    return {
      ok: true,
      ext: 'mp4',
      mime: 'video/mp4',
      parts: [...input.parts],
      message: HLS_TEXT.complete,
    }
  }

  const maxInputBytes = input.maxInputBytes ?? HLS_REMUX_MAX_INPUT_BYTES
  if (totalBytes(input.parts) > maxInputBytes) return tsFallback(input.parts, HLS_TEXT.remuxTooBig)

  await input.onRemuxStart?.()
  if (input.signal?.aborted) return { ok: false, cancelled: true }

  const remuxed = await remuxTsSegments({
    segments: input.parts,
    transmux: input.transmux,
    signal: input.signal,
    yield: input.yield,
    maxOutputBytes: input.maxOutputBytes,
  })
  if (!remuxed.ok) {
    if ('cancelled' in remuxed) return { ok: false, cancelled: true }
    return tsFallback(input.parts, remuxed.error)
  }
  return {
    ok: true,
    ext: 'mp4',
    mime: 'video/mp4',
    parts: remuxed.parts,
    message: HLS_TEXT.complete,
  }
}
