import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { HLS_TEXT, describeKeyFetchFailure, parseHlsPlaylist } from '../src/shared/hls'
import { decryptAes128Segment, decryptDownloadedParts, loadAes128Keys } from '../src/shared/hls-aes'
import { downloadSegmentsInOrder } from '../src/shared/hls-download'
import { fetchSegmentBytes, type SegmentFetchResult } from '../src/shared/hls-fetch'
import { planHlsSave } from '../src/shared/hls-remux'
import { transmuxTsSegment } from '../src/shared/hls-remux-mux'

/** mux.js 自带的真实 TS。加密前首字节是同步字节 0x47。 */
const SAMPLE_PATH = 'node_modules/mux.js/test/segments/test-middle-pat-pmt.ts'
const PLAYLIST = 'https://cdn.example/hls/index.m3u8'

const KEY_A = Uint8Array.from({ length: 16 }, (_, index) => index + 1)
const KEY_B = Uint8Array.from({ length: 16 }, (_, index) => 200 - index)

function concat(parts: readonly Uint8Array[]): Uint8Array {
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

async function encryptAes128(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['encrypt'])
  const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: toArrayBuffer(iv) }, cryptoKey, toArrayBuffer(plain))
  return new Uint8Array(cipher)
}

function fetchFrom(files: ReadonlyMap<string, Uint8Array>, statuses?: ReadonlyMap<string, number>) {
  return async (url: string, signal: AbortSignal): Promise<SegmentFetchResult> => {
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const status = statuses?.get(url)
    if (status !== undefined) return { ok: false, status }
    const bytes = files.get(url)
    if (!bytes) return { ok: false, status: 404 }
    return { ok: true, bytes: new Uint8Array(bytes) }
  }
}

describe('取密钥', () => {
  const segment = {
    url: 'https://cdn.example/a.ts',
    aes128: { keyUrl: 'https://cdn.example/k1', iv: new Uint8Array(16) },
  }

  it('401、403、网络错误和长度不对都给出中文，不把密钥写进文案', async () => {
    const signal = new AbortController().signal
    const cases: Array<{ status?: number; body?: Uint8Array; error: string }> = [
      { status: 401, error: HLS_TEXT.keyUnauthorized },
      { status: 403, error: HLS_TEXT.keyForbidden },
      { status: 0, error: HLS_TEXT.keyNetwork },
      { status: 404, error: HLS_TEXT.keyMissing },
      { status: 500, error: describeKeyFetchFailure(500) },
      { body: Uint8Array.of(1, 2, 3), error: HLS_TEXT.keyLength },
    ]
    for (const item of cases) {
      const fetched = await loadAes128Keys({
        segments: [segment],
        signal,
        fetchBytes: async () => {
          if (item.body) return { ok: true, bytes: item.body }
          return { ok: false, status: item.status ?? 0 }
        },
      })
      expect(fetched.ok).toBe(false)
      if (fetched.ok) return
      expect(fetched.error).toBe(item.error)
      expect(fetched.error).not.toContain('cdn.example')
      expect(fetched.error).not.toMatch(/[0-9a-f]{32}/i)
    }
  })

  it('同一个密钥地址只取一次，并且默认 fetch 不带自定义请求头', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.endsWith('/k1')) return new Response(KEY_A)
      return new Response(null, { status: 403 })
    })
    const signal = new AbortController().signal
    const loaded = await loadAes128Keys({
      segments: [segment, { ...segment, url: 'https://cdn.example/b.ts' }],
      signal,
      fetchBytes: (url, inner) => fetchSegmentBytes(url, inner),
    })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.keys.size).toBe(1)
    expect([...loaded.keys.get('https://cdn.example/k1')!]).toEqual([...KEY_A])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init.headers).toBeUndefined()
    expect(calls[0]?.init.credentials).toBe('include')
    vi.unstubAllGlobals()
  })

  it('取消时不再继续取密钥', async () => {
    const controller = new AbortController()
    controller.abort()
    const loaded = await loadAes128Keys({
      segments: [segment],
      signal: controller.signal,
      fetchBytes: async () => ({ ok: true, bytes: KEY_A }),
    })
    expect(loaded).toEqual({ ok: false, cancelled: true, error: HLS_TEXT.cancelled })
  })
})

describe('解密', () => {
  it('长度不是 16 的整数倍时直接拒绝，不去解密', async () => {
    const result = await decryptAes128Segment(Uint8Array.of(0x47, 1, 2, 3, 4), KEY_A, new Uint8Array(16))
    expect(result).toEqual({ ok: false, error: HLS_TEXT.cipherLength })
  })

  it('密钥或 IV 不对，以及明文不是 TS，都报解密失败', async () => {
    const plain = Uint8Array.of(0x47, 0x11, 0x22, 0x33)
    const iv = new Uint8Array(16)
    iv[15] = 4
    const cipher = await encryptAes128(plain, KEY_A, iv)
    const wrongKey = await decryptAes128Segment(cipher, KEY_B, iv)
    expect(wrongKey).toEqual({ ok: false, error: HLS_TEXT.decryptFailed })
    const wrongIv = new Uint8Array(16)
    wrongIv[15] = 5
    const wrong = await decryptAes128Segment(cipher, KEY_A, wrongIv)
    expect(wrong).toEqual({ ok: false, error: HLS_TEXT.decryptFailed })

    const notTs = await encryptAes128(Uint8Array.of(0x00, 0x11, 0x22, 0x33), KEY_A, iv)
    const decoded = await decryptAes128Segment(notTs, KEY_A, iv)
    expect(decoded).toEqual({ ok: false, error: HLS_TEXT.decryptFailed })
  })

  it('分片密文不是整倍数时，整次解密失败且不改其它片', async () => {
    const iv = new Uint8Array(16)
    const result = await decryptDownloadedParts({
      parts: [Uint8Array.of(1, 2, 3, 4, 5)],
      initCount: 0,
      segments: [{ url: 'https://cdn.example/a.ts', aes128: { keyUrl: 'https://cdn.example/k1', iv } }],
      keys: new Map([['https://cdn.example/k1', KEY_A]]),
    })
    expect(result).toEqual({ ok: false, error: HLS_TEXT.cipherLength })
  })
})

describe('AES-128 点播完整流程', () => {
  it('用真实 TS 加密、密钥轮换和解密后，转封装成 mp4；转失败则保存明文 ts', async () => {
    const sample = new Uint8Array(readFileSync(SAMPLE_PATH))
    expect(sample[0]).toBe(0x47)
    const ivA = new Uint8Array(16)
    ivA[15] = 7
    const ivB = new Uint8Array(16)
    ivB[15] = 0x2a
    const cipherA = await encryptAes128(sample, KEY_A, ivA)
    const cipherB = await encryptAes128(sample, KEY_B, ivB)
    expect(cipherA.byteLength % 16).toBe(0)
    expect(cipherA).not.toEqual(sample)

    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:7',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/keys/a.key"',
      '#EXTINF:4,',
      'https://cdn.example/hls/a.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/keys/b.key",IV=0x2a',
      '#EXTINF:4,',
      'https://cdn.example/hls/b.ts',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const parsed = parseHlsPlaylist(playlist, PLAYLIST)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'media') return
    expect(parsed.media.aes128).toBe(true)
    expect([...parsed.media.segments[0]!.aes128!.iv]).toEqual([...ivA])
    expect([...parsed.media.segments[1]!.aes128!.iv]).toEqual([...ivB])

    const files = new Map<string, Uint8Array>([
      ['https://cdn.example/keys/a.key', KEY_A],
      ['https://cdn.example/keys/b.key', KEY_B],
      ['https://cdn.example/hls/a.ts', cipherA],
      ['https://cdn.example/hls/b.ts', cipherB],
    ])
    const seen: string[] = []
    const fetchBytes = fetchFrom(files)
    const counting: typeof fetchBytes = async (url, signal) => {
      seen.push(url)
      return fetchBytes(url, signal)
    }
    const signal = new AbortController().signal
    const keys = await loadAes128Keys({ segments: parsed.media.segments, signal, fetchBytes: counting })
    expect(keys.ok).toBe(true)
    if (!keys.ok) return
    expect(seen).toEqual(['https://cdn.example/keys/a.key', 'https://cdn.example/keys/b.key'])

    const downloaded = await downloadSegmentsInOrder({
      urls: parsed.media.segments.map((segment) => segment.url),
      signal,
      fetchSegment: counting,
    })
    expect(downloaded.ok).toBe(true)
    if (!downloaded.ok) return
    expect(downloaded.parts[0]).toEqual(cipherA)

    const plain = await decryptDownloadedParts({
      parts: downloaded.parts,
      initCount: 0,
      segments: parsed.media.segments,
      keys: keys.keys,
      signal,
    })
    expect(plain.ok).toBe(true)
    if (!plain.ok) return
    expect(plain.parts).toHaveLength(2)
    expect(plain.parts[0]).toEqual(sample)
    expect(plain.parts[1]).toEqual(sample)
    expect(plain.parts[0]?.[0]).toBe(0x47)

    const saved = await planHlsSave({
      container: 'ts',
      parts: plain.parts,
      transmux: transmuxTsSegment,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.ext).toBe('mp4')
    expect(saved.mime).toBe('video/mp4')
    expect(saved.message).toBe(HLS_TEXT.complete)
    const mp4 = concat(saved.parts)
    expect(String.fromCharCode(mp4[4]!, mp4[5]!, mp4[6]!, mp4[7]!)).toBe('ftyp')

    const fallback = await planHlsSave({
      container: 'ts',
      parts: plain.parts,
      transmux: () => {
        throw new Error('转封装库抛错')
      },
    })
    expect(fallback.ok).toBe(true)
    if (!fallback.ok) return
    expect(fallback.ext).toBe('ts')
    expect(fallback.message).toBe(HLS_TEXT.remuxFallback)
    expect(fallback.parts[0]).toEqual(sample)
    expect(fallback.parts[0]?.[0]).toBe(0x47)
  })
})
