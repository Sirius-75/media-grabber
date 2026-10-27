import { describe, expect, it } from 'vitest'
import { patchInitSegmentDuration } from '../src/shared/hls-remux-duration'
import { remuxTsSegments } from '../src/shared/hls-remux'

/** 和实现相同的四舍五入，下面有几组手算结果把它钉死。 */
function expectedDuration(total90k: number, timescale: number): bigint {
  return (BigInt(total90k) * BigInt(timescale) + 45000n) / 90000n
}

interface Field {
  offset: number
  width: 4 | 8
  kind: 'mvhd' | 'tkhd' | 'mdhd'
  timescale?: number
}

interface Built {
  bytes: Uint8Array
  fields: Field[]
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function u64(value: bigint): number[] {
  const out: number[] = []
  for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((value >> shift) & 0xffn))
  return out
}

function leaf(
  type: string,
  payload: number[],
  fields: Array<{ at: number; width: 4 | 8; kind: Field['kind']; timescale?: number }>,
  header: 8 | 16 = 8,
): Built {
  const size = header + payload.length
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  if (header === 16) {
    view.setUint32(0, 1)
    view.setBigUint64(8, BigInt(size))
  } else {
    view.setUint32(0, size)
  }
  bytes.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4)
  bytes.set(payload, header)
  return {
    bytes,
    fields: fields.map((field) => ({
      offset: header + field.at,
      width: field.width,
      kind: field.kind,
      timescale: field.timescale,
    })),
  }
}

function nest(type: string, children: Built[], header: 8 | 16 = 8): Built {
  const payloadLength = children.reduce((sum, child) => sum + child.bytes.byteLength, 0)
  const size = header + payloadLength
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  if (header === 16) {
    view.setUint32(0, 1)
    view.setBigUint64(8, BigInt(size))
  } else {
    view.setUint32(0, size)
  }
  bytes.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4)
  const fields: Field[] = []
  let offset = header
  for (const child of children) {
    bytes.set(child.bytes, offset)
    for (const field of child.fields) fields.push({ ...field, offset: field.offset + offset })
    offset += child.bytes.byteLength
  }
  return { bytes, fields }
}

function sequence(parts: Built[]): Built {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.bytes.byteLength, 0))
  const fields: Field[] = []
  let offset = 0
  for (const part of parts) {
    bytes.set(part.bytes, offset)
    for (const field of part.fields) fields.push({ ...field, offset: field.offset + offset })
    offset += part.bytes.byteLength
  }
  return { bytes, fields }
}

function mvhd(version: 0 | 1, timescale: number, header: 8 | 16 = 8): Built {
  if (version === 0) {
    return leaf(
      'mvhd',
      [
        0x00, 0x11, 0x22, 0x33,
        0x01, 0x02, 0x03, 0x04,
        0x05, 0x06, 0x07, 0x08,
        ...u32(timescale),
        ...u32(0xffffffff),
        0xab, 0xcd,
      ],
      [{ at: 16, width: 4, kind: 'mvhd', timescale }],
      header,
    )
  }
  return leaf(
    'mvhd',
    [
      0x01, 0x11, 0x22, 0x33,
      ...u64(0x0102030405060708n),
      ...u64(0x1112131415161718n),
      ...u32(timescale),
      ...u64(0xffffffffffffffffn),
      0xab, 0xcd,
    ],
    [{ at: 24, width: 8, kind: 'mvhd', timescale }],
    header,
  )
}

function tkhd(version: 0 | 1, trackId: number): Built {
  if (version === 0) {
    return leaf(
      'tkhd',
      [
        0x00, 0x00, 0x00, 0x07,
        0x10, 0x11, 0x12, 0x13,
        0x14, 0x15, 0x16, 0x17,
        ...u32(trackId),
        0x00, 0x00, 0x00, 0x00,
        ...u32(0xffffffff),
        0x5a, 0xa5,
      ],
      [{ at: 20, width: 4, kind: 'tkhd' }],
    )
  }
  return leaf(
    'tkhd',
    [
      0x01, 0x00, 0x00, 0x03,
      ...u64(0x2222222222222222n),
      ...u64(0x3333333333333333n),
      ...u32(trackId),
      0x00, 0x00, 0x00, 0x00,
      ...u64(0xffffffffffffffffn),
      0x5a, 0xa5,
    ],
    [{ at: 28, width: 8, kind: 'tkhd' }],
  )
}

function mdhd(version: 0 | 1, timescale: number): Built {
  if (version === 0) {
    return leaf(
      'mdhd',
      [
        0x00, 0x00, 0x00, 0x00,
        0x21, 0x22, 0x23, 0x24,
        0x25, 0x26, 0x27, 0x28,
        ...u32(timescale),
        ...u32(0xffffffff),
        0x55, 0xc4, 0x00, 0x00,
      ],
      [{ at: 16, width: 4, kind: 'mdhd', timescale }],
    )
  }
  return leaf(
    'mdhd',
    [
      0x01, 0x00, 0x00, 0x00,
      ...u64(0x4444444444444444n),
      ...u64(0x5555555555555555n),
      ...u32(timescale),
      ...u64(0xffffffffffffffffn),
      0x55, 0xc4, 0x00, 0x00,
    ],
    [{ at: 24, width: 8, kind: 'mdhd', timescale }],
  )
}

function trak(version: 0 | 1, trackId: number, timescale: number): Built {
  return nest('trak', [
    tkhd(version, trackId),
    leaf('free', [0xee], []),
    nest('mdia', [mdhd(version, timescale), leaf('hdlr', [0xaa, 0xbb, 0xcc], [])]),
  ])
}

function buildInit(options: {
  movieVersion: 0 | 1
  movieTimescale: number
  tracks: Array<{ id: number; timescale: number; version: 0 | 1 }>
  mvhdFirst?: boolean
  largesizeMoov?: boolean
}): Built {
  const header = mvhd(options.movieVersion, options.movieTimescale)
  const tracks = options.tracks.map((track) => trak(track.version, track.id, track.timescale))
  const moovChildren = options.mvhdFirst === false ? [...tracks, header] : [header, ...tracks]
  moovChildren.push(leaf('mvex', [0x01, 0x02, 0x03, 0x04], []))
  const moov = nest('moov', moovChildren, options.largesizeMoov ? 16 : 8)
  const ftyp = leaf('ftyp', [0x69, 0x73, 0x6f, 0x6d, 0xde, 0xad], [])
  const free = leaf('free', [0xbe, 0xef], [])
  const moof = leaf('moof', [0xff, 0xff, 0xff, 0xff, 0x01, 0x02], [])
  return sequence([ftyp, moov, free, moof])
}

function readField(bytes: Uint8Array, field: Field): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return field.width === 4 ? BigInt(view.getUint32(field.offset)) : view.getBigUint64(field.offset)
}

function expectOnlyDurationsChanged(original: Uint8Array, patched: Uint8Array, fields: Field[]): void {
  expect(patched).not.toBe(original)
  expect(patched.byteLength).toBe(original.byteLength)
  const covered = new Set<number>()
  for (const field of fields) {
    for (let index = 0; index < field.width; index += 1) covered.add(field.offset + index)
  }
  for (let index = 0; index < original.byteLength; index += 1) {
    if (!covered.has(index)) expect(patched[index]).toBe(original[index])
  }
}

describe('时长换算', () => {
  it('手算几组整数结果', () => {
    expect(expectedDuration(180000, 1000)).toBe(2000n)
    expect(expectedDuration(180000, 90000)).toBe(180000n)
    expect(expectedDuration(180000, 44100)).toBe(88200n)
    expect(expectedDuration(2, 44100)).toBe(1n)
    expect(expectedDuration(1, 44100)).toBe(0n)
  })
})

describe('patchInitSegmentDuration', () => {
  it('version 0：mvhd、tkhd 用 movie timescale，mdhd 用各轨 timescale', () => {
    const init = buildInit({
      movieVersion: 0,
      movieTimescale: 1000,
      tracks: [
        { id: 1, timescale: 90000, version: 0 },
        { id: 2, timescale: 44100, version: 0 },
      ],
    })
    const snapshot = Uint8Array.from(init.bytes)
    const patched = patchInitSegmentDuration(init.bytes, 180000)
    expect(Array.from(init.bytes)).toEqual(Array.from(snapshot))
    expectOnlyDurationsChanged(snapshot, patched, init.fields)
    const movie = expectedDuration(180000, 1000)
    for (const field of init.fields) {
      const timescale = field.kind === 'mdhd' ? field.timescale : 1000
      expect(readField(patched, field)).toBe(expectedDuration(180000, timescale ?? 0))
    }
    expect(movie).toBe(2000n)
    expect(init.fields.filter((field) => field.kind === 'tkhd')).toHaveLength(2)
    expect(init.fields.filter((field) => field.kind === 'mdhd').map((field) => readField(patched, field))).toEqual([
      180000n,
      88200n,
    ])
  })

  it('version 1：64 位时长按同样的比例写入', () => {
    const init = buildInit({
      movieVersion: 1,
      movieTimescale: 90000,
      tracks: [
        { id: 1, timescale: 90000, version: 1 },
        { id: 2, timescale: 44100, version: 1 },
      ],
    })
    const snapshot = Uint8Array.from(init.bytes)
    const total = 945000
    const patched = patchInitSegmentDuration(init.bytes, total)
    expect(Array.from(init.bytes)).toEqual(Array.from(snapshot))
    expectOnlyDurationsChanged(snapshot, patched, init.fields)
    for (const field of init.fields) {
      const timescale = field.kind === 'mdhd' ? field.timescale : 90000
      expect(field.width).toBe(8)
      expect(readField(patched, field)).toBe(expectedDuration(total, timescale ?? 0))
    }
    expect(readField(patched, init.fields[0]!)).toBe(945000n)
  })

  it('version 1 可以写下超过 32 位的时长', () => {
    const init = buildInit({
      movieVersion: 1,
      movieTimescale: 90000,
      tracks: [{ id: 1, timescale: 90000, version: 1 }],
    })
    const total = 2 ** 32
    const patched = patchInitSegmentDuration(init.bytes, total)
    expect(readField(patched, init.fields.find((field) => field.kind === 'mvhd')!)).toBe(BigInt(total))
    expect(readField(patched, init.fields.find((field) => field.kind === 'mdhd')!)).toBe(BigInt(total))
  })

  it('mvhd 可以排在 trak 后面，moov 也可以用 64 位 size', () => {
    const init = buildInit({
      movieVersion: 0,
      movieTimescale: 90000,
      tracks: [{ id: 1, timescale: 44100, version: 0 }],
      mvhdFirst: false,
      largesizeMoov: true,
    })
    const patched = patchInitSegmentDuration(init.bytes, 2)
    expect(readField(patched, init.fields.find((field) => field.kind === 'mvhd')!)).toBe(2n)
    expect(readField(patched, init.fields.find((field) => field.kind === 'tkhd')!)).toBe(2n)
    expect(readField(patched, init.fields.find((field) => field.kind === 'mdhd')!)).toBe(1n)
  })

  it('movie 时长装得下、音轨 version 1 装得下超过 32 位的时长时，两处都改', () => {
    const total = 4_500_000_000
    const init = buildInit({
      movieVersion: 0,
      movieTimescale: 1000,
      tracks: [{ id: 1, timescale: 90000, version: 1 }],
    })
    const patched = patchInitSegmentDuration(init.bytes, total)
    expect(readField(patched, init.fields.find((field) => field.kind === 'mvhd')!)).toBe(50_000_000n)
    expect(readField(patched, init.fields.find((field) => field.kind === 'tkhd')!)).toBe(50_000_000n)
    expect(readField(patched, init.fields.find((field) => field.kind === 'mdhd')!)).toBe(4_500_000_000n)
  })

  it('入参是大缓冲里的一段视图时，只改这段的拷贝', () => {
    const init = buildInit({
      movieVersion: 0,
      movieTimescale: 90000,
      tracks: [{ id: 1, timescale: 90000, version: 0 }],
    })
    const padded = new Uint8Array(init.bytes.byteLength + 8)
    padded[0] = 0x11
    padded[1] = 0x22
    padded.set(init.bytes, 4)
    padded[padded.byteLength - 1] = 0x33
    const view = padded.subarray(4, 4 + init.bytes.byteLength)
    const snapshot = Uint8Array.from(view)
    const patched = patchInitSegmentDuration(view, 90000)
    expect(Array.from(view)).toEqual(Array.from(snapshot))
    expect(padded[0]).toBe(0x11)
    expect(padded[1]).toBe(0x22)
    expect(padded[padded.byteLength - 1]).toBe(0x33)
    expect(readField(patched, init.fields.find((field) => field.kind === 'mvhd')!)).toBe(90000n)
  })

  it('坏数据、找不到字段、version 0 装不下时原样返回', () => {
    const good = buildInit({
      movieVersion: 0,
      movieTimescale: 90000,
      tracks: [{ id: 1, timescale: 90000, version: 0 }],
    })
    const overflow = buildInit({
      movieVersion: 0,
      movieTimescale: 90000,
      tracks: [{ id: 1, timescale: 90000, version: 0 }],
    })
    const audioOverflow = buildInit({
      movieVersion: 0,
      movieTimescale: 1000,
      tracks: [{ id: 1, timescale: 90000, version: 0 }],
    })
    const version64Overflow = buildInit({
      movieVersion: 1,
      movieTimescale: 2 ** 30,
      tracks: [],
    })
    const missingMdhd = sequence([
      leaf('ftyp', [1, 2, 3, 4], []),
      nest('moov', [mvhd(0, 90000), nest('trak', [tkhd(0, 1)])]),
    ])
    const missingMvhd = nest('moov', [leaf('free', [1, 2, 3, 4], [])])
    const badVersion = leaf(
      'mvhd',
      [0x02, 0x00, 0x00, 0x00, ...u32(1), ...u32(2), ...u32(90000), ...u32(0xffffffff)],
      [],
    )
    const zeroTimescale = sequence([
      nest('moov', [mvhd(0, 0), trak(0, 1, 90000)]),
    ])
    const truncated = new Uint8Array(16)
    const view = new DataView(truncated.buffer)
    view.setUint32(0, 1000)
    truncated.set([0x6d, 0x6f, 0x6f, 0x76], 4)
    const overrun = nest('moov', [mvhd(0, 90000)])
    overrun.bytes[0] = 0
    overrun.bytes[1] = 0
    overrun.bytes[2] = 0
    overrun.bytes[3] = 4

    const cases: Array<{ bytes: Uint8Array; total: number }> = [
      { bytes: new Uint8Array(), total: 90000 },
      { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7]), total: 90000 },
      { bytes: good.bytes, total: Number.NaN },
      { bytes: good.bytes, total: Number.POSITIVE_INFINITY },
      { bytes: good.bytes, total: -1 },
      { bytes: truncated, total: 90000 },
      { bytes: missingMvhd.bytes, total: 90000 },
      { bytes: missingMdhd.bytes, total: 90000 },
      { bytes: sequence([badVersion]).bytes, total: 90000 },
      { bytes: zeroTimescale.bytes, total: 90000 },
      { bytes: overrun.bytes, total: 90000 },
      { bytes: sequence([good, good]).bytes, total: 90000 },
      { bytes: overflow.bytes, total: 2 ** 32 },
      { bytes: audioOverflow.bytes, total: 4_500_000_000 },
      { bytes: version64Overflow.bytes, total: 2 ** 51 },
    ]
    for (const entry of cases) {
      expect(patchInitSegmentDuration(entry.bytes, entry.total)).toBe(entry.bytes)
    }
  })

  it('remuxTsSegments 用最后一片的终点修补初始化段，不改原来的字节', async () => {
    const init = buildInit({
      movieVersion: 0,
      movieTimescale: 90000,
      tracks: [
        { id: 1, timescale: 90000, version: 0 },
        { id: 2, timescale: 44100, version: 0 },
      ],
    })
    const snapshot = Uint8Array.from(init.bytes)
    const saved = await remuxTsSegments({
      segments: [new Uint8Array([1]), new Uint8Array([2])],
      transmux: (_segment, _base, sequenceNumber) => ({
        initSegment: init.bytes,
        data: new Uint8Array([sequenceNumber + 10]),
        nextBaseMediaDecodeTime: sequenceNumber === 0 ? 90000 : 180000,
      }),
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(Array.from(init.bytes)).toEqual(Array.from(snapshot))
    expect(saved.parts[0]).toEqual(patchInitSegmentDuration(init.bytes, 180000))
    expect(readField(saved.parts[0]!, init.fields.find((field) => field.kind === 'mvhd')!)).toBe(180000n)
    expect(readField(saved.parts[0]!, init.fields.find((field) => field.kind === 'mdhd')!)).toBe(180000n)
    const audio = init.fields.filter((field) => field.kind === 'mdhd')[1]
    expect(audio).toBeDefined()
    expect(readField(saved.parts[0]!, audio!)).toBe(88200n)
    expect(Array.from(saved.parts[1]!)).toEqual([10])
    expect(Array.from(saved.parts[2]!)).toEqual([11])
  })
})
