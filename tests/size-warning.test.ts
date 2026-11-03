import { describe, expect, it } from 'vitest'
import { HLS_WARN_BYTE_LIMIT, assessHlsSize, hlsWarnBytesText } from '../src/shared/hls'
import {
  LARGE_MERGE_WARN_BYTES,
  LARGE_MERGE_WARNING,
  MERGE_MEMORY_LIMIT_BYTES,
  largeMergeWarning,
} from '../src/shared/size-warning'

describe('大文件提示', () => {
  it('接近或超过 1GB 时提示合并内存，未知和较小的大小不提示', () => {
    expect(MERGE_MEMORY_LIMIT_BYTES).toBe(1024 * 1024 * 1024)
    expect(largeMergeWarning(undefined)).toBeUndefined()
    expect(largeMergeWarning(Number.NaN)).toBeUndefined()
    expect(largeMergeWarning(LARGE_MERGE_WARN_BYTES - 1)).toBeUndefined()
    expect(largeMergeWarning(LARGE_MERGE_WARN_BYTES)).toBe(LARGE_MERGE_WARNING)
    expect(largeMergeWarning(1024 * 1024 * 1024)).toBe(LARGE_MERGE_WARNING)
    expect(LARGE_MERGE_WARNING).toContain('合并需要较多内存')
    expect(LARGE_MERGE_WARNING).toContain('分开保存')
  })

  it('HLS 估计达到合并上限附近时复用它，不再重复旧的 512MB 提醒', () => {
    const durationSeconds = 1200
    const bandwidth = (LARGE_MERGE_WARN_BYTES * 8) / durationSeconds
    const assessment = assessHlsSize({ segmentCount: 10, durationSeconds, bandwidth })
    expect(assessment.ok).toBe(true)
    if (!assessment.ok) return
    expect(assessment.warning).toBe(LARGE_MERGE_WARNING)
    expect(assessment.warning).not.toContain(hlsWarnBytesText(LARGE_MERGE_WARN_BYTES))
  })

  it('仍在 512MB 提醒区间时沿用原本文案', () => {
    const durationSeconds = 1200
    const bandwidth = (HLS_WARN_BYTE_LIMIT * 8) / durationSeconds
    const assessment = assessHlsSize({ segmentCount: 10, durationSeconds, bandwidth })
    expect(assessment.ok).toBe(true)
    if (!assessment.ok) return
    expect(assessment.warning).toBe(hlsWarnBytesText(HLS_WARN_BYTE_LIMIT))
  })
})
