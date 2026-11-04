/**
 * HLS 直播录制的纯逻辑。
 *
 * 轮询用 setTimeout 链（每次只安排下一次），不用 setInterval。
 * 按 EXT-X-MEDIA-SEQUENCE 去重：滚动窗口里重复出现的分片不会再下一次。
 * 支持点播已有的标准 AES-128：每一片下载后立刻解密，内存里只留明文。
 * 已录字节达到上限、清单出现 EXT-X-ENDLIST、长时间没有新分片、清单连续失败时自动停止。
 * 用户点「停止并保存」只停轮询，已经下到的分片仍然交给调用方保存；「取消」才丢弃。
 *
 * 这个文件不访问 chrome，也不发请求。fetch、时钟和等待函数都可以注入，方便测试。
 */

import { formatBytes } from './format'
import { decryptAes128Segment } from './hls-aes'
import {
  fetchPlaylistText,
  fetchSegmentBytes,
  type FetchLike,
  type PlaylistFetchResult,
  type SegmentFetchResult,
} from './hls-fetch'
import { HLS_TEXT, parseHlsPlaylist, type HlsMedia, type HlsSegment } from './hls'

/** 直播录制进内存的上限。达到后自动停止并保存已有内容。 */
export const LIVE_HARD_BYTE_LIMIT = 1024 * 1024 * 1024

/** 连续这么久没有新分片就自动停止。 */
export const LIVE_STALL_MS = 30_000

/** 清单连续失败这么多次就自动停止。 */
export const LIVE_MAX_MANIFEST_FAILURES = 5

/** 轮询间隔取 target duration 的一半，夹在这个范围里。 */
export const LIVE_POLL_MIN_MS = 1_000
export const LIVE_POLL_MAX_MS = 5_000

/** 分片失败后的额外尝试次数。404、401、403 不重试。 */
const LIVE_SEGMENT_RETRIES = 2

export type HlsLiveStopReason =
  | 'user'
  | 'endlist'
  | 'size-limit'
  | 'stalled'
  | 'manifest-failed'
  | 'segment-failed'
  | 'key-failed'
  | 'decrypt-failed'
  | 'init-failed'

export interface HlsLiveUpdate {
  bytes: number
  elapsedMs: number
  durationSeconds: number
  segmentCount: number
}

export interface HlsLiveRecording {
  ok: true
  reason: HlsLiveStopReason
  parts: Uint8Array[]
  container: 'ts' | 'mp4'
  bytes: number
  durationSeconds: number
  segmentCount: number
  message: string
}

export type HlsLiveResult =
  | HlsLiveRecording
  | { ok: false; cancelled: true; error: string }
  | { ok: false; cancelled?: false; error: string }

export interface HlsLiveOptions {
  playlistUrl: string
  /** 用户点「取消」时触发，丢弃录制内容。 */
  cancelSignal: AbortSignal
  fetchPlaylist?: (url: string, signal: AbortSignal) => Promise<PlaylistFetchResult>
  fetchSegment?: (url: string, signal: AbortSignal) => Promise<SegmentFetchResult>
  fetchImpl?: FetchLike
  now?: () => number
  /** 等待下一次轮询。默认用 setTimeout，并响应停止和取消。 */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
  maxBytes?: number
  stallMs?: number
  maxManifestFailures?: number
  onUpdate?: (update: HlsLiveUpdate) => void
}

function clampPollMs(targetDuration: number): number {
  const half = Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration * 500 : 1_000
  return Math.min(LIVE_POLL_MAX_MS, Math.max(LIVE_POLL_MIN_MS, Math.round(half)))
}

/** 用 setTimeout 链等待。取消或停止时提前唤醒，并把定时器清掉。 */
function waitWithTimeout(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** 已录时长按 mm:ss 显示。不足一秒按一秒算，超过一小时继续累加分钟。 */
export function formatLiveElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 弹窗里的录制状态：「正在录制 mm:ss / 已录 X MB」。 */
export function liveRecordingText(update: Pick<HlsLiveUpdate, 'elapsedMs' | 'bytes'>): string {
  return `正在录制 ${formatLiveElapsed(update.elapsedMs)} / 已录 ${formatBytes(update.bytes)}`
}

function stopMessage(reason: HlsLiveStopReason): string {
  switch (reason) {
    case 'endlist':
      return HLS_TEXT.liveEnded
    case 'size-limit':
      return HLS_TEXT.liveSizeLimit
    case 'stalled':
      return HLS_TEXT.liveStalled
    case 'manifest-failed':
      return HLS_TEXT.liveManifestFailed
    case 'segment-failed':
      return HLS_TEXT.liveSegmentFailed
    case 'key-failed':
      return HLS_TEXT.liveKeyFailed
    case 'decrypt-failed':
      return HLS_TEXT.liveDecryptFailed
    case 'init-failed':
      return HLS_TEXT.liveInitFailed
    case 'user':
    default:
      return HLS_TEXT.liveSaved
  }
}

function cancelledResult(): HlsLiveResult {
  return { ok: false, cancelled: true, error: HLS_TEXT.cancelled }
}

export class HlsLiveRecorder {
  private readonly options: HlsLiveOptions
  private readonly cancelSignal: AbortSignal
  private readonly stopController = new AbortController()
  /** 取消或停止都会打断正在进行的清单请求和等待，但不会打断正在下载的分片。 */
  private readonly pollController = new AbortController()
  private readonly now: () => number
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly maxBytes: number
  private readonly stallMs: number
  private readonly maxManifestFailures: number
  private readonly fetchPlaylist: (url: string, signal: AbortSignal) => Promise<PlaylistFetchResult>
  private readonly fetchSegment: (url: string, signal: AbortSignal) => Promise<SegmentFetchResult>

  private readonly parts: Uint8Array[] = []
  private readonly keys = new Map<string, Uint8Array>()
  private bytes = 0
  private durationSeconds = 0
  private segmentCount = 0
  private nextSequence: number | undefined
  private initUrl: string | undefined
  private initBytes: Uint8Array | undefined
  private container: 'ts' | 'mp4' | undefined
  private targetDuration = 2
  private lastNewAt: number
  private startedAt: number
  private manifestFailures = 0
  private stopRequested = false
  private started = false

  constructor(options: HlsLiveOptions) {
    this.options = options
    this.cancelSignal = options.cancelSignal
    this.now = options.now ?? (() => Date.now())
    this.wait = options.wait ?? waitWithTimeout
    this.maxBytes = options.maxBytes ?? LIVE_HARD_BYTE_LIMIT
    this.stallMs = options.stallMs ?? LIVE_STALL_MS
    this.maxManifestFailures = options.maxManifestFailures ?? LIVE_MAX_MANIFEST_FAILURES
    this.fetchPlaylist =
      options.fetchPlaylist ??
      ((url, signal) =>
        options.fetchImpl ? fetchPlaylistText(url, signal, options.fetchImpl) : fetchPlaylistText(url, signal))
    this.fetchSegment =
      options.fetchSegment ??
      ((url, signal) =>
        options.fetchImpl ? fetchSegmentBytes(url, signal, options.fetchImpl) : fetchSegmentBytes(url, signal))
    this.startedAt = this.now()
    this.lastNewAt = this.startedAt
    const abortPoll = () => this.pollController.abort()
    if (this.cancelSignal.aborted) abortPoll()
    else this.cancelSignal.addEventListener('abort', abortPoll, { once: true })
    this.stopController.signal.addEventListener('abort', abortPoll, { once: true })
  }

  /** 用户点「停止并保存」。只停止轮询，不丢弃已录内容，也不取消随后要做的转封装。 */
  stop(): void {
    if (this.stopRequested) return
    this.stopRequested = true
    this.stopController.abort()
  }

  /** 已经录到的字节数。供调用方在停止后做提示。 */
  get recordedBytes(): number {
    return this.bytes
  }

  async run(): Promise<HlsLiveResult> {
    while (true) {
      if (this.cancelSignal.aborted) return cancelledResult()
      if (this.stopRequested) return this.finish('user')

      let fetched: PlaylistFetchResult
      try {
        fetched = await this.fetchPlaylist(this.options.playlistUrl, this.pollController.signal)
      } catch {
        if (this.cancelSignal.aborted) return cancelledResult()
        if (this.stopRequested) return this.finish('user')
        fetched = { ok: false, status: 0, reason: 'network' }
      }
      if (this.cancelSignal.aborted) return cancelledResult()
      if (this.stopRequested) return this.finish('user')
      if (!fetched.ok) {
        this.manifestFailures += 1
        if (this.manifestFailures >= this.maxManifestFailures) return this.finish('manifest-failed')
        if (this.stalled()) return this.finish('stalled')
        await this.sleep()
        continue
      }
      this.manifestFailures = 0

      let parsed
      try {
        parsed = parseHlsPlaylist(fetched.text, this.options.playlistUrl)
      } catch {
        return { ok: false, error: HLS_TEXT.internal }
      }
      if (!parsed.ok) return { ok: false, error: parsed.error }
      if (parsed.kind === 'master') return { ok: false, error: HLS_TEXT.nestedMaster }
      if (!this.started && parsed.kind !== 'live') return { ok: false, error: HLS_TEXT.liveNotLive }
      this.started = true

      const media: HlsMedia = parsed.kind === 'live' ? parsed.live : parsed.media
      if (parsed.kind === 'live') this.targetDuration = parsed.live.targetDuration
      if (this.container !== undefined && media.container !== this.container) {
        return { ok: false, error: HLS_TEXT.liveMap }
      }
      this.container = media.container

      const appended = await this.append(media)
      if (this.cancelSignal.aborted) return cancelledResult()
      if (appended.reason) return this.finish(appended.reason)
      if (parsed.kind === 'media') return this.finish('endlist')
      if (this.stopRequested) return this.finish('user')
      if (this.stalled()) return this.finish('stalled')
      await this.sleep()
    }
  }

  private stalled(): boolean {
    return this.now() - this.lastNewAt >= this.stallMs
  }

  private sleep(): Promise<void> {
    return this.wait(clampPollMs(this.targetDuration), this.pollController.signal)
  }

  private update(): void {
    if (!this.options.onUpdate) return
    try {
      this.options.onUpdate({
        bytes: this.bytes,
        elapsedMs: Math.max(0, this.now() - this.startedAt),
        durationSeconds: this.durationSeconds,
        segmentCount: this.segmentCount,
      })
    } catch {
      // 进度回调失败不影响录制。
    }
  }

  private finish(reason: HlsLiveStopReason): HlsLiveRecording {
    return {
      ok: true,
      reason,
      parts: [...this.parts],
      container: this.container ?? 'ts',
      bytes: this.bytes,
      durationSeconds: this.durationSeconds,
      segmentCount: this.segmentCount,
      message: stopMessage(reason),
    }
  }

  private async append(media: HlsMedia): Promise<{ reason?: HlsLiveStopReason }> {
    if (media.container === 'mp4' && media.initUrl) {
      if (!this.initBytes) {
        if (this.initUrl !== undefined && this.initUrl !== media.initUrl) return { reason: 'init-failed' }
        this.initUrl = media.initUrl
        const fetched = await this.fetchWithRetries(media.initUrl, true)
        if (!fetched.ok) {
          if (this.cancelSignal.aborted) return {}
          return { reason: 'init-failed' }
        }
        this.initBytes = fetched.bytes
        if (!this.pushPart(fetched.bytes)) return { reason: 'size-limit' }
        if (this.bytes >= this.maxBytes) return { reason: 'size-limit' }
      }
    }

    for (const segment of media.segments) {
      if (this.cancelSignal.aborted) return {}
      const sequence = segment.sequence
      if (sequence === undefined) continue
      if (this.nextSequence !== undefined && sequence < this.nextSequence) continue

      const fetched = await this.fetchWithRetries(segment.url, false)
      if (!fetched.ok) {
        if (this.cancelSignal.aborted) return {}
        return { reason: 'segment-failed' }
      }
      let bytes = fetched.bytes
      if (segment.aes128) {
        const decrypted = await this.decrypt(segment, bytes)
        if (this.cancelSignal.aborted) return {}
        if (!decrypted.ok) return { reason: decrypted.reason }
        bytes = decrypted.bytes
      }
      if (!this.pushPart(bytes)) {
        // 达到上限的这一片不再加入。已经录到的内容仍然保存。
        this.nextSequence = sequence + 1
        return { reason: 'size-limit' }
      }
      this.nextSequence = sequence + 1
      this.segmentCount += 1
      if (segment.duration !== undefined && Number.isFinite(segment.duration) && segment.duration > 0) {
        this.durationSeconds += segment.duration
      }
      this.lastNewAt = this.now()
      this.update()
      if (this.bytes >= this.maxBytes) return { reason: 'size-limit' }
    }
    return {}
  }

  private pushPart(bytes: Uint8Array): boolean {
    if (this.bytes + bytes.byteLength > this.maxBytes) return false
    this.parts.push(bytes)
    this.bytes += bytes.byteLength
    return true
  }

  private async decrypt(
    segment: HlsSegment,
    ciphertext: Uint8Array,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'key-failed' | 'decrypt-failed' }> {
    const enc = segment.aes128
    if (!enc) return { ok: true, bytes: ciphertext }
    let key = this.keys.get(enc.keyUrl)
    if (!key) {
      const fetched = await this.fetchWithRetries(enc.keyUrl, true)
      if (!fetched.ok) return { ok: false, reason: 'key-failed' }
      if (fetched.bytes.byteLength !== 16) return { ok: false, reason: 'key-failed' }
      key = fetched.bytes
      this.keys.set(enc.keyUrl, key)
    }
    const decrypted = await decryptAes128Segment(ciphertext, key, enc.iv)
    if (!decrypted.ok) return { ok: false, reason: 'decrypt-failed' }
    return { ok: true, bytes: decrypted.bytes }
  }

  private async fetchWithRetries(url: string, keyLike: boolean): Promise<SegmentFetchResult> {
    let last: SegmentFetchResult = { ok: false, status: 0 }
    for (let attempt = 0; attempt <= LIVE_SEGMENT_RETRIES; attempt += 1) {
      if (this.cancelSignal.aborted) return { ok: false, status: 0 }
      try {
        last = await this.fetchSegment(url, this.cancelSignal)
      } catch {
        if (this.cancelSignal.aborted) return { ok: false, status: 0 }
        last = { ok: false, status: 0 }
      }
      if (last.ok) return last
      if (last.status === 401 || last.status === 403 || last.status === 404) return last
      if (attempt < LIVE_SEGMENT_RETRIES) {
        await this.wait(200, this.stopController.signal)
        if (this.cancelSignal.aborted) return { ok: false, status: 0 }
      }
    }
    if (keyLike) {
      // 调用方只关心是否成功，失败原因在调用处按 key-failed / init-failed 处理。
      return last
    }
    return last
  }

}
