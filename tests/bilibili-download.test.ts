/**
 * 示例数据。响应体是手写的 fMP4 盒子，不是真实文件。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BILIBILI_TEXT } from '../src/shared/bilibili'
import { decideSaveExt, fetchBilibiliFile, handlerKind } from '../src/shared/bilibili-file'
import { HLS_TEXT } from '../src/shared/hls'
import { runBilibiliDownload } from '../src/offscreen/bilibili-task'

function fourcc(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0))
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength)
  const size = out.byteLength
  out[0] = (size >>> 24) & 0xff
  out[1] = (size >>> 16) & 0xff
  out[2] = (size >>> 8) & 0xff
  out[3] = size & 0xff
  out.set(fourcc(type), 4)
  out.set(payload, 8)
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

/** hdlr 正文第 8 字节起是 handler。 */
function hdlr(handler: 'vide' | 'soun'): Uint8Array {
  const payload = new Uint8Array(12)
  payload.set(fourcc(handler), 8)
  return box('hdlr', payload)
}

function sampleFile(handler: 'vide' | 'soun'): Uint8Array {
  const track = box('trak', box('mdia', hdlr(handler)))
  const decoy = box('mdat', fourcc('vide'))
  return concat([decoy, box('moov', track)])
}

function responseOf(status: number, bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Response(copy.buffer, { status, headers })
}

describe('保存扩展名（示例数据）', () => {
  it('已知轨道直接定扩展名', () => {
    expect(decideSaveExt('video', 'audio/mp4', new Uint8Array())).toEqual({ ext: 'mp4', mime: 'video/mp4' })
    expect(decideSaveExt('audio', 'video/mp4', new Uint8Array())).toEqual({ ext: 'm4a', mime: 'audio/mp4' })
    expect(decideSaveExt('file', undefined, new Uint8Array())).toEqual({ ext: 'mp4', mime: 'video/mp4' })
  })

  it('类型未知时先看 Content-Type，再看 moov 里的 handler', () => {
    expect(decideSaveExt('unknown', 'audio/mp4', sampleFile('vide'))).toEqual({ ext: 'm4a', mime: 'audio/mp4' })
    expect(decideSaveExt('unknown', 'video/mp4', sampleFile('soun'))).toEqual({ ext: 'mp4', mime: 'video/mp4' })
    expect(handlerKind(sampleFile('vide'))).toBe('video')
    expect(handlerKind(sampleFile('soun'))).toBe('audio')
    expect(decideSaveExt('unknown', undefined, sampleFile('soun'))).toEqual({ ext: 'm4a', mime: 'audio/mp4' })
    expect(decideSaveExt('unknown', 'application/octet-stream', new Uint8Array([1, 2, 3]))).toEqual({
      ext: 'mp4',
      mime: 'video/mp4',
      note: BILIBILI_TEXT.uncertain,
    })
  })
})

describe('拉取单个文件（示例数据）', () => {
  const url = 'https://upos-example.bilivideo.com/example-data/video.m4s?token=sample'

  it('fetch 不带自定义头，403 和 401 用中文报错且不重试', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined()
      expect(init?.credentials).toBe('include')
      expect(init?.redirect).toBe('follow')
      return responseOf(403, new Uint8Array())
    })
    const result = await fetchBilibiliFile(url, new AbortController().signal, {
      fetchImpl,
      retries: 2,
      retryDelayMs: 0,
      role: 'video',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: false, error: HLS_TEXT.forbidden, status: 403 })

    fetchImpl.mockImplementation(async () => responseOf(401, new Uint8Array()))
    const denied = await fetchBilibiliFile(url, new AbortController().signal, {
      fetchImpl,
      retries: 2,
      retryDelayMs: 0,
    })
    expect(denied).toMatchObject({ ok: false, error: HLS_TEXT.unauthorized, status: 401 })
  })

  it('206 不当成完整文件', async () => {
    const fetchImpl = vi.fn(async () => responseOf(206, sampleFile('vide')))
    const result = await fetchBilibiliFile(url, new AbortController().signal, {
      fetchImpl,
      retries: 0,
      role: 'unknown',
    })
    expect(result).toEqual({ ok: false, error: BILIBILI_TEXT.partial, status: 206 })
  })

  it('未知类型按 handler 存成 m4a', async () => {
    const bytes = sampleFile('soun')
    const fetchImpl = vi.fn(async () => responseOf(200, bytes, { 'Content-Type': 'application/octet-stream' }))
    const result = await fetchBilibiliFile(url, new AbortController().signal, {
      fetchImpl,
      retries: 0,
      role: 'unknown',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.ext).toBe('m4a')
    expect(result.file.bytes).toEqual(bytes)
  })
})

describe('offscreen 任务不碰扩展 API（示例数据）', () => {
  it('视频和音频各存一份，文件名靠扩展名区分', async () => {
    const saved: Array<{ filename: string; type: string }> = []
    const writes: string[] = []
    const video = sampleFile('vide')
    const audio = sampleFile('soun')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const target = String(input)
      if (target.includes('audio')) return responseOf(200, audio, { 'Content-Type': 'audio/mp4' })
      return responseOf(200, video, { 'Content-Type': 'video/mp4' })
    })
    const controller = new AbortController()
    const outcome = await runBilibiliDownload(
      {
        key: 'https://cdn.example.test/example-data/video.m4s',
        title: '示例标题',
        index: 2,
        files: [
          { url: 'https://cdn.example.test/example-data/video.m4s', role: 'video' },
          { url: 'https://cdn.example.test/example-data/audio.m4s', role: 'audio' },
        ],
      },
      controller,
      {
        still: () => true,
        clear: () => undefined,
        write: async (_key, record) => {
          writes.push(record.message)
        },
      },
      {
        fetchImpl,
        save: async (_parts, mime, filename) => {
          saved.push({ filename, type: mime })
          return { ok: true, downloadId: 1 }
        },
      },
    )
    expect(outcome).toEqual({ ok: true })
    expect(saved.map((file) => file.filename)).toEqual(['示例标题-2.mp4', '示例标题-2.m4a'])
    expect(saved.map((file) => file.type)).toEqual(['video/mp4', 'audio/mp4'])
    expect(writes.at(-1)).toContain('分开保存')
  })

  it('源码里没有 chrome，DNR 只出现在后台', () => {
    const offscreen = readdirSync(join(process.cwd(), 'src/offscreen')).filter((name) => name.endsWith('.ts'))
    expect(offscreen).toContain('bilibili-task.ts')
    for (const name of offscreen) {
      const text = readFileSync(join(process.cwd(), 'src/offscreen', name), 'utf8')
      expect(text, name).not.toMatch(/chrome\.(storage|downloads|tabs|declarativeNetRequest)\b/)
    }
    const task = readFileSync(join(process.cwd(), 'src/offscreen/bilibili-task.ts'), 'utf8')
    expect(task).not.toMatch(/\bchrome\b/)

    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8')
          if (text.includes('chrome.declarativeNetRequest')) hits.push(full)
        }
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(hits).toEqual([join(process.cwd(), 'src/background/bilibili-rules.ts')])
  })
})
