/**
 * 手写的最小 fMP4。只给合并器单测用，不是真实媒体。
 */

export interface SamplePiece {
  duration: number
  payload: Uint8Array
}

export interface FragmentPiece {
  /** 这一片第一个样本的解码时间，单位是媒体 timescale。 */
  decodeTime: bigint
  samples: SamplePiece[]
  /** 用绝对 base-data-offset，而不是 default-base-is-moof。 */
  baseDataOffset?: boolean
  /** trun 不写 data_offset，用来测补字段。 */
  omitDataOffset?: boolean
}

export interface Fmp4FixtureOptions {
  handler: 'vide' | 'soun'
  movieTimescale: number
  mediaTimescale: number
  fragments: FragmentPiece[]
  trackId?: number
  sidx?: boolean
  encrypted?: 'encv' | 'enca' | 'sinf' | 'senc'
  extraTrack?: boolean
  omitMoov?: boolean
  omitFtyp?: boolean
  /** 把最后一个盒子的 size 写成超出文件的值。 */
  overrun?: boolean
  mvhdVersion?: 0 | 1
  mdhdVersion?: 0 | 1
  /** 顶层再放一个不认识的盒子。 */
  unknown?: boolean
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

function ftyp(): Uint8Array {
  return box('ftyp', concat([u32(0x69736f35), u32(0x200), u32(0x69736f35), u32(0x69736f36), u32(0x6d703431)]))
}

function mvhd(version: 0 | 1, timescale: number, nextTrack: number): Uint8Array {
  // payload 紧跟在 version/flags 后面。timescale 在 creation、modification 之后。
  if (version === 0) {
    const payload = zeros(96)
    const view = new DataView(payload.buffer)
    view.setUint32(8, timescale)
    view.setUint32(16, 0x00010000)
    view.setUint16(20, 0x0100)
    view.setUint32(92, nextTrack)
    return box('mvhd', full(0, 0, payload))
  }
  const payload = zeros(108)
  const view = new DataView(payload.buffer)
  view.setUint32(16, timescale)
  view.setUint32(28, 0x00010000)
  view.setUint16(32, 0x0100)
  view.setUint32(104, nextTrack)
  return box('mvhd', full(1, 0, payload))
}

function tkhd(trackId: number): Uint8Array {
  const payload = zeros(80)
  const view = new DataView(payload.buffer)
  view.setUint32(8, trackId)
  view.setUint32(76, 320 << 16)
  view.setUint32(80 - 4, 240 << 16)
  return box('tkhd', full(0, 7, payload))
}

function mdhd(version: 0 | 1, timescale: number): Uint8Array {
  if (version === 0) {
    const payload = zeros(20)
    new DataView(payload.buffer).setUint32(8, timescale)
    return box('mdhd', full(0, 0, payload))
  }
  const payload = zeros(32)
  new DataView(payload.buffer).setUint32(16, timescale)
  return box('mdhd', full(1, 0, payload))
}

function hdlr(handler: 'vide' | 'soun'): Uint8Array {
  const payload = zeros(25)
  payload.set(Array.from(handler).map((char) => char.charCodeAt(0)), 4)
  return box('hdlr', full(0, 0, payload))
}

function sampleEntry(type: string, preamble: number, child: Uint8Array | null): Uint8Array {
  return box(type, concat([zeros(preamble), child ?? new Uint8Array()]))
}

function stsd(handler: 'vide' | 'soun', encrypted?: Fmp4FixtureOptions['encrypted']): Uint8Array {
  let entryType = handler === 'vide' ? 'avc1' : 'mp4a'
  let preamble = handler === 'vide' ? 78 : 28
  let child: Uint8Array | null = box(handler === 'vide' ? 'avcC' : 'esds', new Uint8Array(4))
  if (encrypted === 'encv' || encrypted === 'enca') {
    entryType = encrypted
    preamble = encrypted === 'encv' ? 78 : 28
  }
  if (encrypted === 'sinf') child = concat([child, box('sinf', new Uint8Array(4))])
  const entry = sampleEntry(entryType, preamble, child)
  return box('stsd', full(0, 0, concat([u32(1), entry])))
}

function stbl(handler: 'vide' | 'soun', encrypted?: Fmp4FixtureOptions['encrypted']): Uint8Array {
  return box(
    'stbl',
    concat([
      stsd(handler, encrypted),
      box('stts', full(0, 0, u32(0))),
      box('stsc', full(0, 0, u32(0))),
      box('stsz', full(0, 0, concat([u32(0), u32(0)]))),
      box('stco', full(0, 0, u32(0))),
    ]),
  )
}

function minf(handler: 'vide' | 'soun', encrypted?: Fmp4FixtureOptions['encrypted']): Uint8Array {
  const header = handler === 'vide' ? box('vmhd', full(0, 1, zeros(8))) : box('smhd', full(0, 0, zeros(4)))
  const dref = box('dref', full(0, 0, concat([u32(1), box('url ', full(0, 1, new Uint8Array()))])))
  return box('minf', concat([header, box('dinf', dref), stbl(handler, encrypted)]))
}

function trak(options: Fmp4FixtureOptions, trackId: number): Uint8Array {
  const media = box(
    'mdia',
    concat([
      mdhd(options.mdhdVersion ?? 0, options.mediaTimescale),
      hdlr(options.handler),
      minf(options.handler, options.encrypted),
    ]),
  )
  return box('trak', concat([tkhd(trackId), media]))
}

function trex(trackId: number): Uint8Array {
  return box('trex', full(0, 0, concat([u32(trackId), u32(1), u32(0), u32(0), u32(0)])))
}

function moov(options: Fmp4FixtureOptions): Uint8Array {
  const trackId = options.trackId ?? 1
  const parts = [
    mvhd(options.mvhdVersion ?? 0, options.movieTimescale, trackId + 1),
    trak(options, trackId),
  ]
  const trexes = [trex(trackId)]
  if (options.extraTrack) {
    parts.push(trak({ ...options, encrypted: undefined }, trackId + 1))
    trexes.push(trex(trackId + 1))
  }
  parts.push(box('mvex', concat(trexes)))
  return box('moov', concat(parts))
}

function tfdt(time: bigint): Uint8Array {
  return box('tfdt', full(1, 0, u64(time)))
}

export function buildFmp4(options: Fmp4FixtureOptions): Uint8Array {
  const parts: Uint8Array[] = []
  if (!options.omitFtyp) parts.push(ftyp())
  if (!options.omitMoov) parts.push(moov(options))
  if (options.sidx) parts.push(box('sidx', zeros(16)))
  if (options.unknown) parts.push(box('zzzz', u32(1)))
  const trackId = options.trackId ?? 1
  for (const piece of options.fragments) {
    parts.push(oneFragment(piece, trackId, parts.reduce((sum, part) => sum + part.byteLength, 0), options.encrypted === 'senc'))
  }
  const file = concat(parts)
  if (options.overrun && file.byteLength >= 4) {
    new DataView(file.buffer).setUint32(file.byteLength - parts[parts.length - 1]!.byteLength, 0x0fffffff)
  }
  return file
}

function oneFragment(piece: FragmentPiece, trackId: number, fileOffset: number, senc: boolean): Uint8Array {
  const payload = concat(piece.samples.map((sample) => sample.payload))
  const tfhdBody = piece.baseDataOffset ? concat([u32(trackId), u64(0n)]) : u32(trackId)
  const tfhd = box('tfhd', full(0, piece.baseDataOffset ? 0x000001 : 0x020000, tfhdBody))
  const rows = piece.samples.map((sample) => concat([u32(sample.duration), u32(sample.payload.byteLength)]))
  const trunPayload = piece.omitDataOffset
    ? full(0, 0x000300, concat([u32(piece.samples.length), ...rows]))
    : full(0, 0x000301, concat([u32(piece.samples.length), u32(0), ...rows]))
  const trunBox = box('trun', trunPayload)
  const inner = [tfhd, tfdt(piece.decodeTime)]
  if (senc) inner.push(box('senc', zeros(4)))
  inner.push(trunBox)
  const moof = box('moof', concat([box('mfhd', full(0, 0, u32(1))), box('traf', concat(inner))]))
  const mdat = box('mdat', payload)
  const bytes = concat([moof, mdat])
  const view = new DataView(bytes.buffer)
  if (!piece.omitDataOffset) {
    const trunAt = moof.byteLength - trunBox.byteLength
    view.setUint32(trunAt + 16, piece.baseDataOffset ? 0 : moof.byteLength + 8)
  }
  if (piece.baseDataOffset) {
    // moof 头 8 + mfhd 16 + traf 头 8 + tfhd 头 8 + version 4 + track_ID 4。
    view.setBigUint64(48, BigInt(fileOffset + moof.byteLength + 8))
  }
  return bytes
}
