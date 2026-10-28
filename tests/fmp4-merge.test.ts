import { describe, expect, it } from 'vitest'
import { FMP4_MERGE_MAX_BYTES, fmp4MergeExceedsLimit, mergeFmp4 } from '../src/shared/fmp4-merge'
import { buildFmp4, type FragmentPiece } from './fmp4-fixture'

function text(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0)
}

interface FoundBox {
  type: string
  start: number
  header: number
  end: number
}

function readBox(bytes: Uint8Array, offset: number, limit: number): FoundBox | null {
  if (limit - offset < 8) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size32 = view.getUint32(offset)
  const type = text(bytes.subarray(offset + 4, offset + 8))
  let header = 8
  let size = size32
  if (size32 === 1) {
    if (limit - offset < 16) return null
    size = Number(view.getBigUint64(offset + 8))
    header = 16
  }
  if (size < header || offset + size > limit) return null
  return { type, start: offset, header, end: offset + size }
}

function children(bytes: Uint8Array, start: number, end: number): FoundBox[] {
  const boxes: FoundBox[] = []
  let offset = start
  while (offset < end) {
    const box = readBox(bytes, offset, end)
    if (!box) break
    boxes.push(box)
    offset = box.end
  }
  return boxes
}

function findDescendant(bytes: Uint8Array, root: FoundBox, type: string): FoundBox | undefined {
  const nested = children(bytes, root.start + root.header, root.end)
  for (const box of nested) {
    if (box.type === type) return box
    const found = findDescendant(bytes, box, type)
    if (found) return found
  }
  return undefined
}

function u32at(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

interface InspectedFragment {
  trackId: number
  flags: number
  dataOffset: number
  sampleStart: number
  payload: Uint8Array
  decodeTime: bigint
}

function inspect(bytes: Uint8Array): {
  types: string[]
  trackIds: number[]
  nextTrackId: number
  movieTimescale: number
  movieDuration: number
  mediaDurations: number[]
  tkhdDurations: number[]
  fragments: InspectedFragment[]
} {
  const top = children(bytes, 0, bytes.byteLength)
  const moov = top.find((box) => box.type === 'moov')
  if (!moov) throw new Error('no moov')
  const mvhd = children(bytes, moov.start + moov.header, moov.end).find((box) => box.type === 'mvhd')
  if (!mvhd) throw new Error('no mvhd')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = bytes[mvhd.start + mvhd.header] ?? 0
  const movieTimescale = version === 0 ? view.getUint32(mvhd.start + mvhd.header + 12) : view.getUint32(mvhd.start + mvhd.header + 20)
  const movieDuration = version === 0 ? view.getUint32(mvhd.start + mvhd.header + 16) : Number(view.getBigUint64(mvhd.start + mvhd.header + 24))
  const nextTrackId = view.getUint32(mvhd.end - 4)
  const traks = children(bytes, moov.start + moov.header, moov.end).filter((box) => box.type === 'trak')
  const trackIds = traks.map((trak) => {
    const tkhd = children(bytes, trak.start + trak.header, trak.end).find((box) => box.type === 'tkhd')
    if (!tkhd) throw new Error('no tkhd')
    const tkhdVersion = bytes[tkhd.start + tkhd.header] ?? 0
    return tkhdVersion === 0 ? view.getUint32(tkhd.start + tkhd.header + 12) : view.getUint32(tkhd.start + tkhd.header + 20)
  })
  const tkhdDurations = traks.map((trak) => {
    const tkhd = children(bytes, trak.start + trak.header, trak.end).find((box) => box.type === 'tkhd')
    if (!tkhd) return 0
    const tkhdVersion = bytes[tkhd.start + tkhd.header] ?? 0
    return tkhdVersion === 0 ? view.getUint32(tkhd.start + tkhd.header + 20) : Number(view.getBigUint64(tkhd.start + tkhd.header + 28))
  })
  const mediaDurations = traks.map((trak) => {
    const mdhd = findDescendant(bytes, trak, 'mdhd')
    if (!mdhd) return 0
    const mdhdVersion = bytes[mdhd.start + mdhd.header] ?? 0
    return mdhdVersion === 0 ? view.getUint32(mdhd.start + mdhd.header + 16) : Number(view.getBigUint64(mdhd.start + mdhd.header + 24))
  })
  const trexIds = children(bytes, moov.start + moov.header, moov.end)
    .filter((box) => box.type === 'mvex')
    .flatMap((mvex) => children(bytes, mvex.start + mvex.header, mvex.end))
    .filter((box) => box.type === 'trex')
    .map((trex) => view.getUint32(trex.start + trex.header + 4))
  const fragments: InspectedFragment[] = []
  for (let index = 0; index < top.length; index += 1) {
    const moof = top[index]
    const mdat = top[index + 1]
    if (!moof || moof.type !== 'moof' || !mdat || mdat.type !== 'mdat') continue
    const traf = children(bytes, moof.start + moof.header, moof.end).find((box) => box.type === 'traf')
    if (!traf) continue
    const tfhd = children(bytes, traf.start + traf.header, traf.end).find((box) => box.type === 'tfhd')
    const trun = children(bytes, traf.start + traf.header, traf.end).find((box) => box.type === 'trun')
    const tfdt = children(bytes, traf.start + traf.header, traf.end).find((box) => box.type === 'tfdt')
    if (!tfhd || !trun || !tfdt) continue
    const flags = view.getUint32(tfhd.start + tfhd.header) & 0xffffff
    const trackId = view.getUint32(tfhd.start + tfhd.header + 4)
    const trunFlags = view.getUint32(trun.start + trun.header) & 0xffffff
    const dataOffset = view.getInt32(trun.start + trun.header + 8)
    const sampleSize = view.getUint32(trun.start + trun.header + 16)
    const decodeVersion = bytes[tfdt.start + tfdt.header] ?? 0
    const decodeTime = decodeVersion === 1 ? view.getBigUint64(tfdt.start + tfdt.header + 4) : BigInt(view.getUint32(tfdt.start + tfdt.header + 4))
    const sampleStart = moof.start + dataOffset
    if ((trunFlags & 0x1) === 0) throw new Error('trun 没有 data_offset')
    fragments.push({
      trackId,
      flags,
      dataOffset,
      sampleStart,
      payload: bytes.slice(sampleStart, sampleStart + sampleSize),
      decodeTime,
    })
  }
  return { types: top.map((box) => box.type), trackIds: [...trackIds, ...trexIds], nextTrackId, movieTimescale, movieDuration, mediaDurations, tkhdDurations, fragments }
}

function piece(time: bigint, duration: number, payload: string): FragmentPiece {
  return { decodeTime: time, samples: [{ duration, payload: Uint8Array.from(payload, (char) => char.charCodeAt(0)) }] }
}

function videoFile(fragments: FragmentPiece[], extra: Partial<Parameters<typeof buildFmp4>[0]> = {}): Uint8Array {
  return buildFmp4({
    handler: 'vide',
    movieTimescale: 1000,
    mediaTimescale: 100,
    fragments,
    ...extra,
  })
}

function audioFile(fragments: FragmentPiece[], extra: Partial<Parameters<typeof buildFmp4>[0]> = {}): Uint8Array {
  return buildFmp4({
    handler: 'soun',
    movieTimescale: 600,
    mediaTimescale: 1000,
    fragments,
    ...extra,
  })
}

describe('fMP4 合并', () => {
  const video = videoFile([piece(0n, 100, 'VID0'), piece(100n, 100, 'VID1')])
  const audio = audioFile([piece(0n, 500, 'AUD0'), piece(500n, 500, 'AUD1'), piece(1000n, 500, 'AUD2')])

  it('按秒交错，track_ID、data_offset 和时长都改到新文件里', () => {
    const videoBefore = video.slice()
    const audioBefore = audio.slice()
    const merged = mergeFmp4(video, audio)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(video).toEqual(videoBefore)
    expect(audio).toEqual(audioBefore)
    // Node 的 Buffer.slice 和原数组共享内存。合并器必须对这种输入也只读。
    const videoBuffer = Buffer.from(video)
    const audioBuffer = Buffer.from(audio)
    const videoBufferBefore = Buffer.from(videoBuffer)
    const audioBufferBefore = Buffer.from(audioBuffer)
    const fromBuffer = mergeFmp4(videoBuffer, audioBuffer)
    expect(fromBuffer.ok).toBe(true)
    expect(Buffer.compare(videoBuffer, videoBufferBefore)).toBe(0)
    expect(Buffer.compare(audioBuffer, audioBufferBefore)).toBe(0)
    expect(merged.bytes).not.toBe(video)
    const layout = inspect(merged.bytes)
    expect(layout.types.filter((type) => type === 'moov')).toHaveLength(1)
    expect(layout.types).not.toContain('sidx')
    expect(layout.trackIds).toEqual([1, 2, 1, 2])
    expect(layout.nextTrackId).toBe(3)
    expect(layout.movieTimescale).toBe(1000)
    // 视频 2 秒，音频 1.5 秒。mvhd 取较大的 2000。
    expect(layout.movieDuration).toBe(2000)
    expect(layout.tkhdDurations).toEqual([2000, 1500])
    expect(layout.mediaDurations).toEqual([200, 1500])
    expect(layout.fragments.map((fragment) => fragment.payload)).toEqual([
      Uint8Array.from('VID0', (char) => char.charCodeAt(0)),
      Uint8Array.from('AUD0', (char) => char.charCodeAt(0)),
      Uint8Array.from('AUD1', (char) => char.charCodeAt(0)),
      Uint8Array.from('VID1', (char) => char.charCodeAt(0)),
      Uint8Array.from('AUD2', (char) => char.charCodeAt(0)),
    ])
    expect(layout.fragments.map((fragment) => fragment.trackId)).toEqual([1, 2, 2, 1, 2])
    for (const fragment of layout.fragments) {
      expect(fragment.flags & 0x020000).toBe(0x020000)
      expect(fragment.flags & 0x000001).toBe(0)
      expect(fragment.sampleStart).toBeGreaterThan(0)
      expect(u32at(merged.bytes, fragment.sampleStart - 8)).toBeGreaterThan(8)
      expect(text(merged.bytes.subarray(fragment.sampleStart - 4, fragment.sampleStart))).toBe('mdat')
    }
  })

  it('丢掉 sidx 之后 data_offset 仍然指向 mdat 里的样本', () => {
    const merged = mergeFmp4(
      videoFile([piece(0n, 100, 'LEFT')], { sidx: true }),
      audioFile([piece(0n, 1000, 'RGHT')], { sidx: true }),
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const layout = inspect(merged.bytes)
    expect(layout.types).not.toContain('sidx')
    expect(layout.fragments.map((fragment) => String.fromCharCode(...fragment.payload))).toEqual(['LEFT', 'RGHT'])
  })

  it('base-data-offset 会改成相对 moof 的 data_offset', () => {
    const merged = mergeFmp4(
      videoFile([{ ...piece(0n, 50, 'BASE'), baseDataOffset: true }]),
      audioFile([piece(0n, 400, 'TONE')]),
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const layout = inspect(merged.bytes)
    expect(String.fromCharCode(...(layout.fragments[0]?.payload ?? []))).toBe('BASE')
    expect(layout.fragments[0]?.flags & 0x000001).toBe(0)
    expect(layout.fragments[0]?.flags & 0x020000).toBe(0x020000)
  })

  it('没有 data_offset 的 trun 会补上，并指向样本', () => {
    const merged = mergeFmp4(
      videoFile([{ ...piece(0n, 25, 'NONE'), omitDataOffset: true }]),
      audioFile([piece(0n, 250, 'YES!')]),
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const layout = inspect(merged.bytes)
    expect(String.fromCharCode(...(layout.fragments[0]?.payload ?? []))).toBe('NONE')
  })

  it('version 1 的 mvhd 也能写下较长的时长', () => {
    const merged = mergeFmp4(
      videoFile([piece(0n, 100, 'VVVV')], { mvhdVersion: 1, mdhdVersion: 1 }),
      audioFile([piece(0n, 1000, 'AAAA')], { mvhdVersion: 1, mdhdVersion: 1 }),
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(inspect(merged.bytes).movieDuration).toBe(1000)
  })

  it('合计超过 1GB 时拒绝，调用方不用真的分配那么多', () => {
    expect(FMP4_MERGE_MAX_BYTES).toBe(1024 * 1024 * 1024)
    expect(fmp4MergeExceedsLimit(FMP4_MERGE_MAX_BYTES, 0)).toBe(false)
    expect(fmp4MergeExceedsLimit(FMP4_MERGE_MAX_BYTES, 1)).toBe(true)
    expect(fmp4MergeExceedsLimit(Number.NaN, 1)).toBe(true)
  })

  it('不支持的输入给出明确原因，并且不改原数组', () => {
    const cases: Array<{ video: Uint8Array; audio: Uint8Array; error: string }> = [
      { video: videoFile([piece(0n, 1, 'V')], { extraTrack: true }), audio, error: '多条轨道' },
      { video: videoFile([piece(0n, 1, 'V')], { encrypted: 'encv' }), audio, error: '加密' },
      { video, audio: audioFile([piece(0n, 1, 'A')], { encrypted: 'enca' }), error: '加密' },
      { video: videoFile([piece(0n, 1, 'V')], { encrypted: 'sinf' }), audio, error: '加密' },
      { video, audio: audioFile([piece(0n, 1, 'A')], { encrypted: 'senc' }), error: '加密' },
      { video: videoFile([piece(0n, 1, 'V')], { omitMoov: true }), audio, error: '找不到 moov' },
      { video: videoFile([piece(0n, 1, 'V')], { overrun: true }), audio, error: '超出文件范围' },
      { video: videoFile([piece(0n, 1, 'V')], { omitFtyp: true }), audio, error: '不是 fMP4' },
      { video: videoFile([]), audio, error: '不是 fMP4' },
      { video: audioFile([piece(0n, 1, 'A')]), audio, error: '不是视频轨' },
      { video, audio: videoFile([piece(0n, 1, 'V')]), error: '不是音频轨' },
      { video: videoFile([piece(0n, 1, 'V')], { unknown: true }), audio, error: '无法识别的盒子' },
    ]
    for (const item of cases) {
      const before = item.video.slice()
      const result = mergeFmp4(item.video, item.audio)
      expect(result.ok, item.error).toBe(false)
      if (result.ok) continue
      expect(result.error, item.error).toContain(item.error)
      expect(item.video).toEqual(before)
    }
  })

  it('base-data-offset 指向 mdat 外面时拒绝', () => {
    const broken = videoFile([{ ...piece(0n, 10, 'BAD!'), baseDataOffset: true }])
    // 把绝对偏移改成 0，样本就不在 mdat 里。tfhd 四字符后面是 version、track_ID，再往后 8 字节才是偏移。
    const view = new DataView(broken.buffer, broken.byteOffset, broken.byteLength)
    const marker = [0x74, 0x66, 0x68, 0x64]
    let at = -1
    for (let index = 0; index < broken.length - 24; index += 1) {
      if (marker.every((byte, offset) => broken[index + offset] === byte)) {
        at = index
        break
      }
    }
    expect(at).toBeGreaterThan(0)
    view.setBigUint64(at + 12, 0n)
    const result = mergeFmp4(broken, audio)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('base-data-offset')
  })

  it('取消时不返回合并结果', () => {
    const result = mergeFmp4(video, audio, { shouldAbort: () => true })
    expect(result).toEqual({ ok: false, error: '下载已取消', cancelled: true })
  })
})
