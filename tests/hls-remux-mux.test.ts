import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HLS_TEXT } from '../src/shared/hls'
import { planHlsSave, remuxTsSegments } from '../src/shared/hls-remux'
import { transmuxTsSegment } from '../src/shared/hls-remux-mux'

/** mux.js 自带的短 TS，用来确认转封装真的写出 fMP4，而不是只测了假的注入函数。 */
const SAMPLE = 'node_modules/mux.js/test/segments/test-middle-pat-pmt.ts'

function concat(parts: readonly Uint8Array[]): Uint8Array {
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

interface InitDurations {
  movieTimescale?: number
  mvhd?: { timescale: number; duration: number }
  tracks: Array<{ tkhd: number; mdhd: number; mdhdTimescale: number }>
}

/** 只读初始化段里的 mvhd / tkhd / mdhd，用来核对 mux.js 写出的未知时长有没有被改掉。 */
function readInitDurations(bytes: Uint8Array): InitDurations {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const result: InitDurations = { tracks: [] }
  let pendingTkhd: number | undefined

  const visit = (start: number, end: number, descend: boolean): void => {
    let offset = start
    while (offset + 8 <= end) {
      let size = view.getUint32(offset)
      const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0)
      let header = 8
      if (size === 1) {
        if (offset + 16 > end) return
        const large = view.getBigUint64(offset + 8)
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return
        size = Number(large)
        header = 16
      } else if (size === 0) {
        size = end - offset
      }
      if (size < header || offset + size > end) return
      const payload = offset + header
      if (type === 'mvhd' || type === 'mdhd') {
        const version = bytes[payload] ?? 0
        const timescaleAt = version === 1 ? payload + 20 : payload + 12
        const durationAt = version === 1 ? payload + 24 : payload + 16
        const durationWidth = version === 1 ? 8 : 4
        if (durationAt + durationWidth <= offset + size && (version === 0 || version === 1)) {
          const timescale = view.getUint32(timescaleAt)
          const duration = version === 1 ? Number(view.getBigUint64(durationAt)) : view.getUint32(durationAt)
          if (type === 'mvhd') {
            result.movieTimescale = timescale
            result.mvhd = { timescale, duration }
          } else if (pendingTkhd !== undefined) {
            result.tracks.push({ tkhd: pendingTkhd, mdhd: duration, mdhdTimescale: timescale })
            pendingTkhd = undefined
          }
        }
      } else if (type === 'tkhd') {
        const version = bytes[payload] ?? 0
        const durationAt = version === 1 ? payload + 28 : payload + 20
        const durationWidth = version === 1 ? 8 : 4
        if (durationAt + durationWidth <= offset + size && (version === 0 || version === 1)) {
          pendingTkhd = version === 1 ? Number(view.getBigUint64(durationAt)) : view.getUint32(durationAt)
        }
      }
      if (descend && (type === 'moov' || type === 'trak' || type === 'mdia')) visit(payload, offset + size, true)
      offset += size
    }
  }
  visit(0, bytes.byteLength, true)
  return result
}

function boxTimes(bytes: Uint8Array, type: string): number[] {
  const times: number[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const walk = (start: number, end: number): void => {
    let offset = start
    while (offset + 8 <= end) {
      let size = view.getUint32(offset)
      const name = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
      )
      let header = 8
      if (size === 1 && offset + 16 <= end) {
        size = Number(view.getBigUint64(offset + 8))
        header = 16
      }
      if (size < header || offset + size > end) return
      if (name === type) {
        const version = bytes[offset + header]
        const time =
          version === 1 ? Number(view.getBigUint64(offset + header + 4)) : view.getUint32(offset + header + 4)
        times.push(time)
      }
      if (name === 'moof' || name === 'traf' || name === 'moov') walk(offset + header, offset + size)
      offset += size
    }
  }
  walk(0, bytes.byteLength)
  return times
}

describe('mux.js 转封装', () => {
  it('两段 TS 接成一个 fMP4，时间轴往后走', async () => {
    const segment = new Uint8Array(readFileSync(SAMPLE))
    const saved = await planHlsSave({
      container: 'ts',
      parts: [segment, segment],
      transmux: transmuxTsSegment,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.ext).toBe('mp4')
    expect(saved.mime).toBe('video/mp4')
    expect(saved.message).toBe(HLS_TEXT.complete)
    const bytes = concat(saved.parts)
    expect(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])).toBe('ftyp')
    const times = boxTimes(bytes, 'tfdt')
    expect(times.length).toBeGreaterThanOrEqual(2)
    expect(Math.min(...times)).toBe(0)
    expect(Math.max(...times)).toBeGreaterThan(0)
  })

  it('初始化段的 duration 写成真实总时长，而不是 0xFFFFFFFF', async () => {
    const segment = new Uint8Array(readFileSync(SAMPLE))
    const nexts: number[] = []
    let rawInit: Uint8Array | undefined
    const saved = await remuxTsSegments({
      segments: [segment, segment],
      transmux: (data, base, sequence) => {
        const out = transmuxTsSegment(data, base, sequence)
        if (!out) return undefined
        rawInit ??= Uint8Array.from(out.initSegment)
        nexts.push(out.nextBaseMediaDecodeTime)
        return out
      },
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok || !rawInit) return
    expect(nexts).toHaveLength(2)
    expect(nexts[1]).toBeGreaterThan(nexts[0] ?? 0)
    const raw = readInitDurations(rawInit)
    const patched = readInitDurations(saved.parts[0]!)
    expect(raw.mvhd?.duration).toBe(0xffffffff)
    expect(raw.tracks.length).toBeGreaterThan(0)
    expect(raw.tracks.every((track) => track.tkhd === 0xffffffff)).toBe(true)
    expect(patched.movieTimescale).toBe(90000)
    expect(patched.mvhd?.duration).toBe(nexts[1])
    expect(patched.mvhd?.duration).not.toBe(0xffffffff)
    expect(patched.tracks).toHaveLength(raw.tracks.length)
    for (const track of patched.tracks) {
      expect(track.tkhd).toBe(nexts[1])
      expect(track.tkhd).not.toBe(0xffffffff)
      const mdhd = Number((BigInt(nexts[1]!) * BigInt(track.mdhdTimescale) + 45000n) / 90000n)
      expect(track.mdhd).toBe(mdhd)
      expect(track.mdhd).not.toBe(0xffffffff)
    }
  })

  it('不是 TS 时退回原字节，扩展名仍是 ts', async () => {
    const original = new Uint8Array([0, 1, 2, 3, 4])
    const saved = await planHlsSave({
      container: 'ts',
      parts: [original],
      transmux: transmuxTsSegment,
    })
    expect(saved).toMatchObject({ ok: true, ext: 'ts', message: HLS_TEXT.remuxFallback })
    if (saved.ok) expect(saved.parts[0]).toBe(original)
  })
})
