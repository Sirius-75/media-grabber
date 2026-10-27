/**
 * offscreen 文档和 service worker 之间的消息。
 * offscreen 只能用 runtime，会话存储和保存文件都从这里转交给后台。
 * 这个文件不访问浏览器 API。
 */

import { BILIBILI_JOB_STORAGE_KEY } from './bilibili'
import { DASH_JOB_STORAGE_KEY } from './dash-job'
import { HLS_JOB_PHASES, HLS_JOB_STORAGE_KEY, type HlsJobPhase } from './hls-job'

export const OFFSCREEN_BRIDGE = {
  WRITE_JOB: 'OFFSCREEN_WRITE_JOB',
  CANCEL_JOB: 'OFFSCREEN_CANCEL_JOB',
  SAVE_BLOB: 'OFFSCREEN_SAVE_BLOB',
} as const

const PHASES = new Set<string>(HLS_JOB_PHASES)

export function isJobStorageKey(
  value: unknown,
): value is typeof HLS_JOB_STORAGE_KEY | typeof DASH_JOB_STORAGE_KEY | typeof BILIBILI_JOB_STORAGE_KEY {
  return value === HLS_JOB_STORAGE_KEY || value === DASH_JOB_STORAGE_KEY || value === BILIBILI_JOB_STORAGE_KEY
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface OffscreenWriteJob {
  key: string
  storageKey: string
  record: unknown
}

export interface OffscreenCancelJob {
  key: string
  storageKey: string
  phases: HlsJobPhase[]
}

export interface OffscreenSaveBlob {
  url: string
  filename: string
}

export function readWriteJobMessage(value: unknown): OffscreenWriteJob | undefined {
  if (!isRecord(value) || value.type !== OFFSCREEN_BRIDGE.WRITE_JOB) return undefined
  if (typeof value.key !== 'string' || value.key.trim() === '') return undefined
  if (!isJobStorageKey(value.storageKey)) return undefined
  return { key: value.key, storageKey: value.storageKey, record: value.record }
}

export function readCancelJobMessage(value: unknown): OffscreenCancelJob | undefined {
  if (!isRecord(value) || value.type !== OFFSCREEN_BRIDGE.CANCEL_JOB) return undefined
  if (typeof value.key !== 'string' || value.key.trim() === '') return undefined
  if (!isJobStorageKey(value.storageKey)) return undefined
  if (!Array.isArray(value.phases) || value.phases.length === 0) return undefined
  const phases: HlsJobPhase[] = []
  for (const phase of value.phases) {
    if (typeof phase !== 'string' || !PHASES.has(phase)) return undefined
    phases.push(phase as HlsJobPhase)
  }
  return { key: value.key, storageKey: value.storageKey, phases }
}

export function readSaveBlobMessage(value: unknown): OffscreenSaveBlob | undefined {
  if (!isRecord(value) || value.type !== OFFSCREEN_BRIDGE.SAVE_BLOB) return undefined
  if (typeof value.url !== 'string' || !value.url.startsWith('blob:')) return undefined
  if (typeof value.filename !== 'string' || value.filename.trim() === '') return undefined
  return { url: value.url, filename: value.filename }
}

/** offscreen 在同步时带回当前这条下载。空白就当成没有正在下的任务。 */
export function readOffscreenActiveKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.activeKey !== 'string' || value.activeKey.trim() === '') return undefined
  return value.activeKey
}
