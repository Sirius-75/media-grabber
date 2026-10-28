/**
 * 本地 http 服务支持 Range。用几十 MB 的随机字节核对并行下载和原文件的 sha256。
 * 不依赖 ffmpeg；没有外部网络。
 */
import { createHash, randomFillSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { fetchBilibiliFile } from '../src/shared/bilibili-file'

const SIZE = 20 * 1024 * 1024

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function listen(payload: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const total = payload.length
    const header = request.headers.range
    if (header) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(header)
      const start = match ? Number(match[1]) : Number.NaN
      const end = match && match[2] ? Number(match[2]) : total - 1
      if (!match || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= total) {
        response.writeHead(416, { 'Content-Range': `bytes */${total}` })
        response.end()
        return
      }
      const last = Math.min(end, total - 1)
      const slice = payload.subarray(start, last + 1)
      response.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${start}-${last}/${total}`,
      })
      response.end(slice)
      return
    }
    response.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(total),
    })
    response.end(payload)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/video.m4s`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()))
          }),
      })
    })
  })
}

describe('本地 Range 服务上的并行下载', () => {
  it('20MB 随机字节的 sha256 和原文件一致', async () => {
    const payload = Buffer.alloc(SIZE)
    randomFillSync(payload)
    const hash = sha256(payload)
    const server = await listen(payload)
    const original = globalThis.fetch
    const ranges: string[] = []
    let last = -1
    let decreased = false
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      const names = [...headers.keys()]
      if (names.length > 0) expect(names).toEqual(['range'])
      ranges.push(headers.get('range') ?? '')
      return original(input, init)
    }
    try {
      const result = await fetchBilibiliFile(server.url, new AbortController().signal, {
        retries: 0,
        role: 'video',
        onProgress(received, total) {
          if (received < last) decreased = true
          last = received
          expect(total).toBe(SIZE)
        },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.file.bytes.byteLength).toBe(SIZE)
      expect(result.file.ext).toBe('mp4')
      expect(sha256(result.file.bytes)).toBe(hash)
      expect(decreased).toBe(false)
      expect(last).toBe(SIZE)
      expect(ranges).toContain('bytes=0-0')
      expect(ranges).toContain('bytes=0-8388607')
      expect(ranges).toContain(`bytes=16777216-${SIZE - 1}`)
    } finally {
      globalThis.fetch = original
      await server.close()
    }
  }, 30_000)
})
