import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HLS_TEXT } from '../src/shared/hls'
import { planHlsSave } from '../src/shared/hls-remux'
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
