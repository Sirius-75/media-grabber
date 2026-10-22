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
