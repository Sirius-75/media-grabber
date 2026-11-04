/**
 * 把 fMP4 的碎片时间轴归零。
 *
 * 直播源里的 tfdt 是录制时的绝对时间（例如 46560 秒），保存出来的 mp4
 * 在播放器里会从那个时间点开始，进度条也不对。这里只改 moof/traf/tfdt 里的
 * baseMediaDecodeTime，把每条轨道第一个 tfdt 换算成秒后取最小值 t0，
 * 每条轨道再减去 round(t0 × 自己的 timescale)。音视频之间的相对偏移保留。
 *
 * 只动 tfdt 的 4 / 8 字节，不重编码，不碰 mdat。为了不在内存里再复制整份，
 * 解析全部通过后直接在传入的字节上改；解析失败时不改任何字节。
 */

const UINT32_MAX = 0xffffffffn
const UINT64_MAX = 0xffffffffffffffffn

interface Box {
  type: string
  start: number
  header: number
  end: number
}

interface TfdtPatch {
  trackId: number
  /** tfdt 所在的媒体部分。 */
  part: Uint8Array
  /** tfdt 数值在字节里的位置。 */
  at: number
  width: 4 | 8
  value: bigint
}

interface TrackFirst {
  trackId: number
  timescale: number
  value: bigint
}

export type Fmp4RebaseResult =
  | { ok: true; parts: readonly Uint8Array[]; rebased: boolean }
  | { ok: false; error: string }

function fail(error: string): Fmp4RebaseResult {
  return { ok: false, error }
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  )
}

/** 读一个 box。size 为 0 表示延伸到当前范围末尾，size 为 1 表示后面跟 64 位长度。 */
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
    if (large < 16n || large > BigInt(Number.MAX_SAFE_INTEGER)) return 'bounds'
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

function fullBox(bytes: Uint8Array, box: Box): { version: number; content: number } | null {
  const content = box.start + box.header
  if (content + 4 > box.end) return null
  return { version: viewOf(bytes).getUint8(content), content: content + 4 }
}

function exactlyOne(children: Box[], type: string): Box | null {
  const found = children.filter((box) => box.type === type)
  return found.length === 1 ? (found[0] ?? null) : null
}

function readTrackId(bytes: Uint8Array, box: Box): number | null {
  const head = fullBox(bytes, box)
  if (!head) return null
  const view = viewOf(bytes)
  if (head.version === 0) {
    if (head.content + 12 > box.end) return null
    return view.getUint32(head.content + 8)
  }
  if (head.version === 1) {
    if (head.content + 20 > box.end) return null
    return view.getUint32(head.content + 16)
  }
  return null
}

function readTimescale(bytes: Uint8Array, box: Box): number | null {
  const head = fullBox(bytes, box)
  if (!head) return null
  const view = viewOf(bytes)
  if (head.version === 0) {
    if (head.content + 12 > box.end) return null
    const timescale = view.getUint32(head.content + 8)
    return timescale > 0 ? timescale : null
  }
  if (head.version === 1) {
    if (head.content + 20 > box.end) return null
    const timescale = view.getUint32(head.content + 16)
    return timescale > 0 ? timescale : null
  }
  return null
}

/** 从初始化段读出每个 trak 的 track_ID 和 mdhd timescale。 */
function readTrackTimescales(init: Uint8Array): Map<number, number> | null {
  const top = readChildren(init, 0, init.byteLength)
  if (top === 'bounds' || top === 'bad') return null
  const moov = exactlyOne(top, 'moov')
  if (!moov) return null
  const moovChildren = readChildren(init, moov.start + moov.header, moov.end)
  if (moovChildren === 'bounds' || moovChildren === 'bad') return null

  const tracks = new Map<number, number>()
  for (const trak of moovChildren) {
    if (trak.type !== 'trak') continue
    const trakChildren = readChildren(init, trak.start + trak.header, trak.end)
    if (trakChildren === 'bounds' || trakChildren === 'bad') return null
    const tkhd = exactlyOne(trakChildren, 'tkhd')
    const mdia = exactlyOne(trakChildren, 'mdia')
    if (!tkhd || !mdia) return null
    const trackId = readTrackId(init, tkhd)
    if (trackId === null || trackId === 0) return null
    const mdiaChildren = readChildren(init, mdia.start + mdia.header, mdia.end)
    if (mdiaChildren === 'bounds' || mdiaChildren === 'bad') return null
    const mdhd = exactlyOne(mdiaChildren, 'mdhd')
    if (!mdhd) return null
    const timescale = readTimescale(init, mdhd)
    if (timescale === null || tracks.has(trackId)) return null
    tracks.set(trackId, timescale)
  }
  return tracks.size > 0 ? tracks : null
}

function readTfhdTrackId(bytes: Uint8Array, box: Box): number | null {
  const head = fullBox(bytes, box)
  if (!head || head.content + 4 > box.end) return null
  const trackId = viewOf(bytes).getUint32(head.content)
  return trackId > 0 ? trackId : null
}

function readTfdt(bytes: Uint8Array, box: Box): { at: number; width: 4 | 8; value: bigint } | null {
  const head = fullBox(bytes, box)
  if (!head) return null
  const view = viewOf(bytes)
  if (head.version === 0) {
    if (head.content + 4 > box.end) return null
    return { at: head.content, width: 4, value: BigInt(view.getUint32(head.content)) }
  }
  if (head.version === 1) {
    if (head.content + 8 > box.end) return null
    return { at: head.content, width: 8, value: view.getBigUint64(head.content) }
  }
  return null
}

/**
 * 扫描所有媒体部分的 moof / traf / tfhd / tfdt。
 * 只收集位置和值，解析全部成功前不改字节。
 */
function collectPatches(
  fragments: readonly Uint8Array[],
  tracks: ReadonlyMap<number, number>,
): { patches: TfdtPatch[]; first: Map<number, TrackFirst> } | null {
  const patches: TfdtPatch[] = []
  const first = new Map<number, TrackFirst>()

  for (const part of fragments) {
    const top = readChildren(part, 0, part.byteLength)
    if (top === 'bounds' || top === 'bad') return null
    for (const box of top) {
      if (box.type !== 'moof') continue
      const moofChildren = readChildren(part, box.start + box.header, box.end)
      if (moofChildren === 'bounds' || moofChildren === 'bad') return null
      const trafs = moofChildren.filter((child) => child.type === 'traf')
      if (trafs.length === 0) return null
      for (const traf of trafs) {
        const trafChildren = readChildren(part, traf.start + traf.header, traf.end)
        if (trafChildren === 'bounds' || trafChildren === 'bad') return null
        const tfhd = exactlyOne(trafChildren, 'tfhd')
        if (!tfhd) return null
        const trackId = readTfhdTrackId(part, tfhd)
        if (trackId === null) return null
        const timescale = tracks.get(trackId)
        if (timescale === undefined) return null
        const tfdt = exactlyOne(trafChildren, 'tfdt')
        if (!tfdt) continue
        const decodeTime = readTfdt(part, tfdt)
        if (!decodeTime) return null
        patches.push({ trackId, part, ...decodeTime })
        if (!first.has(trackId)) first.set(trackId, { trackId, timescale, value: decodeTime.value })
      }
    }
  }
  return { patches, first }
}

/** 正数四舍五入：round(numerator / denominator)。 */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n)
}

function writePatch(bytes: Uint8Array, patch: TfdtPatch, value: bigint): void {
  const view = viewOf(bytes)
  if (patch.width === 4) view.setUint32(patch.at, Number(value))
  else view.setBigUint64(patch.at, value)
}

/** 在收集到的 tfdt 里找第一个时刻最小的那条轨道，用有理数比较避免浮点误差。 */
function earliestTrack(first: ReadonlyMap<number, TrackFirst>): TrackFirst | null {
  let earliest: TrackFirst | null = null
  for (const track of first.values()) {
    if (
      !earliest ||
      track.value * BigInt(earliest.timescale) < earliest.value * BigInt(track.timescale)
    ) {
      earliest = track
    }
  }
  return earliest
}

/**
 * 归零一份 fMP4 的时间轴。parts 的第一项是初始化段，后面是媒体分片。
 *
 * 成功时返回原数组（原地改过 tfdt）；没有 tfdt、或本来就从 0 开始时 rebased 为 false。
 * 解析不了时返回 ok:false，调用方应原样保存，且此时传入的字节不会被改动。
 */
export function rebaseFmp4Parts(parts: readonly Uint8Array[]): Fmp4RebaseResult {
  const init = parts[0]
  if (!init) return fail('没有初始化段')
  try {
    const tracks = readTrackTimescales(init)
    if (!tracks) return fail('初始化段里找不到轨道时间尺度')
    const collected = collectPatches(parts, tracks)
    if (!collected) return fail('分片里的 tfdt 结构无法解析')
    if (collected.patches.length === 0) return { ok: true, parts, rebased: false }
    const earliest = earliestTrack(collected.first)
    if (!earliest) return { ok: true, parts, rebased: false }

    // 每条轨道的时间轴都减同一个秒数 t0，因此 A/V 的相对偏移不变。
    const offsets = new Map<number, bigint>()
    for (const [trackId, timescale] of tracks) {
      const offset = roundDiv(earliest.value * BigInt(timescale), BigInt(earliest.timescale))
      if (offset < 0n) return fail('时间轴偏移无效')
      offsets.set(trackId, offset)
    }

    const nextValues: bigint[] = []
    for (const patch of collected.patches) {
      const offset = offsets.get(patch.trackId)
      if (offset === undefined) return fail('分片轨道不在初始化段里')
      const next = patch.value - offset
      if (next < 0n) return fail('减去起点后时间轴为负数')
      if (patch.width === 4 && next > UINT32_MAX) return fail('version 0 的 tfdt 超出 32 位范围')
      if (patch.width === 8 && next > UINT64_MAX) return fail('tfdt 超出 64 位范围')
      nextValues.push(next)
    }

    let rebased = false
    for (let index = 0; index < collected.patches.length; index += 1) {
      const patch = collected.patches[index]
      const next = nextValues[index]
      if (!patch || next === undefined) return fail('分片里的 tfdt 结构无法解析')
      if (patch.value === next) continue
      rebased = true
      // 所有校验都通过后才写，失败时不会留下改了一半的文件。
      writePatch(patch.part, patch, next)
    }
    return { ok: true, parts, rebased }
  } catch {
    return fail('解析 fMP4 时间轴失败')
  }
}
