/**
 * HLS 下载进度放在 chrome.storage.session。
 * popup 关掉再打开，还是读这一份。这里只做校验，不碰 chrome。
 */

import type { HlsVariant } from './hls'

export const HLS_JOB_STORAGE_KEY = 'hls-jobs'

/** 同时记住的任务数。再多就丢掉最早的。 */
export const MAX_REMEMBERED_HLS_JOBS = 20

export const HLS_JOB_PHASES = [
  'inspecting',
  'picking',
  'downloading',
  'remuxing',
  'complete',
  'failed',
  'cancelled',
] as const

export type HlsJobPhase = (typeof HLS_JOB_PHASES)[number]

export interface HlsVariantChoice {
  url: string
  label: string
  bandwidth: number
  width?: number
  height?: number
  separateAudio: boolean
}

export interface HlsJobRecord {
  phase: HlsJobPhase
  message: string
  completed: number
  total: number
  warning?: string
  variants?: HlsVariantChoice[]
  updatedAt: number
}

export type HlsJobMap = Record<string, HlsJobRecord>

const PHASES = new Set<string>(HLS_JOB_PHASES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function variantChoice(value: unknown): HlsVariantChoice | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.url !== 'string' || value.url.trim() === '') return undefined
  if (typeof value.label !== 'string' || value.label.trim() === '') return undefined
  if (typeof value.bandwidth !== 'number' || !Number.isFinite(value.bandwidth) || value.bandwidth < 0) return undefined
  if (typeof value.separateAudio !== 'boolean') return undefined
  const choice: HlsVariantChoice = {
    url: value.url,
    label: value.label.trim(),
    bandwidth: value.bandwidth,
    separateAudio: value.separateAudio,
  }
  if (value.width !== undefined || value.height !== undefined) {
    if (typeof value.width !== 'number' || typeof value.height !== 'number') return undefined
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height)) return undefined
    choice.width = value.width
    choice.height = value.height
  }
  return choice
}

export function toVariantChoice(variant: HlsVariant): HlsVariantChoice {
  const choice: HlsVariantChoice = {
    url: variant.url,
    label: variant.label,
    bandwidth: variant.bandwidth,
    separateAudio: variant.separateAudio,
  }
  if (variant.width !== undefined && variant.height !== undefined) {
    choice.width = variant.width
    choice.height = variant.height
  }
  return choice
}

function parseJob(value: unknown): HlsJobRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase)) return undefined
  if (typeof value.message !== 'string' || value.message.trim() === '') return undefined
  if (typeof value.completed !== 'number' || !Number.isFinite(value.completed) || value.completed < 0) return undefined
  if (typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total < 0) return undefined
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return undefined
  const record: HlsJobRecord = {
    phase: value.phase as HlsJobPhase,
    message: value.message.trim(),
    completed: value.completed,
    total: value.total,
    updatedAt: value.updatedAt,
  }
  if (value.warning !== undefined) {
    if (typeof value.warning !== 'string' || value.warning.trim() === '') return undefined
    record.warning = value.warning.trim()
  }
  if (value.variants !== undefined) {
    if (!Array.isArray(value.variants)) return undefined
    const variants: HlsVariantChoice[] = []
    for (const entry of value.variants) {
      const parsed = variantChoice(entry)
      if (!parsed) return undefined
      variants.push(parsed)
    }
    record.variants = variants
  }
  return record
}

/** session 里的值可能写坏。认不出的任务丢掉。 */
export function readHlsJobMap(value: unknown): HlsJobMap {
  if (!isRecord(value)) return {}
  const result: HlsJobMap = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === '') continue
    const parsed = parseJob(entry)
    if (parsed) result[key] = parsed
  }
  return result
}

export function trimHlsJobs(map: HlsJobMap, max = MAX_REMEMBERED_HLS_JOBS): HlsJobMap {
  const entries = Object.entries(map)
  if (entries.length <= max) return map
  entries.sort((left, right) => left[1].updatedAt - right[1].updatedAt)
  return Object.fromEntries(entries.slice(entries.length - max))
}

export interface HlsInspectResponseMaster {
  ok: true
  kind: 'master'
  variants: HlsVariantChoice[]
  warning?: string
}

export interface HlsInspectResponseMedia {
  ok: true
  kind: 'media'
  total: number
  container: 'ts' | 'mp4'
  warning?: string
}

export type HlsUserResponse =
  | HlsInspectResponseMaster
  | HlsInspectResponseMedia
  | { ok: false; error: string }
  | { ok: true }

export function readHlsUserResponse(value: unknown): HlsUserResponse | undefined {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return undefined
  if (value.ok === false) {
    if (typeof value.error !== 'string' || value.error.trim() === '') return undefined
    return { ok: false, error: value.error.trim() }
  }
  if (value.kind === 'master') {
    if (!Array.isArray(value.variants)) return undefined
    const variants: HlsVariantChoice[] = []
    for (const entry of value.variants) {
      const parsed = variantChoice(entry)
      if (!parsed) return undefined
      variants.push(parsed)
    }
    const master: HlsInspectResponseMaster = { ok: true, kind: 'master', variants }
    if (value.warning !== undefined) {
      if (typeof value.warning !== 'string' || value.warning.trim() === '') return undefined
      master.warning = value.warning.trim()
    }
    return master
  }
  if (value.kind === 'media') {
    if (typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total < 0) return undefined
    if (value.container !== 'ts' && value.container !== 'mp4') return undefined
    const response: HlsInspectResponseMedia = { ok: true, kind: 'media', total: value.total, container: value.container }
    if (value.warning !== undefined) {
      if (typeof value.warning !== 'string' || value.warning.trim() === '') return undefined
      response.warning = value.warning.trim()
    }
    return response
  }
  return { ok: true }
}
