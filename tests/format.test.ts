import { describe, expect, it } from 'vitest'
import { formatBytes } from '../src/shared/format'

describe('formatBytes', () => {
  it('按 1024 进制格式化，整数不带小数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(0.4)).toBe('0 B')
    expect(formatBytes(1.2)).toBe('1 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10.06 * 1024)).toBe('10.1 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(1024 ** 3)).toBe('1 GB')
    expect(formatBytes(1024 ** 4)).toBe('1 TB')
    expect(formatBytes(1024 ** 5)).toBe('1024 TB')
  })

  it('四舍五入升到 1024 时进一档', () => {
    expect(formatBytes(1024 * 1024 - 50)).toBe('1 MB')
  })

  it('缺失或非法时显示未知', () => {
    expect(formatBytes(undefined)).toBe('未知')
    expect(formatBytes(null)).toBe('未知')
    expect(formatBytes(Number.NaN)).toBe('未知')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('未知')
    expect(formatBytes(-1)).toBe('未知')
    expect(formatBytes('12' as unknown as number)).toBe('未知')
  })
})
