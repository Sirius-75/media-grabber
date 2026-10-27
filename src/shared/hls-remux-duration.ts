/**
 * 把 mux.js 初始化段里的未知时长写成真实总时长。
 *
 * mux.js 6.3 把 moov/mvhd 和每个 trak/tkhd 的 duration 写成 0xFFFFFFFF。
 * mvhd 的 timescale 是 90000，只读文件头的播放器会显示成约 13 小时。
 * 分片里的 tfdt 是对的，这里不动媒体段，只改初始化段的一份拷贝。
 *
 * 总时长是最后一片的 nextBaseMediaDecodeTime，单位 90kHz。
 * mvhd.duration 和 tkhd.duration 用 movie timescale（mvhd 里的 timescale）。
 * 每个 mdhd.duration 用该轨自己的 timescale，即总秒数乘以该轨 timescale。
 *
 * 按 size 遍历 moov → trak → tkhd / mdia → mdhd，兼容 version 0 和 version 1。
 * 找不到、装不下（version 0 的时长超过 32 位）或格式异常时返回入参本身，不抛错。
 */

const CLOCK_90KHZ = 90000n
const UINT32_MAX = 0xffffffffn
const UINT64_MAX = 0xffffffffffffffffn

interface Box {
  type: string
  start: number
  header: number
  end: number
}

interface MediaClock {
  offset: number
  width: 4 | 8
  timescale: number
}

interface TrackDuration {
  offset: number
  width: 4 | 8
}

interface BytePatch {
  offset: number
  width: 4 | 8
  value: bigint
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0)
}

/** 读一个 box。size 为 0 表示一直延伸到当前范围末尾，size 为 1 表示后面是 64 位 largesize。 */
function readBox(bytes: Uint8Array, view: DataView, offset: number, limit: number): Box | null {
  if (offset < 0 || limit - offset < 8) return null
  const size32 = view.getUint32(offset)
  const type = boxType(bytes, offset)
  let header = 8
  let size = size32
  if (size32 === 1) {
    if (limit - offset < 16) return null
    const large = view.getBigUint64(offset + 8)
    if (large < 16n || large > BigInt(Number.MAX_SAFE_INTEGER)) return null
    size = Number(large)
    header = 16
  } else if (size32 === 0) {
    size = limit - offset
  } else if (size32 < 8) {
    return null
  }
  if (size < header) return null
  const end = offset + size
  if (end < offset || end > limit) return null
  return { type, start: offset, header, end }
}

/** 子 box 必须正好铺满父范围。中间断了或尾部剩半个 box，都当作格式异常。 */
function readChildren(bytes: Uint8Array, view: DataView, start: number, end: number): Box[] | null {
  const boxes: Box[] = []
  let offset = start
  while (offset < end) {
    const box = readBox(bytes, view, offset, end)
    if (!box || box.end <= offset) return null
    boxes.push(box)
    offset = box.end
  }
  return boxes
}

/**
 * mvhd / mdhd 的 timescale 和 duration 位置相同。
 * version 0 是 32 位，version 1 是 64 位。
 */
function readMediaClock(view: DataView, box: Box): MediaClock | null {
  const base = box.start + box.header
  if (base >= box.end) return null
  const version = view.getUint8(base)
  if (version === 0) {
    const timescaleAt = base + 12
    const durationAt = base + 16
    if (durationAt + 4 > box.end) return null
    const timescale = view.getUint32(timescaleAt)
    if (timescale === 0) return null
    return { offset: durationAt, width: 4, timescale }
  }
  if (version === 1) {
    const timescaleAt = base + 20
    const durationAt = base + 24
    if (durationAt + 8 > box.end) return null
    const timescale = view.getUint32(timescaleAt)
    if (timescale === 0) return null
    return { offset: durationAt, width: 8, timescale }
  }
  return null
}

/** tkhd 没有自己的 timescale，时长用 movie timescale。 */
function readTrackDuration(view: DataView, box: Box): TrackDuration | null {
  const base = box.start + box.header
  if (base >= box.end) return null
  const version = view.getUint8(base)
  if (version === 0) {
    const durationAt = base + 20
    if (durationAt + 4 > box.end) return null
    return { offset: durationAt, width: 4 }
  }
  if (version === 1) {
    const durationAt = base + 28
    if (durationAt + 8 > box.end) return null
    return { offset: durationAt, width: 8 }
  }
  return null
}

/** 把 90kHz 的总刻度换算成某一 timescale 下的时长，四舍五入。 */
function scale90k(totalTicks: bigint, timescale: number): bigint | null {
  if (!Number.isInteger(timescale) || timescale <= 0) return null
  return (totalTicks * BigInt(timescale) + CLOCK_90KHZ / 2n) / CLOCK_90KHZ
}

function fits(value: bigint, width: 4 | 8): boolean {
  if (value < 0n) return false
  if (width === 4) return value <= UINT32_MAX
  return value <= UINT64_MAX
}

function planDurationPatches(initSegment: Uint8Array, totalDuration90kHz: number): BytePatch[] | null {
  if (!Number.isFinite(totalDuration90kHz) || totalDuration90kHz < 0) return null
  const rounded = Math.round(totalDuration90kHz)
  if (!Number.isSafeInteger(rounded) || rounded < 0) return null

  const ticks = BigInt(rounded)
  const view = viewOf(initSegment)
  const top = readChildren(initSegment, view, 0, initSegment.byteLength)
  if (!top) return null
  const moovs = top.filter((box) => box.type === 'moov')
  if (moovs.length !== 1) return null
  const moov = moovs[0]
  if (!moov) return null

  const children = readChildren(initSegment, view, moov.start + moov.header, moov.end)
  if (!children) return null
  const mvhds = children.filter((box) => box.type === 'mvhd')
  if (mvhds.length !== 1) return null
  const mvhdBox = mvhds[0]
  if (!mvhdBox) return null
  const mvhd = readMediaClock(view, mvhdBox)
  if (!mvhd) return null
  const movieDuration = scale90k(ticks, mvhd.timescale)
  if (movieDuration === null || !fits(movieDuration, mvhd.width)) return null

  const patches: BytePatch[] = [{ offset: mvhd.offset, width: mvhd.width, value: movieDuration }]
  for (const child of children) {
    if (child.type !== 'trak') continue
    const trakChildren = readChildren(initSegment, view, child.start + child.header, child.end)
    if (!trakChildren) return null
    const tkhds = trakChildren.filter((box) => box.type === 'tkhd')
    const mdias = trakChildren.filter((box) => box.type === 'mdia')
    if (tkhds.length !== 1 || mdias.length !== 1) return null
    const tkhdBox = tkhds[0]
    const mdia = mdias[0]
    if (!tkhdBox || !mdia) return null
    const tkhd = readTrackDuration(view, tkhdBox)
    if (!tkhd || !fits(movieDuration, tkhd.width)) return null
    patches.push({ offset: tkhd.offset, width: tkhd.width, value: movieDuration })

    const mdiaChildren = readChildren(initSegment, view, mdia.start + mdia.header, mdia.end)
    if (!mdiaChildren) return null
    const mdhds = mdiaChildren.filter((box) => box.type === 'mdhd')
    if (mdhds.length !== 1) return null
    const mdhdBox = mdhds[0]
    if (!mdhdBox) return null
    const mdhd = readMediaClock(view, mdhdBox)
    if (!mdhd) return null
    const trackDuration = scale90k(ticks, mdhd.timescale)
    if (trackDuration === null || !fits(trackDuration, mdhd.width)) return null
    patches.push({ offset: mdhd.offset, width: mdhd.width, value: trackDuration })
  }
  return patches
}

/**
 * 修补初始化段里的 mvhd / tkhd / mdhd duration。
 * 成功时返回新的字节；修不了时返回入参本身。
 */
export function patchInitSegmentDuration(initSegment: Uint8Array, totalDuration90kHz: number): Uint8Array {
  try {
    const patches = planDurationPatches(initSegment, totalDuration90kHz)
    if (!patches) return initSegment
    const copy = new Uint8Array(initSegment)
    const view = viewOf(copy)
    for (const patch of patches) {
      if (patch.width === 4) view.setUint32(patch.offset, Number(patch.value))
      else view.setBigUint64(patch.offset, patch.value)
    }
    return copy
  } catch {
    return initSegment
  }
}
