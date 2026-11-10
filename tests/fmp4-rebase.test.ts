import { describe, expect, it } from 'vitest'
import { rebaseFmp4Parts } from '../src/shared/fmp4-rebase'
import { planHlsSave } from '../src/shared/hls-remux'
import { HLS_TEXT } from '../src/shared/hls'

interface FixtureTrack {
  id: number
  timescale: number
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength)
  new DataView(out.buffer).setUint32(0, out.byteLength)
  out.set(Array.from(type).map((char) => char.charCodeAt(0)), 4)
  out.set(payload, 8)
  return out
}

function full(version: number, flags: number, payload: Uint8Array): Uint8Array {
  return concat([u32((version << 24) | flags), payload])
}

function zeros(length: number): Uint8Array {
  return new Uint8Array(length)
}

function mvhd(timescale: number): Uint8Array {
  const payload = zeros(96)
  const view = new DataView(payload.buffer)
  view.setUint32(8, timescale)
  view.setUint32(16, 0x00010000)
  return box('mvhd', full(0, 0, payload))
}

function tkhd(trackId: number): Uint8Array {
  const payload = zeros(80)
  new DataView(payload.buffer).setUint32(8, trackId)
  return box('tkhd', full(0, 7, payload))
}

function mdhd(timescale: number, version: 0 | 1): Uint8Array {
  if (version === 0) {
    const payload = zeros(20)
    new DataView(payload.buffer).setUint32(8, timescale)
    return box('mdhd', full(0, 0, payload))
  }
  const payload = zeros(32)
  new DataView(payload.buffer).setUint32(16, timescale)
  return box('mdhd', full(1, 0, payload))
}

function trak(track: FixtureTrack, mdhdVersion: 0 | 1 = 0): Uint8Array {
  return box(
    'trak',
    concat([tkhd(track.id), box('mdia', concat([mdhd(track.timescale, mdhdVersion), box('hdlr', zeros(25))]))]),
  )
}

function initSegment(tracks: FixtureTrack[], mdhdVersion: 0 | 1 = 0): Uint8Array {
  const trexes = tracks.map((track) => box('trex', full(0, 0, concat([u32(track.id), u32(1), u32(0), u32(0), u32(0)]))))
  const moov = box(
    'moov',
    concat([mvhd(1000), ...tracks.map((track) => trak(track, mdhdVersion)), box('mvex', concat(trexes))]),
  )
  return concat([box('ftyp', concat([u32(0x69736f35), u32(0x200), u32(0x69736f35)])), moov])
}

function tfdt(value: bigint, version: 0 | 1): Uint8Array {
  return box('tfdt', full(version, 0, version === 0 ? u32(Number(value)) : u64(value)))
}

function fragment(
  times: Array<{ trackId: number; value: bigint }>,
  version: 0 | 1,
  payload: number[] = [1, 2, 3, 4],
): Uint8Array {
  const trafs = times.map((time) =>
    box(
      'traf',
      concat([box('tfhd', full(0, 0, u32(time.trackId))), tfdt(time.value, version)]),
    ),
  )
  const moof = box('moof', concat([box('mfhd', full(0, 0, u32(1))), ...trafs]))
  return concat([moof, box('mdat', new Uint8Array(payload))])
}

function readTfdtValues(parts: readonly Uint8Array[]): bigint[] {
  return readTfdtEntries(parts).map((entry) => entry.value)
}

function readTfdtEntries(parts: readonly Uint8Array[]): Array<{ version: number; value: bigint }> {
  const entries: Array<{ version: number; value: bigint }> = []
  for (const part of parts.slice(1)) {
    const view = new DataView(part.buffer, part.byteOffset, part.byteLength)
    for (let offset = 0; offset + 8 <= part.byteLength; offset += 1) {
      if (String.fromCharCode(part[offset + 4] ?? 0, part[offset + 5] ?? 0, part[offset + 6] ?? 0, part[offset + 7] ?? 0) !== 'tfdt') {
        continue
      }
      const version = part[offset + 8] ?? 0
      entries.push({
        version,
        value: version === 0 ? BigInt(view.getUint32(offset + 12)) : view.getBigUint64(offset + 12),
      })
      offset += 19
    }
  }
  return entries
}

describe('fMP4 时间轴归零', () => {
  it('version 1 多轨各自减去同一个秒数，保留音视频相对偏移', () => {
    const init = initSegment([
      { id: 1, timescale: 90000 },
      { id: 2, timescale: 48000 },
    ])
    const first = fragment(
      [
        { trackId: 1, value: 4190426910n },
        { trackId: 2, value: 2234894880n },
      ],
      1,
    )
    const second = fragment(
      [
        { trackId: 1, value: 4190474910n },
        { trackId: 2, value: 2234942880n },
      ],
      1,
    )
    const parts = [init, first, second]
    const result = rebaseFmp4Parts(parts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rebased).toBe(true)
    expect(readTfdtValues(result.parts)).toEqual([0n, 528n, 48000n, 48528n])
  })

  it('version 0 的 32 位 tfdt 也支持，并保持 32 位写法', () => {
    const init = initSegment([{ id: 7, timescale: 90000 }])
    const first = fragment([{ trackId: 7, value: 4_000_000_000n }], 0)
    const second = fragment([{ trackId: 7, value: 4_000_090_000n }], 0)
    const parts = [init, first, second]
    const before = second.slice()
    const result = rebaseFmp4Parts(parts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rebased).toBe(true)
    expect(readTfdtValues(result.parts)).toEqual([0n, 90000n])
    expect(readTfdtEntries(result.parts).every((entry) => entry.version === 0)).toBe(true)
    expect(second.byteLength).toBe(before.byteLength)
  })

  it('本来就从 0 开始时一个字节也不改', () => {
    const init = initSegment([{ id: 1, timescale: 90000 }])
    const first = fragment([{ trackId: 1, value: 0n }], 1)
    const second = fragment([{ trackId: 1, value: 90000n }], 1)
    const snapshot = [init.slice(), first.slice(), second.slice()]
    const result = rebaseFmp4Parts([init, first, second])
    expect(result).toMatchObject({ ok: true, rebased: false })
    if (!result.ok) return
    expect(result.parts.map((part) => [...part])).toEqual(snapshot.map((part) => [...part]))
  })

  it('初始化段缺失、损坏或分片结构不对时返回错误，不留下改了一半的字节', () => {
    const goodInit = initSegment([{ id: 1, timescale: 90000 }])
    const goodFirst = fragment([{ trackId: 1, value: 90000n }], 1)
    const snapshot = goodFirst.slice()
    const cases: Uint8Array[][] = [
      [],
      [new Uint8Array([0, 0, 0, 1])],
      [concat([goodInit, new Uint8Array([0, 0, 0, 8])]), goodFirst],
      [goodInit, goodFirst.slice(0, 20)],
      [goodInit, fragment([{ trackId: 9, value: 90000n }], 1)],
    ]
    for (const parts of cases) {
      const result = rebaseFmp4Parts(parts)
      expect(result.ok).toBe(false)
    }
    expect([...goodFirst]).toEqual([...snapshot])
  })

  it('没有 tfdt 的 fMP4 原样返回', () => {
    const init = initSegment([{ id: 1, timescale: 90000 }])
    const noTfdt = concat([
      box(
        'moof',
        concat([
          box('mfhd', full(0, 0, u32(1))),
          box('traf', box('tfhd', full(0, 0, u32(1)))),
        ]),
      ),
      box('mdat', new Uint8Array([9, 9])),
    ])
    const result = rebaseFmp4Parts([init, noTfdt])
    expect(result).toMatchObject({ ok: true, rebased: false })
  })

  it('planHlsSave 的 mp4 路径会调用归零，解析失败则原样保存', async () => {
    const init = initSegment([{ id: 1, timescale: 90000 }])
    const media = fragment([{ trackId: 1, value: 4190426910n }], 1)
    const saved = await planHlsSave({
      container: 'mp4',
      parts: [init, media],
      transmux: () => undefined,
    })
    expect(saved).toMatchObject({ ok: true, ext: 'mp4', mime: 'video/mp4', message: HLS_TEXT.complete })
    if (saved.ok) expect(readTfdtValues(saved.parts)).toEqual([0n])

    const broken = await planHlsSave({
      container: 'mp4',
      parts: [new Uint8Array([1, 2, 3]), new Uint8Array([4])],
      transmux: () => undefined,
    })
    expect(broken).toMatchObject({ ok: true, ext: 'mp4', message: HLS_TEXT.complete })
    if (broken.ok) expect(broken.parts.map((part) => [...part])).toEqual([[1, 2, 3], [4]])
  })

  it('超过转封装输入上限时仍然归零（原地改 tfdt，不复制）', async () => {
    const init = initSegment([{ id: 1, timescale: 90000 }])
    const media = fragment([{ trackId: 1, value: 4190426910n }], 1)
    const saved = await planHlsSave({
      container: 'mp4',
      parts: [init, media],
      transmux: () => undefined,
      maxInputBytes: 8,
    })
    expect(saved).toMatchObject({ ok: true, ext: 'mp4', message: HLS_TEXT.complete })
    if (saved.ok) {
      expect(readTfdtValues(saved.parts)).toEqual([0n])
      expect(saved.parts[1]).toBe(media)
    }
  })
})
