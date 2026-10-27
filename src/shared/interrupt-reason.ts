/**
 * 把下载中断代码翻成中文。
 * 不访问浏览器 API，offscreen 页面也可以引用。
 */

/** 认不出中断原因时给用户看的字。 */
export const DOWNLOAD_FAILED_TEXT = '下载失败'

/**
 * 下载中断原因的英文代码。
 * 原样的英文代码不显示，改成能看懂的中文。
 * 键要覆盖浏览器给出的每一种中断原因，由 download-status 在编译期核对。
 */
export const INTERRUPT_REASON_TEXT = {
  FILE_FAILED: '保存文件失败',
  FILE_ACCESS_DENIED: '没有权限写入下载目录',
  FILE_NO_SPACE: '磁盘空间不足',
  FILE_NAME_TOO_LONG: '文件名过长',
  FILE_TOO_LARGE: '文件过大',
  FILE_VIRUS_INFECTED: '文件被安全软件拦截',
  FILE_TRANSIENT_ERROR: '保存文件时出现临时错误',
  FILE_BLOCKED: '文件被浏览器拦截',
  FILE_SECURITY_CHECK_FAILED: '安全检查未通过',
  FILE_TOO_SHORT: '下载的文件不完整',
  FILE_HASH_MISMATCH: '文件校验失败',
  FILE_SAME_AS_SOURCE: '无法覆盖源文件',
  NETWORK_FAILED: '网络连接失败',
  NETWORK_TIMEOUT: '网络超时',
  NETWORK_DISCONNECTED: '网络已断开',
  NETWORK_SERVER_DOWN: '服务器无响应',
  NETWORK_INVALID_REQUEST: '下载请求无效',
  SERVER_FAILED: '服务器返回错误',
  SERVER_NO_RANGE: '服务器不支持断点续传',
  SERVER_BAD_CONTENT: '服务器返回了无效内容',
  SERVER_UNAUTHORIZED: '需要登录或未授权（401）',
  SERVER_CERT_PROBLEM: '服务器证书无效',
  SERVER_FORBIDDEN: '服务器拒绝访问（403）',
  SERVER_UNREACHABLE: '无法连接服务器',
  SERVER_CONTENT_LENGTH_MISMATCH: '文件大小和服务器声明的不一致',
  SERVER_CROSS_ORIGIN_REDIRECT: '跨域重定向被拒绝',
  USER_CANCELED: '下载已取消',
  USER_SHUTDOWN: '浏览器关闭，下载已中断',
  CRASH: '下载进程异常退出',
} as const

/** 把 InterruptReason 或带这个代码的错误文本翻成中文。认不出就用「下载失败」。 */
export function describeInterruptReason(reason: string | undefined): string {
  if (typeof reason !== 'string') return DOWNLOAD_FAILED_TEXT
  const trimmed = reason.trim()
  if (!trimmed) return DOWNLOAD_FAILED_TEXT
  const table: Record<string, string> = INTERRUPT_REASON_TEXT
  const exact = table[trimmed]
  if (exact) return exact
  for (const code of Object.keys(table)) {
    if (trimmed.includes(code)) return table[code] ?? DOWNLOAD_FAILED_TEXT
  }
  if (/403|forbidden/i.test(trimmed)) return table.SERVER_FORBIDDEN
  if (/network[_\s-]*failed/i.test(trimmed)) return table.NETWORK_FAILED
  return DOWNLOAD_FAILED_TEXT
}
