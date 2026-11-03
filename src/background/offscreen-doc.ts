/**
 * 打开并复用唯一的 offscreen 文档，以及给页面标题和列表序号补上下文。
 * 下载队列和 HLS / DASH / B 站入口都用这里的函数，避免互相循环引用。
 * 这里不碰分片字节，也不设置请求头。
 */

import { normalizeUrl } from '../shared/classify'
import { getItems } from './store'

/** 和 src/offscreen/offscreen.html 的位置一致。构建后还在这个路径。 */
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'

let opening: Promise<void> | undefined

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

async function hasOffscreen(): Promise<boolean> {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    try {
      return await chrome.offscreen.hasDocument()
    } catch (error) {
      warn('检查 offscreen 失败', error)
    }
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  })
  return contexts.length > 0
}

async function createOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  try {
    await chrome.offscreen.createDocument({
      url: `${OFFSCREEN_PATH}?role=offscreen`,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification:
        '在扩展页面里把 HLS 或 DASH 分片拼成 Blob 再下载。Service worker 会被回收，不能在里面跑这个长任务。',
    })
  } catch (error) {
    if (await hasOffscreen()) return
    throw error
  }
}

/** 整个扩展同时只能有一个 offscreen document。已经开着就复用。 */
export function ensureOffscreen(): Promise<void> {
  if (!opening) {
    opening = createOffscreen().finally(() => {
      opening = undefined
    })
  }
  return opening
}

/** 后台页是否已经开着。没有时不要为了同步去新建一个。 */
export async function offscreenExists(): Promise<boolean> {
  try {
    return await hasOffscreen()
  } catch (error) {
    warn('检查 offscreen 失败', error)
    return false
  }
}

export async function sendOffscreen(message: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreen()
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response: unknown = await chrome.runtime.sendMessage(message)
      if (response !== undefined) return response
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
  }
  warn('offscreen 没有响应', lastError)
  return undefined
}

async function activeTabId(): Promise<number | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const id = tabs[0]?.id
    return typeof id === 'number' ? id : undefined
  } catch (error) {
    warn('读取当前标签页失败', error)
    return undefined
  }
}

async function pageTitle(tabId: number | undefined): Promise<string | undefined> {
  try {
    const id = tabId ?? (await activeTabId())
    if (id === undefined) return undefined
    return (await chrome.tabs.get(id)).title
  } catch (error) {
    warn('读取页面标题失败', error)
    return undefined
  }
}

async function listIndex(tabId: number | undefined, url: string): Promise<number | undefined> {
  const id = tabId ?? (await activeTabId())
  if (id === undefined) return undefined
  const items = await getItems(id)
  const normalized = normalizeUrl(url)
  const index = items.findIndex((item) => item.url === normalized || item.url === url)
  return index >= 0 ? index + 1 : undefined
}

/** 页面标题和列表序号。DASH 和 HLS 保存文件名时共用。 */
export async function downloadContext(
  tabId: number | undefined,
  url: string,
): Promise<{ title?: string; index?: number }> {
  const title = await pageTitle(tabId)
  const index = await listIndex(tabId, url)
  const context: { title?: string; index?: number } = {}
  if (title) context.title = title
  if (index !== undefined) context.index = index
  return context
}
