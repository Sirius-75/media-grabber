import { describe, expect, it } from 'vitest'
import { HLS_TEXT } from '../src/shared/hls'
import {
  planHlsSave,
  remuxTsSegments,
  type TransmuxedSegment,
  type TsSegmentTransmuxer,
} from '../src/shared/hls-remux'

const init = new Uint8Array([1, 2, 3, 4])
const otherInit = new Uint8Array([9, 9, 9, 9])

function fakeTransmux(script: Array<TransmuxedSegment | undefined | 'throw'>): TsSegmentTransmuxer {
  return () => {
    const next = script.shift()
    if (next === 'throw') throw new Error('mux 坏了')
    return next
  }
}

function piece(data: number[], next: number, header: Uint8Array = init): TransmuxedSegment {
  return { initSegment: header, data: new Uint8Array(data), nextBaseMediaDecodeTime: next }
}

describe('TS 转封装计划', () => {
  it('fMP4 原样保存，不调用转封装', async () => {
    let called = false
    const parts = [new Uint8Array([7, 8])]
    const saved = await planHlsSave({
      container: 'mp4',
      parts,
      transmux: () => {
        called = true
        return undefined
      },
    })
    expect(called).toBe(false)
    expect(saved).toMatchObject({ ok: true, ext: 'mp4', mime: 'video/mp4', message: HLS_TEXT.complete })
    if (saved.ok) expect(saved.parts[0]).toBe(parts[0])
  })

  it('按顺序拼初始化段和各片，下一片接在上一片结束时间之后', async () => {
    const bases: number[] = []
    const sequences: number[] = []
    const saved = await remuxTsSegments({
      segments: [new Uint8Array([1]), new Uint8Array([2])],
      transmux: (_segment, base, sequence) => {
        bases.push(base)
        sequences.push(sequence)
        return piece([sequence + 10], (sequence + 1) * 90000)
      },
    })
    expect(bases).toEqual([0, 90000])
    expect(sequences).toEqual([0, 1])
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.parts.map((part) => [...part])).toEqual([
      [...init],
      [10],
      [11],
    ])
  })

  it('转不出数据、初始化段变了、时间轴不往前、抛错，都退回原来的 TS', async () => {
    const one = [new Uint8Array([4, 5, 6])]
    const two = [new Uint8Array([1]), new Uint8Array([2])]
    const cases: Array<{ parts: Uint8Array[]; script: Array<TransmuxedSegment | undefined | 'throw'> }> = [
      { parts: one, script: [undefined] },
      { parts: two, script: [piece([1], 90), piece([1], 180, otherInit)] },
      { parts: one, script: [piece([1], 0)] },
      { parts: one, script: ['throw'] },
    ]
    for (const entry of cases) {
      const saved = await planHlsSave({
        container: 'ts',
        parts: entry.parts,
        transmux: fakeTransmux(entry.script),
      })
      expect(saved).toMatchObject({ ok: true, ext: 'ts', message: HLS_TEXT.remuxFallback })
      if (saved.ok) expect(saved.parts.map((part) => [...part])).toEqual(entry.parts.map((part) => [...part]))
    }
  })

  it('输入大到再复制一份可能超过内存上限时，不转封装，直接存 TS', async () => {
    let called = false
    const saved = await planHlsSave({
      container: 'ts',
      parts: [new Uint8Array(8)],
      maxInputBytes: 4,
      transmux: () => {
        called = true
        return piece([1], 10)
      },
    })
    expect(called).toBe(false)
    expect(saved).toMatchObject({ ok: true, ext: 'ts', message: HLS_TEXT.remuxTooBig })
  })

  it('产出超过上限时不返回那份 mp4', async () => {
    const saved = await remuxTsSegments({
      segments: [new Uint8Array([1])],
      maxOutputBytes: 4,
      transmux: () => piece([1, 2, 3, 4, 5], 10),
    })
    expect(saved).toMatchObject({ ok: false, reason: 'too-big', error: HLS_TEXT.remuxTooBig })
  })

  it('分片之间可以取消，取消后不再转下一片', async () => {
    const controller = new AbortController()
    let calls = 0
    const saved = await remuxTsSegments({
      segments: [new Uint8Array([1]), new Uint8Array([2])],
      signal: controller.signal,
      transmux: () => {
        calls += 1
        return piece([calls], calls * 100)
      },
      yield: async () => {
        controller.abort()
      },
    })
    expect(calls).toBe(1)
    expect(saved).toEqual({ ok: false, cancelled: true })
  })

  it('开始转封装之后如果已经取消，就不保存', async () => {
    const controller = new AbortController()
    const saved = await planHlsSave({
      container: 'ts',
      parts: [new Uint8Array([1])],
      signal: controller.signal,
      onRemuxStart: () => {
        controller.abort()
      },
      transmux: () => piece([1], 10),
    })
    expect(saved).toEqual({ ok: false, cancelled: true })
  })
})
