/**
 * 用 mux.js 6 把一片 MPEG-TS 转成 fMP4。
 * 只做转封装，不重新编码。mux.js 认 H.264 和 AAC；H.265、AC-3 这些会转不出数据。
 *
 * 每一片新建一个 Transmuxer，并把 baseMediaDecodeTime 设成时间轴上的起点。
 * 库自己的 setBaseMediaDecodeTime 不会改已经建好的轨，所以不能复用同一个实例来接下一片。
 *
 * mux.js 版权归 Brightcove，协议 Apache-2.0：https://github.com/videojs/mux.js
 */

import { Transmuxer } from 'mux.js/lib/mp4/transmuxer'
import type { TransmuxedSegment, TsSegmentTransmuxer } from './hls-remux'

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export const transmuxTsSegment: TsSegmentTransmuxer = (segment, baseMediaDecodeTime, sequenceNumber) => {
  const transmuxer = new Transmuxer({
    baseMediaDecodeTime,
    remux: true,
    keepOriginalTimestamps: false,
    firstSequenceNumber: sequenceNumber,
  })
  const inits: Uint8Array[] = []
  const media: Uint8Array[] = []
  let videoEnd: number | undefined
  let audioEnd: number | undefined
  transmuxer.on('data', (piece) => {
    if (piece.initSegment && piece.initSegment.byteLength > 0) inits.push(piece.initSegment)
    if (piece.data && piece.data.byteLength > 0) media.push(piece.data)
  })
  transmuxer.on('videoSegmentTimingInfo', (info) => {
    if (Number.isFinite(info.end?.dts)) videoEnd = info.end.dts
  })
  transmuxer.on('audioSegmentTimingInfo', (info) => {
    if (Number.isFinite(info.end?.dts)) audioEnd = info.end.dts
  })
  transmuxer.push(segment)
  transmuxer.flush()

  const initSegment = inits[0]
  if (!initSegment || media.length === 0) return undefined
  for (const extra of inits.slice(1)) {
    if (!sameBytes(initSegment, extra)) return undefined
  }
  // 有视频时以视频结束时间为准。只有声音时，事件里的 dts 也已经换算成 90kHz。
  const next = videoEnd ?? audioEnd
  if (next === undefined || !Number.isFinite(next)) return undefined
  const result: TransmuxedSegment = {
    initSegment,
    data: media.length === 1 ? media[0] : concatBytes(media),
    nextBaseMediaDecodeTime: Math.round(next),
  }
  return result
}
