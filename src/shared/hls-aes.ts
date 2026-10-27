/**
 * HLS 标准 AES-128 的取密钥和解密。
 *
 * 密钥和明文只留在这次调用的内存里。不要写进 storage，不要打日志，也不要放进界面文案。
 * 取密钥走和分片一样的 fetch：不设置 headers，不伪造 Referer。失败就把中文原因交回去。
 * 解密用浏览器自带的 crypto.subtle（AES-CBC）。Web Crypto 会去掉 PKCS7 填充，和 HLS 规范一致。
 * 这里不访问扩展 API。offscreen 页面调用它，进度和保存仍由调用方经 runtime 消息交给 service worker。
 */

import {
  HLS_TEXT,
  describeKeyFetchFailure,
  type HlsSegment,
} from './hls'
import { fetchSegmentBytes, type SegmentFetchResult } from './hls-fetch'

const AES_BLOCK = 16
const TS_SYNC_BYTE = 0x47

export type AesBytesFetcher = (url: string, signal: AbortSignal) => Promise<SegmentFetchResult>

export type AesStepFailure = { ok: false; error: string; cancelled?: boolean }

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

/** 拷成一块独立的 ArrayBuffer，避免 SharedArrayBuffer 视图传不进 crypto.subtle。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

/**
 * 解一片 AES-128-CBC。
 * 密文长度不是 16 的整数倍时不去调用 crypto，避免和「密钥不对」混在一起。
 * 解出来的第一个字节必须是 TS 同步字节 0x47。
 */
export async function decryptAes128Segment(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<{ ok: true; bytes: Uint8Array } | AesStepFailure> {
  if (key.byteLength !== AES_BLOCK || iv.byteLength !== AES_BLOCK) {
    return { ok: false, error: HLS_TEXT.keyLength }
  }
  if (ciphertext.byteLength === 0 || ciphertext.byteLength % AES_BLOCK !== 0) {
    return { ok: false, error: HLS_TEXT.cipherLength }
  }
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['decrypt'])
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: toArrayBuffer(iv) },
      cryptoKey,
      toArrayBuffer(ciphertext),
    )
    const bytes = new Uint8Array(plain)
    if (bytes.byteLength === 0 || bytes[0] !== TS_SYNC_BYTE) {
      return { ok: false, error: HLS_TEXT.decryptFailed }
    }
    return { ok: true, bytes }
  } catch {
    return { ok: false, error: HLS_TEXT.decryptFailed }
  }
}

/** 按分片出现顺序取不重复的密钥。同一个地址只请求一次。 */
export async function loadAes128Keys(input: {
  segments: readonly HlsSegment[]
  signal: AbortSignal
  fetchBytes?: AesBytesFetcher
}): Promise<{ ok: true; keys: Map<string, Uint8Array> } | AesStepFailure> {
  const fetchBytes = input.fetchBytes ?? fetchSegmentBytes
  const keys = new Map<string, Uint8Array>()
  for (const segment of input.segments) {
    const url = segment.aes128?.keyUrl
    if (!url || keys.has(url)) continue
    if (input.signal.aborted) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
    let fetched: SegmentFetchResult
    try {
      fetched = await fetchBytes(url, input.signal)
    } catch {
      if (input.signal.aborted) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
      return { ok: false, error: HLS_TEXT.keyNetwork }
    }
    if (!fetched.ok) return { ok: false, error: describeKeyFetchFailure(fetched.status) }
    if (fetched.bytes.byteLength !== AES_BLOCK) return { ok: false, error: HLS_TEXT.keyLength }
    keys.set(url, copyBytes(fetched.bytes))
  }
  return { ok: true, keys }
}

/**
 * 把已经下到的分片解密。
 * 初始化段不加密，原样留在前面。没有 aes128 的分片也不动。
 * 调用方随后把结果交给现有的 TS 转封装。转封装失败时保存的是这里的明文 TS。
 */
export async function decryptDownloadedParts(input: {
  parts: readonly Uint8Array[]
  initCount: number
  segments: readonly HlsSegment[]
  keys: ReadonlyMap<string, Uint8Array>
  signal?: AbortSignal
}): Promise<{ ok: true; parts: Uint8Array[] } | AesStepFailure> {
  if (input.initCount + input.segments.length !== input.parts.length) {
    return { ok: false, error: HLS_TEXT.internal }
  }
  const output: Uint8Array[] = []
  for (let index = 0; index < input.initCount; index += 1) {
    const part = input.parts[index]
    if (!part) return { ok: false, error: HLS_TEXT.internal }
    output.push(part)
  }
  for (let index = 0; index < input.segments.length; index += 1) {
    if (input.signal?.aborted) return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
    const part = input.parts[input.initCount + index]
    const segment = input.segments[index]
    if (!part || !segment) return { ok: false, error: HLS_TEXT.internal }
    const enc = segment.aes128
    if (!enc) {
      output.push(part)
      continue
    }
    const key = input.keys.get(enc.keyUrl)
    if (!key) return { ok: false, error: HLS_TEXT.internal }
    const decrypted = await decryptAes128Segment(part, key, enc.iv)
    if (!decrypted.ok) return decrypted
    output.push(decrypted.bytes)
  }
  return { ok: true, parts: output }
}
