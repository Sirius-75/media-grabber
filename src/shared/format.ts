/**
 * popup 展示用的纯函数。
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * 把字节数格式化成短字符串。
 * 1024 进制。整数不带小数，其余最多一位。缺失、NaN、负数返回「未知」。
 */
export function formatBytes(size: number | null | undefined): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return '未知'
  }

  let value = size
  let unitIndex = 0
  while (unitIndex < UNITS.length - 1 && value >= 1024) {
    value /= 1024
    unitIndex += 1
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} B`
  }

  const rounded = Math.round(value * 10) / 10
  // 四舍五入后可能显示成 1024 KB，这时进到下一档。
  if (rounded >= 1024 && unitIndex < UNITS.length - 1) {
    return `1 ${UNITS[unitIndex + 1]}`
  }

  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text} ${UNITS[unitIndex]}`
}

/** 进度文字里附带的速度窗口。只看最近这几秒，避免被开头的慢启动拖住。 */
export const BYTE_RATE_WINDOW_MS = 3000

/**
 * 用最近几秒的样本算平均速度，写成「1.5 MB/s」。
 * 会改 samples：留下窗口内的点。样本不够、间隔太短或速度不是正数时不显示。
 */
export function slidingMegabyteRate(
  samples: Array<{ at: number; bytes: number }>,
  at: number,
  bytes: number,
  windowMs = BYTE_RATE_WINDOW_MS,
): string | undefined {
  if (!Number.isFinite(at) || !Number.isFinite(bytes)) return undefined
  samples.push({ at, bytes })
  const cutoff = at - windowMs
  while (samples.length > 1 && (samples[0]?.at ?? 0) < cutoff) samples.shift()
  const first = samples[0]
  if (!first || samples.length < 2) return undefined
  const seconds = (at - first.at) / 1000
  if (seconds < 0.4) return undefined
  const perSecond = (bytes - first.bytes) / seconds
  if (!Number.isFinite(perSecond) || perSecond <= 0) return undefined
  const rounded = Math.round((perSecond / (1024 * 1024)) * 10) / 10
  if (rounded <= 0) return undefined
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text} MB/s`
}
