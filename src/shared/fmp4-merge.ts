/**
 * 把一路视频 fMP4 和一路音频 fMP4 合成一个文件。
 * 不重新编码，也不调用 mux.js：mux.js 只能把 MPEG-TS 转成 fMP4，合并不了两路已经分开的 fMP4。
 *
 * 输入是单轨碎片 mp4：ftyp、moov，可以有 sidx / styp，然后若干 moof+mdat。
 * DASH 把初始化段和媒体段按顺序接在一起，也是这种文件。
 * 输出是 ftyp + 一份新 moov（视频 track_ID=1，音频 track_ID=2）+ 按时间交错的 moof+mdat。
 *
 * 只读输入。任何不支持的结构都返回中文原因，由调用方改回分开保存。
 */

/** 超过这个字节数就不要合并。调用方也应先判断，避免内存里再放一份同样大的结果。 */
export const FMP4_MERGE_MAX_BYTES = 1024 * 1024 * 1024

export const FMP4_MERGE_TEXT = {
  merging: '正在合并…',
  merged: '已合并为一个 mp4',
  tooLarge: '视频和音频合计超过 1GB，为避免占满内存，已分开保存',
  separateChosen: '已按选择分开保存视频和音频',
  failed(reason: string): string {
    return `无法合并（${reason}），已分开保存视频和音频`
  },
}

const UINT32_MAX = 0xffffffffn
const INT32_MAX = 0x7fffffff

const TFHD_BASE_DATA_OFFSET = 0x000001
const TFHD_SAMPLE_DESC = 0x000002
const TFHD_DEFAULT_DURATION = 0x000008
const TFHD_DEFAULT_SIZE = 0x000010
const TFHD_DEFAULT_FLAGS = 0x000020
const TFHD_DURATION_EMPTY = 0x010000
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000

const TRUN_DATA_OFFSET = 0x000001
const TRUN_FIRST_FLAGS = 0x000004
const TRUN_DURATION = 0x000100
const TRUN_SIZE = 0x000200
const TRUN_FLAGS = 0x000400
const TRUN_COMPOSITION = 0x000800

const ENCRYPTED = new Set(['encv', 'enca', 'sinf', 'senc'])
const VISUAL_ENTRY = new Set(['avc1', 'avc3', 'hev1', 'hvc1', 'vp08', 'vp09', 'av01', 'mp4v', 'encv', 'dvh1', 'dvhe'])
const AUDIO_ENTRY = new Set(['mp4a', 'ac-3', 'ec-3', 'Opus', 'fLaC', 'alac', 'enca', 'twos', 'sowt'])
/** 顶层可以出现、但不进入输出的盒子。mfra / sidx 里的偏移在丢掉之后会失效，所以整段跳过。 */
const IGNORABLE = new Set(['free', 'skip', 'wide', 'sidx', 'styp', 'mfra', 'prft', 'emsg', 'uuid', 'udta', 'meta'])
const BETWEEN_PAIR = new Set(['free', 'skip', 'wide'])

export interface Fmp4MergeOptions {
  /** 返回 true 时立刻停，不写出半成品。 */
  shouldAbort?: () => boolean
}

export type Fmp4MergeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string; cancelled?: boolean }

interface Box {
  type: string
  start: number
  header: number
  end: number
}

interface TfhdInfo {
  version: number
  flags: number
  trackId: number
  baseDataOffset?: bigint
  sampleDescriptionIndex?: number
  defaultSampleDuration?: number
  defaultSampleSize?: number
  defaultSampleFlags?: number
}

interface TrunInfo {
  box: Box
  dataOffset: number | null
  /** data_offset 字段在 trun 盒子内的位置。没有这个字段时为 -1，写出时会补上。 */
  fieldAt: number
  totalDuration: bigint
  totalSize: bigint
}

interface Fragment {
  moof: Box
  mdat: Box
  decodeTime: bigint
  duration: bigint
  runs: Array<{ sampleStart: number; totalSize: bigint; trun: TrunInfo }>
}

interface TrexInfo {
  box: Box
  defaultSampleDuration: number
  defaultSampleSize: number
}

interface MovieHeader {
  box: Box
  version: number
  timescale: number
  duration: bigint
  durationAt: number
  durationWidth: 4 | 8
  nextTrackAt: number
}

interface MediaHeader {
  box: Box
  version: number
  timescale: number
  duration: bigint
  durationAt: number
  durationWidth: 4 | 8
}

interface TrackHeader {
  box: Box
  version: number
  trackId: number
  durationAt: number
  durationWidth: 4 | 8
  trackIdAt: number
}

interface ParsedFile {
  ftyp: Box
  moov: Box
  mvhd: MovieHeader
  trak: Box
  tkhd: TrackHeader
  mdhd: MediaHeader
  trex: TrexInfo
  mehd: Box | null
  handler: string
  fragments: Fragment[]
  mediaDuration: bigint
}

function fail(error: string): Fmp4MergeResult {
  return { ok: false, error }
}

function cancelled(): Fmp4MergeResult {
  return { ok: false, error: '下载已取消', cancelled: true }
}

export function fmp4MergeExceedsLimit(videoBytes: number, audioBytes: number): boolean {
  if (!Number.isFinite(videoBytes) || !Number.isFinite(audioBytes)) return true
  if (videoBytes < 0 || audioBytes < 0) return true
  return videoBytes + audioBytes > FMP4_MERGE_MAX_BYTES
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * 拷贝一段字节。不能用 bytes.slice：Node 的 Buffer.slice 和原数组共享内存，改拷贝会改到输入。
 */
function copyRange(bytes: Uint8Array, start: number, end: number): Uint8Array {
  const view = bytes.subarray(start, end)
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  return copy
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0)
}

function readBox(bytes: Uint8Array, offset: number, limit: number): Box | 'bounds' | 'bad' {
  if (offset < 0 || limit - offset < 8) return 'bounds'
  const view = viewOf(bytes)
  const size32 = view.getUint32(offset)
  const type = fourcc(bytes, offset + 4)
  let header = 8
  let size = size32
  if (size32 === 1) {
    if (limit - offset < 16) return 'bounds'
    const large = view.getBigUint64(offset + 8)
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return 'bounds'
    size = Number(large)
    header = 16
  } else if (size32 === 0) {
    size = limit - offset
  } else if (size32 < 8) {
    return 'bad'
  }
  if (size < header) return 'bad'
  const end = offset + size
  if (end < offset || end > limit) return 'bounds'
  return { type, start: offset, header, end }
}

function readChildren(bytes: Uint8Array, start: number, end: number): Box[] | 'bounds' | 'bad' {
  const boxes: Box[] = []
  let offset = start
  while (offset < end) {
    const box = readBox(bytes, offset, end)
    if (box === 'bounds' || box === 'bad') return box
    if (box.end <= offset) return 'bad'
    boxes.push(box)
    offset = box.end
  }
  return boxes
}

function fullBox(bytes: Uint8Array, box: Box): { version: number; flags: number; content: number } | null {
  const content = box.start + box.header
  if (content + 4 > box.end) return null
  const word = viewOf(bytes).getUint32(content)
  return { version: word >>> 24, flags: word & 0xffffff, content: content + 4 }
}

function findOne(children: Box[], type: string): Box | 'missing' | 'many' {
  const found = children.filter((box) => box.type === type)
  if (found.length === 0) return 'missing'
  if (found.length > 1) return 'many'
  return found[0] ?? 'missing'
}

function regionHasTypedBox(bytes: Uint8Array, start: number, end: number, type: string): boolean {
  const view = viewOf(bytes)
  for (let offset = start; offset + 8 <= end; offset += 1) {
    if (fourcc(bytes, offset + 4) !== type) continue
    const size32 = view.getUint32(offset)
    if (size32 === 1) {
      if (offset + 16 > end) continue
      const large = view.getBigUint64(offset + 8)
      if (large >= 16n && large <= BigInt(end - offset)) return true
    } else if (size32 >= 8 && offset + size32 <= end) {
      return true
    }
  }
  return false
}

/** stsd 里的样本项。encv / enca 直接拒绝；视觉项前 78 字节、音频项前 28 字节之后才是子盒子。 */
function sampleEntryEncrypted(bytes: Uint8Array, entry: Box): boolean | 'bounds' | 'bad' {
  if (ENCRYPTED.has(entry.type)) return true
  const body = entry.start + entry.header
  const preamble = VISUAL_ENTRY.has(entry.type) ? 78 : AUDIO_ENTRY.has(entry.type) ? 28 : 0
  if (preamble === 0) {
    return ENCRYPTED.has(entry.type) || regionHasTypedBox(bytes, body, entry.end, 'sinf') || regionHasTypedBox(bytes, body, entry.end, 'senc')
  }
  if (body + preamble > entry.end) return 'bounds'
  const children = readChildren(bytes, body + preamble, entry.end)
  if (children === 'bounds' || children === 'bad') {
    return regionHasTypedBox(bytes, body, entry.end, 'sinf') || regionHasTypedBox(bytes, body, entry.end, 'senc')
  }
  return children.some((child) => ENCRYPTED.has(child.type))
}

function stsdEncrypted(bytes: Uint8Array, stsd: Box): boolean | 'bounds' | 'bad' {
  const head = fullBox(bytes, stsd)
  if (!head || head.content + 4 > stsd.end) return 'bounds'
  const count = viewOf(bytes).getUint32(head.content)
  if (count > 32) return 'bad'
  let offset = head.content + 4
  for (let index = 0; index < count; index += 1) {
    const entry = readBox(bytes, offset, stsd.end)
    if (entry === 'bounds' || entry === 'bad') return entry
    const encrypted = sampleEntryEncrypted(bytes, entry)
    if (encrypted === true || encrypted === 'bounds' || encrypted === 'bad') return encrypted
    offset = entry.end
  }
  return offset !== stsd.end ? 'bad' : false
}

function treeEncrypted(bytes: Uint8Array, boxes: Box[]): boolean | 'bounds' | 'bad' {
  for (const box of boxes) {
    if (ENCRYPTED.has(box.type)) return true
    if (box.type === 'stsd') {
      const found = stsdEncrypted(bytes, box)
      if (found !== false) return found
      continue
    }
    const nested = box.type === 'moov' || box.type === 'trak' || box.type === 'mdia' || box.type === 'minf' || box.type === 'stbl' || box.type === 'edts' || box.type === 'mvex' || box.type === 'moof' || box.type === 'traf' || box.type === 'dinf' || box.type === 'udta'
    if (!nested) continue
    const children = readChildren(bytes, box.start + box.header, box.end)
    if (children === 'bounds' || children === 'bad') return children
    const found = treeEncrypted(bytes, children)
    if (found !== false) return found
  }
  return false
}

function readMovieHeader(bytes: Uint8Array, box: Box): MovieHeader | null {
  const head = fullBox(bytes, box)
  if (!head) return null
  const view = viewOf(bytes)
  if (head.version === 0) {
    if (head.content + 16 > box.end) return null
    const timescale = view.getUint32(head.content + 8)
    if (timescale === 0) return null
    const nextTrackAt = box.start + box.header + 96
    if (nextTrackAt + 4 > box.end) return null
    return {
      box,
      version: 0,
      timescale,
      duration: BigInt(view.getUint32(head.content + 12)),
      durationAt: box.header + 16,
      durationWidth: 4,
      nextTrackAt: box.header + 96,
    }
  }
  if (head.version === 1) {
    if (head.content + 28 > box.end) return null
    const timescale = view.getUint32(head.content + 16)
    if (timescale === 0) return null
    const nextTrackAt = box.start + box.header + 108
    if (nextTrackAt + 4 > box.end) return null
    return {
      box,
      version: 1,
      timescale,
      duration: view.getBigUint64(head.content + 20),
      durationAt: box.header + 24,
      durationWidth: 8,
      nextTrackAt: box.header + 108,
    }
  }
  return null
}

function readMediaHeader(bytes: Uint8Array, box: Box): MediaHeader | null {
  const head = fullBox(bytes, box)
  if (!head) return null
  const view = viewOf(bytes)
  if (head.version === 0) {
    if (head.content + 16 > box.end) return null
    const timescale = view.getUint32(head.content + 8)
    if (timescale === 0) return null
    return {
      box,
      version: 0,
      timescale,
      duration: BigInt(view.getUint32(head.content + 12)),
      durationAt: box.header + 16,
      durationWidth: 4,
    }
  }
  if (head.version === 1) {
    if (head.content + 28 > box.end) return null
    const timescale = view.getUint32(head.content + 16)
    if (timescale === 0) return null
    return {
      box,
      version: 1,
      timescale,
      duration: view.getBigUint64(head.content + 20),
      durationAt: box.header + 24,
      durationWidth: 8,
    }
  }
  return null
}

function readTrackHeader(bytes: Uint8Array, box: Box): TrackHeader | null {
  const head = fullBox(bytes, box)
  if (!head) return null
  const view = viewOf(bytes)
  if (head.version === 0) {
    if (head.content + 20 > box.end) return null
    return {
      box,
      version: 0,
      trackId: view.getUint32(head.content + 8),
      trackIdAt: box.header + 12,
      durationAt: box.header + 20,
      durationWidth: 4,
    }
  }
  if (head.version === 1) {
    if (head.content + 32 > box.end) return null
    return {
      box,
      version: 1,
      trackId: view.getUint32(head.content + 16),
      trackIdAt: box.header + 20,
      durationAt: box.header + 28,
      durationWidth: 8,
    }
  }
  return null
}

function readHandler(bytes: Uint8Array, box: Box): string | null {
  const head = fullBox(bytes, box)
  if (!head || head.content + 8 > box.end) return null
  return fourcc(bytes, head.content + 4)
}

function readTrex(bytes: Uint8Array, box: Box): TrexInfo | null {
  const head = fullBox(bytes, box)
  if (!head || head.content + 20 > box.end) return null
  const view = viewOf(bytes)
  return {
    box,
    defaultSampleDuration: view.getUint32(head.content + 8),
    defaultSampleSize: view.getUint32(head.content + 12),
  }
}

function readTfhd(bytes: Uint8Array, box: Box): TfhdInfo | null {
  const head = fullBox(bytes, box)
  if (!head || head.content + 4 > box.end) return null
  const view = viewOf(bytes)
  const info: TfhdInfo = {
    version: head.version,
    flags: head.flags,
    trackId: view.getUint32(head.content),
  }
  let offset = head.content + 4
  if (info.flags & TFHD_BASE_DATA_OFFSET) {
    if (offset + 8 > box.end) return null
    info.baseDataOffset = view.getBigUint64(offset)
    offset += 8
  }
  if (info.flags & TFHD_SAMPLE_DESC) {
    if (offset + 4 > box.end) return null
    info.sampleDescriptionIndex = view.getUint32(offset)
    offset += 4
  }
  if (info.flags & TFHD_DEFAULT_DURATION) {
    if (offset + 4 > box.end) return null
    info.defaultSampleDuration = view.getUint32(offset)
    offset += 4
  }
  if (info.flags & TFHD_DEFAULT_SIZE) {
    if (offset + 4 > box.end) return null
    info.defaultSampleSize = view.getUint32(offset)
    offset += 4
  }
  if (info.flags & TFHD_DEFAULT_FLAGS) {
    if (offset + 4 > box.end) return null
    info.defaultSampleFlags = view.getUint32(offset)
  }
  return info
}

function readTrun(bytes: Uint8Array, box: Box, tfhd: TfhdInfo, trex: TrexInfo): TrunInfo | 'bounds' | 'bad' {
  const head = fullBox(bytes, box)
  if (!head || head.content + 4 > box.end) return 'bounds'
  const view = viewOf(bytes)
  const sampleCount = view.getUint32(head.content)
  if (sampleCount > 1_000_000) return 'bad'
  let offset = head.content + 4
  let dataOffset: number | null = null
  let fieldAt = -1
  if (head.flags & TRUN_DATA_OFFSET) {
    if (offset + 4 > box.end) return 'bounds'
    dataOffset = view.getInt32(offset)
    fieldAt = offset - box.start
    offset += 4
  }
  if (head.flags & TRUN_FIRST_FLAGS) {
    if (offset + 4 > box.end) return 'bounds'
    offset += 4
  }
  const record =
    (head.flags & TRUN_DURATION ? 4 : 0) +
    (head.flags & TRUN_SIZE ? 4 : 0) +
    (head.flags & TRUN_FLAGS ? 4 : 0) +
    (head.flags & TRUN_COMPOSITION ? 4 : 0)
  if (record > 0 && sampleCount > Math.floor((box.end - offset) / record)) return 'bounds'
  let totalDuration = 0n
  let totalSize = 0n
  if (tfhd.flags & TFHD_DURATION_EMPTY) {
    return { box, dataOffset, fieldAt, totalDuration: 0n, totalSize: 0n }
  }
  for (let index = 0; index < sampleCount; index += 1) {
    let duration = tfhd.defaultSampleDuration ?? trex.defaultSampleDuration
    let size = tfhd.defaultSampleSize ?? trex.defaultSampleSize
    if (head.flags & TRUN_DURATION) {
      duration = view.getUint32(offset)
      offset += 4
    }
    if (head.flags & TRUN_SIZE) {
      size = view.getUint32(offset)
      offset += 4
    }
    if (head.flags & TRUN_FLAGS) offset += 4
    if (head.flags & TRUN_COMPOSITION) offset += 4
    totalDuration += BigInt(duration)
    totalSize += BigInt(size)
  }
  return { box, dataOffset, fieldAt, totalDuration, totalSize }
}

function locateRuns(
  base: number,
  truns: TrunInfo[],
  mdat: Box,
): Array<{ sampleStart: number; totalSize: bigint; trun: TrunInfo }> | null {
  const payloadStart = mdat.start + mdat.header
  const payloadEnd = mdat.end
  const runs: Array<{ sampleStart: number; totalSize: bigint; trun: TrunInfo }> = []
  let cursor = base
  for (const trun of truns) {
    if (trun.dataOffset !== null) {
      if (!Number.isSafeInteger(base + trun.dataOffset)) return null
      cursor = base + trun.dataOffset
    }
    if (!Number.isSafeInteger(cursor)) return null
    const size = Number(trun.totalSize)
    if (!Number.isSafeInteger(size) || size < 0) return null
    if (cursor < payloadStart || cursor > payloadEnd) return null
    if (cursor + size > payloadEnd) return null
    runs.push({ sampleStart: cursor, totalSize: trun.totalSize, trun })
    cursor += size
  }
  return runs
}

function readFragments(
  bytes: Uint8Array,
  pairs: Array<{ moof: Box; mdat: Box }>,
  trex: TrexInfo,
): Fragment[] | Fmp4MergeResult {
  const fragments: Fragment[] = []
  let carried = 0n
  for (const pair of pairs) {
    const children = readChildren(bytes, pair.moof.start + pair.moof.header, pair.moof.end)
    if (children === 'bounds') return fail('盒子长度超出文件范围')
    if (children === 'bad') return fail('不是 fMP4')
    const trafs = children.filter((box) => box.type === 'traf')
    if (trafs.length !== 1) return fail('输入包含多条轨道')
    const traf = trafs[0]
    if (!traf) return fail('不是 fMP4')
    const trafChildren = readChildren(bytes, traf.start + traf.header, traf.end)
    if (trafChildren === 'bounds') return fail('盒子长度超出文件范围')
    if (trafChildren === 'bad') return fail('不是 fMP4')
    if (trafChildren.some((box) => ENCRYPTED.has(box.type))) return fail('轨道已加密')
    const tfhds = trafChildren.filter((box) => box.type === 'tfhd')
    const trunBoxes = trafChildren.filter((box) => box.type === 'trun')
    if (tfhds.length !== 1 || trunBoxes.length === 0) return fail('不是 fMP4')
    const tfhdBox = tfhds[0]
    if (!tfhdBox) return fail('不是 fMP4')
    const tfhd = readTfhd(bytes, tfhdBox)
    if (!tfhd) return fail('盒子长度超出文件范围')
    const truns: TrunInfo[] = []
    for (const trunBox of trunBoxes) {
      const trun = readTrun(bytes, trunBox, tfhd, trex)
      if (trun === 'bounds') return fail('盒子长度超出文件范围')
      if (trun === 'bad') return fail('不是 fMP4')
      truns.push(trun)
    }
    let base: number | null = null
    if (tfhd.baseDataOffset !== undefined) {
      if (tfhd.baseDataOffset > BigInt(Number.MAX_SAFE_INTEGER)) return fail('盒子长度超出文件范围')
      base = Number(tfhd.baseDataOffset)
    }
    const candidates =
      base !== null
        ? [base]
        : [
            pair.moof.start,
            pair.moof.end,
            // 一个 data_offset 都没有时，样本通常从 mdat 正文开头依次排开。
            ...(truns.every((trun) => trun.dataOffset === null) ? [pair.mdat.start + pair.mdat.header] : []),
          ]
    let runs: Array<{ sampleStart: number; totalSize: bigint; trun: TrunInfo }> | null = null
    for (const candidate of candidates) {
      runs = locateRuns(candidate, truns, pair.mdat)
      if (runs) break
    }
    if (!runs) {
      if (tfhd.baseDataOffset !== undefined) return fail('tfhd 使用了 base-data-offset，但样本不在 mdat 里')
      return fail('无法确定样本在文件中的位置')
    }
    const tfdt = trafChildren.find((box) => box.type === 'tfdt')
    let decodeTime = carried
    if (tfdt) {
      const head = fullBox(bytes, tfdt)
      if (!head) return fail('盒子长度超出文件范围')
      const view = viewOf(bytes)
      if (head.version === 0) {
        if (head.content + 4 > tfdt.end) return fail('盒子长度超出文件范围')
        decodeTime = BigInt(view.getUint32(head.content))
      } else if (head.version === 1) {
        if (head.content + 8 > tfdt.end) return fail('盒子长度超出文件范围')
        decodeTime = view.getBigUint64(head.content)
      } else {
        return fail('不是 fMP4')
      }
    }
    let duration = 0n
    for (const trun of truns) duration += trun.totalDuration
    carried = decodeTime + duration
    fragments.push({ moof: pair.moof, mdat: pair.mdat, decodeTime, duration, runs })
  }
  return fragments
}

function parseFile(bytes: Uint8Array, expectedHandler: 'vide' | 'soun'): ParsedFile | Fmp4MergeResult {
  const top: Box[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    const box = readBox(bytes, offset, bytes.byteLength)
    if (box === 'bounds') return fail('盒子长度超出文件范围')
    if (box === 'bad') return fail('不是 fMP4')
    top.push(box)
    offset = box.end
  }
  let ftyp: Box | null = null
  let moov: Box | null = null
  const pairs: Array<{ moof: Box; mdat: Box }> = []
  let pending: Box | null = null
  for (const box of top) {
    if (box.type === 'moof' || box.type === 'mdat') {
      if (!pending) {
        pending = box
        continue
      }
      if (pending.type === box.type) return fail('不是 fMP4')
      const moof = pending.type === 'moof' ? pending : box
      const mdat = pending.type === 'mdat' ? pending : box
      pairs.push({ moof, mdat })
      pending = null
      continue
    }
    if (pending && !BETWEEN_PAIR.has(box.type)) return fail('不是 fMP4')
    if (box.type === 'ftyp') {
      if (ftyp) return fail('不是 fMP4')
      ftyp = box
      continue
    }
    if (box.type === 'moov') {
      if (moov) return fail('不是 fMP4')
      moov = box
      continue
    }
    if (!IGNORABLE.has(box.type)) return fail(`文件里有无法识别的盒子（${printableType(box.type)}）`)
  }
  if (pending) return fail('不是 fMP4')
  if (!moov) return fail('找不到 moov')
  if (!ftyp || pairs.length === 0) return fail('不是 fMP4')

  const moovChildren = readChildren(bytes, moov.start + moov.header, moov.end)
  if (moovChildren === 'bounds') return fail('盒子长度超出文件范围')
  if (moovChildren === 'bad') return fail('不是 fMP4')
  const encrypted = treeEncrypted(bytes, [moov])
  if (encrypted === 'bounds') return fail('盒子长度超出文件范围')
  if (encrypted === 'bad') return fail('不是 fMP4')
  if (encrypted) return fail('轨道已加密')

  const traks = moovChildren.filter((box) => box.type === 'trak')
  if (traks.length !== 1) return fail('输入包含多条轨道')
  const trak = traks[0]
  if (!trak) return fail('不是 fMP4')
  const mvhdBox = findOne(moovChildren, 'mvhd')
  const mvexBox = findOne(moovChildren, 'mvex')
  if (mvhdBox === 'many' || mvexBox === 'many') return fail('不是 fMP4')
  if (mvhdBox === 'missing' || mvexBox === 'missing') return fail('不是 fMP4')
  const mvhd = readMovieHeader(bytes, mvhdBox)
  if (!mvhd) return fail('时间刻度无效')

  const trakChildren = readChildren(bytes, trak.start + trak.header, trak.end)
  if (trakChildren === 'bounds') return fail('盒子长度超出文件范围')
  if (trakChildren === 'bad') return fail('不是 fMP4')
  const tkhdBox = findOne(trakChildren, 'tkhd')
  const mdiaBox = findOne(trakChildren, 'mdia')
  if (tkhdBox === 'many' || mdiaBox === 'many' || tkhdBox === 'missing' || mdiaBox === 'missing') return fail('不是 fMP4')
  const tkhd = readTrackHeader(bytes, tkhdBox)
  if (!tkhd) return fail('不是 fMP4')
  const mdiaChildren = readChildren(bytes, mdiaBox.start + mdiaBox.header, mdiaBox.end)
  if (mdiaChildren === 'bounds') return fail('盒子长度超出文件范围')
  if (mdiaChildren === 'bad') return fail('不是 fMP4')
  const mdhdBox = findOne(mdiaChildren, 'mdhd')
  const hdlrBox = findOne(mdiaChildren, 'hdlr')
  if (mdhdBox === 'many' || hdlrBox === 'many' || mdhdBox === 'missing' || hdlrBox === 'missing') return fail('不是 fMP4')
  const mdhd = readMediaHeader(bytes, mdhdBox)
  if (!mdhd) return fail('时间刻度无效')
  const handler = readHandler(bytes, hdlrBox)
  if (!handler) return fail('不是 fMP4')
  if (handler !== expectedHandler) {
    return fail(expectedHandler === 'vide' ? '视频输入不是视频轨' : '音频输入不是音频轨')
  }

  const mvexChildren = readChildren(bytes, mvexBox.start + mvexBox.header, mvexBox.end)
  if (mvexChildren === 'bounds') return fail('盒子长度超出文件范围')
  if (mvexChildren === 'bad') return fail('不是 fMP4')
  const trexBoxes = mvexChildren.filter((box) => box.type === 'trex')
  if (trexBoxes.length !== 1) return fail('输入包含多条轨道')
  const trexBox = trexBoxes[0]
  if (!trexBox) return fail('不是 fMP4')
  const trex = readTrex(bytes, trexBox)
  if (!trex) return fail('不是 fMP4')
  const mehd = mvexChildren.find((box) => box.type === 'mehd') ?? null

  const fragments = readFragments(bytes, pairs, trex)
  if (!Array.isArray(fragments)) return fragments
  let mediaDuration = mdhd.duration
  for (const fragment of fragments) {
    const end = fragment.decodeTime + fragment.duration
    if (end > mediaDuration) mediaDuration = end
  }
  return { ftyp, moov, mvhd, trak, tkhd, mdhd, trex, mehd, handler, fragments, mediaDuration }
}

function printableType(type: string): string {
  return /^[\u0020-\u007e]{4}$/.test(type) ? type : '????'
}

/** 和 hls-remux-duration 一样：换到目标 timescale 时四舍五入。 */
function scaleTicks(ticks: bigint, from: number, to: number): bigint | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) return null
  if (ticks < 0n) return null
  return (ticks * BigInt(to) + BigInt(from) / 2n) / BigInt(from)
}

function writeWidth(bytes: Uint8Array, offset: number, width: 4 | 8, value: bigint): boolean {
  if (value < 0n) return false
  if (offset < 0 || offset + width > bytes.byteLength) return false
  const view = viewOf(bytes)
  if (width === 4) {
    if (value > UINT32_MAX) return false
    view.setUint32(offset, Number(value))
    return true
  }
  view.setBigUint64(offset, value)
  return true
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
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

function wrapBox(type: string, payload: Uint8Array): Uint8Array | null {
  const size = 8 + payload.byteLength
  if (size > Number(UINT32_MAX)) return null
  const out = new Uint8Array(size)
  viewOf(out).setUint32(0, size)
  out[4] = type.charCodeAt(0)
  out[5] = type.charCodeAt(1)
  out[6] = type.charCodeAt(2)
  out[7] = type.charCodeAt(3)
  out.set(payload, 8)
  return out
}

function encodeTfhd(box: Box, info: TfhdInfo, trackId: number): Uint8Array | null {
  const flags = (info.flags & ~TFHD_BASE_DATA_OFFSET) | TFHD_DEFAULT_BASE_IS_MOOF
  const fields: number[] = []
  const push32 = (value: number): void => {
    fields.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
  }
  push32((info.version << 24) | flags)
  push32(trackId)
  if (info.sampleDescriptionIndex !== undefined) push32(info.sampleDescriptionIndex)
  if (info.defaultSampleDuration !== undefined) push32(info.defaultSampleDuration)
  if (info.defaultSampleSize !== undefined) push32(info.defaultSampleSize)
  if (info.defaultSampleFlags !== undefined) push32(info.defaultSampleFlags)
  // 读的时候如果标志位在但字段没读到，上面会是 undefined，盒子会变短。再用原始标志核对一次。
  if ((flags & TFHD_SAMPLE_DESC) !== 0 && info.sampleDescriptionIndex === undefined) return null
  if ((flags & TFHD_DEFAULT_DURATION) !== 0 && info.defaultSampleDuration === undefined) return null
  if ((flags & TFHD_DEFAULT_SIZE) !== 0 && info.defaultSampleSize === undefined) return null
  if ((flags & TFHD_DEFAULT_FLAGS) !== 0 && info.defaultSampleFlags === undefined) return null
  const payload = Uint8Array.from(fields)
  if (box.header !== 8) return null
  return wrapBox('tfhd', payload)
}

/** 保证 trun 带 data-offset。字段值先写 0，等 moof 大小确定后再改。 */
function encodeTrun(bytes: Uint8Array, trun: TrunInfo): Uint8Array | null {
  const copy = copyRange(bytes, trun.box.start, trun.box.end)
  if (trun.fieldAt >= 0) {
    viewOf(copy).setInt32(trun.fieldAt, 0)
    return copy
  }
  if (trun.box.header !== 8) return null
  const head = fullBox(copy, { type: 'trun', start: 0, header: 8, end: copy.byteLength })
  if (!head) return null
  const flags = head.flags | TRUN_DATA_OFFSET
  const payload = new Uint8Array(copy.byteLength - 8 + 4)
  viewOf(payload).setUint32(0, (head.version << 24) | flags)
  payload.set(copy.subarray(head.content, head.content + 4), 4)
  viewOf(payload).setInt32(8, 0)
  payload.set(copy.subarray(head.content + 4), 12)
  return wrapBox('trun', payload)
}

function rewriteMoof(
  bytes: Uint8Array,
  fragment: Fragment,
  trackId: number,
  sequence: number,
): Uint8Array | Fmp4MergeResult {
  const children = readChildren(bytes, fragment.moof.start + fragment.moof.header, fragment.moof.end)
  if (children === 'bounds') return fail('盒子长度超出文件范围')
  if (children === 'bad') return fail('不是 fMP4')
  const rebuilt: Uint8Array[] = []
  for (const child of children) {
    if (child.type === 'mfhd') {
      const copy = copyRange(bytes, child.start, child.end)
      const head = fullBox(copy, { type: 'mfhd', start: 0, header: child.header, end: copy.byteLength })
      if (!head || head.content + 4 > copy.byteLength) return fail('不是 fMP4')
      viewOf(copy).setUint32(head.content, sequence)
      rebuilt.push(copy)
      continue
    }
    if (child.type !== 'traf') {
      rebuilt.push(bytes.subarray(child.start, child.end))
      continue
    }
    const trafChildren = readChildren(bytes, child.start + child.header, child.end)
    if (trafChildren === 'bounds') return fail('盒子长度超出文件范围')
    if (trafChildren === 'bad') return fail('不是 fMP4')
    const trafParts: Uint8Array[] = []
    for (const inner of trafChildren) {
      if (inner.type === 'tfhd') {
        const info = readTfhd(bytes, inner)
        if (!info) return fail('盒子长度超出文件范围')
        const encoded = encodeTfhd(inner, info, trackId)
        if (!encoded) return fail('不是 fMP4')
        trafParts.push(encoded)
        continue
      }
      if (inner.type === 'trun') {
        const trun = fragment.runs.find((run) => run.trun.box.start === inner.start)?.trun
        if (!trun) return fail('不是 fMP4')
        const encoded = encodeTrun(bytes, trun)
        if (!encoded) return fail('无法确定样本在文件中的位置')
        trafParts.push(encoded)
        continue
      }
      trafParts.push(bytes.subarray(inner.start, inner.end))
    }
    const traf = wrapBox('traf', concatBytes(trafParts))
    if (!traf) return fail('不是 fMP4')
    rebuilt.push(traf)
  }
  // data_offset 的数值不改变盒子长度，所以可以先装出 moof，再按新大小回填。
  const draft = wrapBox('moof', concatBytes(rebuilt))
  if (!draft) return fail('不是 fMP4')
  const patched = patchDataOffsets(draft, fragment, draft.byteLength)
  if (typeof patched === 'string') return fail(patched)
  return patched
}

function patchDataOffsets(moof: Uint8Array, fragment: Fragment, moofSize: number): Uint8Array | string {
  const children = readChildren(moof, 8, moof.byteLength)
  if (children === 'bounds') return '盒子长度超出文件范围'
  if (children === 'bad') return '不是 fMP4'
  const payloadStart = fragment.mdat.start + fragment.mdat.header
  let runCursor = 0
  for (const child of children) {
    if (child.type !== 'traf') continue
    const inner = readChildren(moof, child.start + child.header, child.end)
    if (inner === 'bounds') return '盒子长度超出文件范围'
    if (inner === 'bad') return '不是 fMP4'
    for (const box of inner) {
      if (box.type !== 'trun') continue
      const run = fragment.runs[runCursor]
      runCursor += 1
      if (!run) return '不是 fMP4'
      const dataOffset = moofSize + fragment.mdat.header + (run.sampleStart - payloadStart)
      if (dataOffset > INT32_MAX || dataOffset < -INT32_MAX - 1) return '无法确定样本在文件中的位置'
      const head = fullBox(moof, box)
      if (!head) return '不是 fMP4'
      if ((head.flags & TRUN_DATA_OFFSET) === 0) return '不是 fMP4'
      viewOf(moof).setInt32(head.content + 4, dataOffset)
    }
  }
  if (runCursor !== fragment.runs.length) return '不是 fMP4'
  return moof
}

function patchTrack(bytes: Uint8Array, parsed: ParsedFile, trackId: number, movieDuration: bigint, mediaDuration: bigint): Uint8Array | null {
  const trak = copyRange(bytes, parsed.trak.start, parsed.trak.end)
  const tkhdAt = parsed.tkhd.box.start - parsed.trak.start
  if (!writeWidth(trak, tkhdAt + parsed.tkhd.trackIdAt, 4, BigInt(trackId))) return null
  if (!writeWidth(trak, tkhdAt + parsed.tkhd.durationAt, parsed.tkhd.durationWidth, movieDuration)) return null
  const mdhdAt = parsed.mdhd.box.start - parsed.trak.start
  if (!writeWidth(trak, mdhdAt + parsed.mdhd.durationAt, parsed.mdhd.durationWidth, mediaDuration)) return null
  return trak
}

function patchTrex(bytes: Uint8Array, trex: TrexInfo, trackId: number): Uint8Array | null {
  const copy = copyRange(bytes, trex.box.start, trex.box.end)
  const head = fullBox(copy, { type: 'trex', start: 0, header: trex.box.header, end: copy.byteLength })
  if (!head) return null
  viewOf(copy).setUint32(head.content, trackId)
  return copy
}

function patchMehd(bytes: Uint8Array, mehd: Box, duration: bigint): Uint8Array | null {
  const copy = copyRange(bytes, mehd.start, mehd.end)
  const head = fullBox(copy, { type: 'mehd', start: 0, header: mehd.header, end: copy.byteLength })
  if (!head) return null
  if (head.version === 0) {
    if (duration > UINT32_MAX || head.content + 4 > copy.byteLength) return null
    viewOf(copy).setUint32(head.content, Number(duration))
    return copy
  }
  if (head.version === 1) {
    if (head.content + 8 > copy.byteLength) return null
    viewOf(copy).setBigUint64(head.content, duration)
    return copy
  }
  return null
}

function buildMoov(
  videoBytes: Uint8Array,
  audioBytes: Uint8Array,
  video: ParsedFile,
  audio: ParsedFile,
  movieDuration: bigint,
): Fmp4MergeResult {
  const mvhd = copyRange(videoBytes, video.mvhd.box.start, video.mvhd.box.end)
  if (!writeWidth(mvhd, video.mvhd.durationAt, video.mvhd.durationWidth, movieDuration)) {
    return fail('时长超出文件头能写下的范围')
  }
  if (!writeWidth(mvhd, video.mvhd.nextTrackAt, 4, 3n)) return fail('不是 fMP4')

  const videoTrackDuration = scaleTicks(video.mediaDuration, video.mdhd.timescale, video.mvhd.timescale)
  const audioTrackDuration = scaleTicks(audio.mediaDuration, audio.mdhd.timescale, video.mvhd.timescale)
  if (videoTrackDuration === null || audioTrackDuration === null) return fail('时间刻度无效')
  const videoTrak = patchTrack(videoBytes, video, 1, videoTrackDuration, video.mediaDuration)
  const audioTrak = patchTrack(audioBytes, audio, 2, audioTrackDuration, audio.mediaDuration)
  if (!videoTrak || !audioTrak) return fail('时长超出文件头能写下的范围')

  const videoTrex = patchTrex(videoBytes, video.trex, 1)
  const audioTrex = patchTrex(audioBytes, audio.trex, 2)
  if (!videoTrex || !audioTrex) return fail('不是 fMP4')

  const mvexChildren: Uint8Array[] = []
  const mvexBox = readChildren(videoBytes, video.moov.start + video.moov.header, video.moov.end)
  if (mvexBox === 'bounds') return fail('盒子长度超出文件范围')
  if (mvexBox === 'bad') return fail('不是 fMP4')
  const mvex = mvexBox.find((box) => box.type === 'mvex')
  if (!mvex) return fail('不是 fMP4')
  const inner = readChildren(videoBytes, mvex.start + mvex.header, mvex.end)
  if (inner === 'bounds') return fail('盒子长度超出文件范围')
  if (inner === 'bad') return fail('不是 fMP4')
  for (const child of inner) {
    if (child.type === 'trex') continue
    if (child.type === 'mehd') {
      const patched = patchMehd(videoBytes, child, movieDuration)
      if (!patched) return fail('时长超出文件头能写下的范围')
      mvexChildren.push(patched)
      continue
    }
    mvexChildren.push(videoBytes.subarray(child.start, child.end))
  }
  mvexChildren.push(videoTrex, audioTrex)
  const mvexOut = wrapBox('mvex', concatBytes(mvexChildren))
  if (!mvexOut) return fail('不是 fMP4')

  const moovParts: Uint8Array[] = [mvhd, videoTrak, audioTrak, mvexOut]
  for (const child of mvexBox) {
    if (child.type === 'mvhd' || child.type === 'trak' || child.type === 'mvex') continue
    moovParts.push(videoBytes.subarray(child.start, child.end))
  }
  const moov = wrapBox('moov', concatBytes(moovParts))
  if (!moov) return fail('不是 fMP4')
  return { ok: true, bytes: moov }
}

interface OrderedFragment {
  time: bigint
  scale: number
  trackId: number
  index: number
  bytes: Uint8Array
  fragment: Fragment
}

export function mergeFmp4(video: Uint8Array, audio: Uint8Array, options: Fmp4MergeOptions = {}): Fmp4MergeResult {
  if (options.shouldAbort?.()) return cancelled()
  if (fmp4MergeExceedsLimit(video.byteLength, audio.byteLength)) return fail('视频和音频合计超过 1GB')
  const videoParsed = parseFile(video, 'vide')
  if ('ok' in videoParsed) return videoParsed
  const audioParsed = parseFile(audio, 'soun')
  if ('ok' in audioParsed) return audioParsed
  if (options.shouldAbort?.()) return cancelled()

  const videoMovie = scaleTicks(videoParsed.mediaDuration, videoParsed.mdhd.timescale, videoParsed.mvhd.timescale)
  const audioMovie = scaleTicks(audioParsed.mediaDuration, audioParsed.mdhd.timescale, videoParsed.mvhd.timescale)
  if (videoMovie === null || audioMovie === null) return fail('时间刻度无效')
  const movieDuration = videoMovie > audioMovie ? videoMovie : audioMovie
  const moov = buildMoov(video, audio, videoParsed, audioParsed, movieDuration)
  if (!('ok' in moov) || moov.ok !== true) return moov

  const ordered: OrderedFragment[] = []
  const sources = [
    { parsed: videoParsed, bytes: video, trackId: 1 },
    { parsed: audioParsed, bytes: audio, trackId: 2 },
  ]
  for (const source of sources) {
    source.parsed.fragments.forEach((fragment, index) => {
      ordered.push({
        time: fragment.decodeTime,
        scale: source.parsed.mdhd.timescale,
        trackId: source.trackId,
        index,
        bytes: source.bytes,
        fragment,
      })
    })
  }
  ordered.sort((left, right) => {
    const leftTick = left.time * BigInt(right.scale)
    const rightTick = right.time * BigInt(left.scale)
    if (leftTick < rightTick) return -1
    if (leftTick > rightTick) return 1
    if (left.trackId !== right.trackId) return left.trackId - right.trackId
    return left.index - right.index
  })

  const pieces: Uint8Array[] = [video.subarray(videoParsed.ftyp.start, videoParsed.ftyp.end), moov.bytes]
  for (let index = 0; index < ordered.length; index += 1) {
    if (options.shouldAbort?.()) return cancelled()
    const item = ordered[index]
    if (!item) return fail('不是 fMP4')
    const moof = rewriteMoof(item.bytes, item.fragment, item.trackId, index + 1)
    if (!('byteLength' in moof)) return moof
    pieces.push(moof)
    pieces.push(item.bytes.subarray(item.fragment.mdat.start, item.fragment.mdat.end))
  }
  if (options.shouldAbort?.()) return cancelled()
  return { ok: true, bytes: concatBytes(pieces) }
}
