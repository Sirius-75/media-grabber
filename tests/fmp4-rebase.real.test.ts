import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { rebaseFmp4Parts } from '../src/shared/fmp4-rebase'

function hasFfmpeg(): boolean {
  try {
    return (
      spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
      spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0
    )
  } catch {
    return false
  }
}

const available = hasFfmpeg()
const workdir = available ? mkdtempSync(join(tmpdir(), 'media-grabber-fmp4-rebase-')) : undefined

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true })
})

interface Box {
  type: string
  start: number
  header: number
  end: number
}

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4] ?? 0,
    bytes[offset + 5] ?? 0,
    bytes[offset + 6] ?? 0,
    bytes[offset + 7] ?? 0,
  )
}

function readBox(bytes: Uint8Array, offset: number, limit: number): Box {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size32 = view.getUint32(offset)
  const type = boxType(bytes, offset)
  if (size32 === 1) {
    const size = Number(view.getBigUint64(offset + 8))
    return { type, start: offset, header: 16, end: offset + size }
  }
  const size = size32 === 0 ? limit - offset : size32
  return { type, start: offset, header: 8, end: offset + size }
}

function readBoxes(bytes: Uint8Array, start = 0, end = bytes.byteLength): Box[] {
  const boxes: Box[] = []
  let offset = start
  while (offset < end) {
    const box = readBox(bytes, offset, end)
    boxes.push(box)
    offset = box.end
  }
  return boxes
}

function children(bytes: Uint8Array, box: Box): Box[] {
  return readBoxes(bytes, box.start + box.header, box.end)
}

function one(boxes: Box[], type: string): Box {
  const found = boxes.filter((box) => box.type === type)
  if (found.length !== 1) throw new Error(`expected one ${type}`)
  return found[0]!
}

function trackTimescales(init: Uint8Array): Map<number, number> {
  const tracks = new Map<number, number>()
  const moov = one(readBoxes(init), 'moov')
  for (const trak of children(init, moov).filter((box) => box.type === 'trak')) {
    const trakChildren = children(init, trak)
    const tkhd = one(trakChildren, 'tkhd')
    const mdia = one(trakChildren, 'mdia')
    const mdhd = one(children(init, mdia), 'mdhd')
    const view = new DataView(init.buffer, init.byteOffset, init.byteLength)
    const tkhdContent = tkhd.start + tkhd.header + 4
    const tkhdVersion = init[tkhd.start + tkhd.header] ?? 0
    const trackId = view.getUint32(tkhdContent + (tkhdVersion === 0 ? 8 : 16))
    const mdhdContent = mdhd.start + mdhd.header + 4
    const mdhdVersion = init[mdhd.start + mdhd.header] ?? 0
    const timescale = view.getUint32(mdhdContent + (mdhdVersion === 0 ? 8 : 16))
    tracks.set(trackId, timescale)
  }
  return tracks
}

/** ffmpeg 的 fMP4 muxer 会把 tfdt 写成从 0 开始，这里把整条时间轴抬到直播绝对时间。 */
function shiftTimeline(file: Uint8Array, offsetSeconds: number): Uint8Array {
  const copy = file.slice()
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  const top = readBoxes(copy)
  const firstMoof = top.findIndex((box) => box.type === 'moof')
  const init = copy.subarray(0, top[firstMoof]?.start ?? copy.byteLength)
  const tracks = trackTimescales(init)
  for (const moof of top.filter((box) => box.type === 'moof')) {
    for (const traf of children(copy, moof).filter((box) => box.type === 'traf')) {
      const trafChildren = children(copy, traf)
      const tfhd = one(trafChildren, 'tfhd')
      const trackId = view.getUint32(tfhd.start + tfhd.header + 4)
      const timescale = tracks.get(trackId)
      if (!timescale) throw new Error(`missing timescale for track ${trackId}`)
      const tfdt = one(trafChildren, 'tfdt')
      const content = tfdt.start + tfdt.header + 4
      const version = copy[tfdt.start + tfdt.header] ?? 0
      const offset = BigInt(Math.round(offsetSeconds * timescale))
      if (version === 0) view.setUint32(content, view.getUint32(content) + Number(offset))
      else view.setBigUint64(content, view.getBigUint64(content) + offset)
    }
  }
  return copy
}

function splitFmp4(file: Uint8Array): Uint8Array[] {
  const top = readBoxes(file)
  const firstMoof = top.findIndex((box) => box.type === 'moof')
  if (firstMoof < 0) throw new Error('no moof')
  const firstStart = top[firstMoof]!.start
  return [file.slice(0, firstStart), ...top.slice(firstMoof).map((box) => file.slice(box.start, box.end))]
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

interface Probe {
  start: number
  duration: number
  streams: Array<{ type: string; start: number }>
}

function probe(path: string): Probe {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=start_time,duration',
      '-show_entries',
      'stream=codec_type,start_time',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr)
  const parsed = JSON.parse(result.stdout) as {
    format: { start_time?: string; duration?: string }
    streams?: Array<{ codec_type: string; start_time?: string }>
  }
  return {
    start: Number(parsed.format.start_time ?? 0),
    duration: Number(parsed.format.duration ?? 0),
    streams: (parsed.streams ?? []).map((stream) => ({
      type: stream.codec_type,
      start: Number(stream.start_time ?? 0),
    })),
  }
}

function decodeErrors(path: string): string {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, '-f', 'null', '-'], {
    encoding: 'utf8',
  })
  expect(result.status).toBe(0)
  return result.stderr.trim()
}

describe.skipIf(!available)('fMP4 时间轴归零的真实文件', () => {
  it('ffmpeg 生成的 A/V fMP4 抬高到 46560 秒后，归零仍能完整解码且时长不变', () => {
    if (!workdir) return
    const inputPath = join(workdir, 'source.mp4')
    const shiftedPath = join(workdir, 'shifted.mp4')
    const outputPath = join(workdir, 'fixed.mp4')

    const generated = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '3',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        // 新版 ffmpeg 的 mp4 muxer 会把 tfdt 归零，下面再把时间轴整体抬到直播绝对时间。
        '-output_ts_offset',
        '46560',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
        '-f',
        'mp4',
        inputPath,
      ],
      { stdio: 'ignore' },
    )
    expect(generated.status).toBe(0)

    const baseline = probe(inputPath)
    const shifted = shiftTimeline(new Uint8Array(readFileSync(inputPath)), 46560)
    writeFileSync(shiftedPath, shifted)
    const shiftedProbe = probe(shiftedPath)
    expect(shiftedProbe.start).toBeGreaterThan(46_000)

    const result = rebaseFmp4Parts(splitFmp4(shifted))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rebased).toBe(true)
    writeFileSync(outputPath, concat(result.parts))

    const fixed = probe(outputPath)
    expect(fixed.start).toBeLessThan(0.2)
    expect(Math.abs(fixed.duration - baseline.duration)).toBeLessThan(0.1)
    expect(fixed.streams.find((stream) => stream.type === 'video')?.start).toBeLessThan(0.2)
    expect(fixed.streams.find((stream) => stream.type === 'audio')?.start).toBeLessThan(0.2)
    expect(decodeErrors(outputPath)).toBe('')
  }, 60_000)
})
