/**
 * 下载前的体积提醒。合并混流时内存里会同时留两路，接近 1GB 就提前说明。
 * 这里只做判断，不访问浏览器 API。
 */

/** 合并器实际的上限。超过它就不再合并，改成分开保存。 */
export const MERGE_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024

/** 接近合并上限时就开始提醒。 */
export const LARGE_MERGE_WARN_BYTES = 900 * 1024 * 1024

export const LARGE_MERGE_WARNING =
  '文件较大，合并需要较多内存，将分开保存或建议勾选“分开保存”'

/** 已知总大小接近或超过 1GB 时返回提醒。未知或不合法的大小不提醒。 */
export function largeMergeWarning(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < LARGE_MERGE_WARN_BYTES) return undefined
  return LARGE_MERGE_WARNING
}
