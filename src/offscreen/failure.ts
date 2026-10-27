/**
 * 清单读取失败时怎么对用户说。
 * 拉清单本身的网络错误已经在 fetch 里变成「网络连接失败」。
 * 走到这里的多半是消息发不出去、解析抛错，不能再一律说成网络问题。
 */

import { HLS_TEXT } from '../shared/hls'

export function isNetworkError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'NetworkError') {
    return true
  }
  const message = error instanceof Error ? error.message : ''
  if (message === '') return false
  return /failed to fetch|networkerror|network request failed|load failed|net::ERR_/i.test(message)
}

/** inspect 的 catch 用。网络错误维持原话，其余算内部错误。 */
export function inspectFailureMessage(error: unknown): string {
  if (isNetworkError(error)) return HLS_TEXT.network
  return HLS_TEXT.internal
}

/**
 * 把失败状态写进会话存储。写本身失败就再试一次。
 * 两次都失败只记日志，不再往外抛，避免任务停在「正在下载」。
 */
export async function settleJob(write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (error) {
    console.warn('[media-grabber] 写入失败状态失败', error)
    try {
      await write()
    } catch (again) {
      console.warn('[media-grabber] 写入失败状态仍然失败', again)
    }
  }
}
