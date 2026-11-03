/**
 * 失败后重试所需的参数。
 * 任务记录会在下载过程中被 offscreen 反复整条覆盖，所以参数单独放在会话存储里，
 * 只由 popup 写入，不和进度抢同一个 key。这里只做校验，不访问浏览器 API。
 */

export const DOWNLOAD_RETRY_STORAGE_KEY = 'download-retry'

export type BilibiliRetryMode = 'with-audio' | 'audio-only' | 'video-only'

export type DownloadRetryPlan =
  | { kind: 'hls'; mode: 'inspect' | 'download'; mediaUrl?: string }
  | {
      kind: 'dash'
      mode: 'inspect' | 'download'
      representationId?: string
      audioOnly: boolean
      separate: boolean
    }
  | { kind: 'bilibili'; mode: BilibiliRetryMode; separate: boolean }

export type DownloadRetryMap = Record<string, DownloadRetryPlan>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function parsePlan(value: unknown): DownloadRetryPlan | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'hls') {
    if (value.mode !== 'inspect' && value.mode !== 'download') return undefined
    const plan: DownloadRetryPlan = { kind: 'hls', mode: value.mode }
    if (value.mediaUrl !== undefined) {
      if (!nonEmptyString(value.mediaUrl)) return undefined
      plan.mediaUrl = value.mediaUrl.trim()
    }
    if (plan.mode === 'download' && !plan.mediaUrl) return undefined
    return plan
  }
  if (value.kind === 'dash') {
    if (value.mode !== 'inspect' && value.mode !== 'download') return undefined
    if (typeof value.audioOnly !== 'boolean' || typeof value.separate !== 'boolean') return undefined
    const plan: DownloadRetryPlan = {
      kind: 'dash',
      mode: value.mode,
      audioOnly: value.audioOnly,
      separate: value.separate,
    }
    if (value.representationId !== undefined) {
      if (!nonEmptyString(value.representationId)) return undefined
      plan.representationId = value.representationId.trim()
    }
    if (plan.mode === 'download' && !plan.representationId) return undefined
    return plan
  }
  if (value.kind === 'bilibili') {
    if (
      value.mode !== 'with-audio' &&
      value.mode !== 'audio-only' &&
      value.mode !== 'video-only'
    ) {
      return undefined
    }
    if (typeof value.separate !== 'boolean') return undefined
    return { kind: 'bilibili', mode: value.mode, separate: value.separate }
  }
  return undefined
}

/** session 里的值可能写坏。认不出的参数丢掉，安全退回按条目原有的按钮重试。 */
export function readDownloadRetryMap(value: unknown): DownloadRetryMap {
  if (!isRecord(value)) return {}
  const result: DownloadRetryMap = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === '') continue
    const plan = parsePlan(entry)
    if (plan) result[key] = plan
  }
  return result
}
