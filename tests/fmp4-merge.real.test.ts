import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeFmp4 } from '../src/shared/fmp4-merge'

function tool(name: string): boolean {
  try {
    execFileSync(name, ['-hide_banner', '-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const ready = tool('ffmpeg') && tool('ffprobe')

interface Probe {
  format: { duration?: string }
  streams: Array<{ codec_type?: string; codec_name?: string; duration?: string }>
}

function probe(file: string): Probe {
  const stdout = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { encoding: 'utf8' },
  )
  return JSON.parse(stdout) as Probe
}

function decode(file: string): string {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'ffmpeg 解码失败')
  return result.stderr
}

function encode(dir: string, name: string, input: string, extra: string[]): void {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', input, ...extra, path.join(dir, name)], { stdio: 'ignore' })
}

async function mergedFile(video: Uint8Array, audio: Uint8Array, dir: string): Promise<string> {
  const merged = mergeFmp4(video, audio)
  expect(merged.ok).toBe(true)
  if (!merged.ok) throw new Error(merged.error)
  const out = path.join(dir, 'out.mp4')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(out, merged.bytes)
  return out
}

describe.skipIf(!ready)('真实 fMP4 合并', () => {
  it('10 秒 h264 + aac 能被 ffprobe 认成两条流，并且无报错解码', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fmp4-merge-'))
    try {
      encode(dir, 'v.mp4', 'testsrc=duration=10:size=320x240:rate=25', [
        '-c:v',
        'libx264',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
      ])
      encode(dir, 'a.mp4', 'sine=frequency=440:duration=10', [
        '-c:a',
        'aac',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
      ])
      const out = await mergedFile(await readFile(path.join(dir, 'v.mp4')), await readFile(path.join(dir, 'a.mp4')), dir)
      const info = probe(out)
      const video = info.streams.find((stream) => stream.codec_type === 'video')
      const audio = info.streams.find((stream) => stream.codec_type === 'audio')
      expect(video?.codec_name).toBe('h264')
      expect(audio?.codec_name).toBe('aac')
      expect(info.streams.filter((stream) => stream.codec_type === 'video' || stream.codec_type === 'audio')).toHaveLength(2)
      const duration = Number(info.format.duration)
      expect(duration).toBeGreaterThan(9.5)
      expect(duration).toBeLessThan(11.5)
      expect(decode(out)).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('带 sidx 的输入合并后仍能解码，音频较短时总时长跟视频走', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fmp4-merge-'))
    try {
      encode(dir, 'v.mp4', 'testsrc=duration=10:size=320x240:rate=25', [
        '-c:v',
        'libx264',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof+dash',
      ])
      encode(dir, 'a.mp4', 'sine=frequency=440:duration=8', [
        '-c:a',
        'aac',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof+dash',
      ])
      const video = await readFile(path.join(dir, 'v.mp4'))
      const audio = await readFile(path.join(dir, 'a.mp4'))
      expect(Buffer.from(video).includes(Buffer.from('sidx'))).toBe(true)
      const out = await mergedFile(video, audio, dir)
      const merged = await readFile(out)
      expect(topTypes(merged)).not.toContain('sidx')
      const info = probe(out)
      expect(info.streams.map((stream) => stream.codec_name).sort()).toEqual(['aac', 'h264'])
      const duration = Number(info.format.duration)
      expect(duration).toBeGreaterThan(9.5)
      expect(duration).toBeLessThan(11.5)
      const audioDuration = Number(info.streams.find((stream) => stream.codec_type === 'audio')?.duration)
      expect(audioDuration).toBeGreaterThan(7)
      expect(audioDuration).toBeLessThan(9)
      expect(decode(out)).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function topTypes(bytes: Uint8Array): string[] {
  const types: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset)
    types.push(String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0))
    if (size < 8) break
    offset += size
  }
  return types
}
