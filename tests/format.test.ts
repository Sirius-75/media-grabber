import { describe, expect, it } from 'vitest'
import { formatBytes, slidingMegabyteRate } from '../src/shared/format'

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

  it('速度按最近几秒的滑动平均，样本不够就不显示', () => {
    const samples: Array<{ at: number; bytes: number }> = []
    expect(slidingMegabyteRate(samples, 0, 0)).toBeUndefined()
    expect(slidingMegabyteRate(samples, 100, 1024 * 1024)).toBeUndefined()
    expect(slidingMegabyteRate(samples, 1000, 2 * 1024 * 1024)).toBe('2 MB/s')
    expect(slidingMegabyteRate(samples, 1500, 3.5 * 1024 * 1024)).toBe('2.3 MB/s')
    const later: Array<{ at: number; bytes: number }> = []
    slidingMegabyteRate(later, 0, 0)
    slidingMegabyteRate(later, 1000, 1024 * 1024)
    expect(slidingMegabyteRate(later, 5000, 1024 * 1024)).toBeUndefined()
    expect(slidingMegabyteRate([], Number.NaN, 1)).toBeUndefined()
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
