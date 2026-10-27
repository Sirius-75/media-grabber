/**
 * 网络嗅探。只观察响应头，不拦截，不改请求，也不用 declarativeNetRequest。
 *
 * 选用 onHeadersReceived，而不是 onResponseStarted：
 * Content-Type 和 Content-Length 在响应头到达时就已经有了，不必等 body 的第一个字节。
 * 视频往往很大，越早认出来越好；请求若在头到了之后、body 开始前被取消，onResponseStarted 会漏掉。
 * 重定向的 3xx 也会进这个事件，但不是 2xx，下面会丢掉；最终那次 2xx 会再触发一次。
 * extraInfoSpec 只带 responseHeaders，不带 blocking，回调因此不能改头，也不会挡住请求。
 * 这和 PLAN.md 第 4 节、T4 的写法一致。
 *
 * 对外只有 detailsToMediaItem 和 startSniffer。
 * detailsToMediaItem 是纯函数：能新增的媒体返回 MediaItem，其余（含 206）返回 null。
 * 206 只通过 startSniffer 的可选参数 onSize 交出 URL 和 Content-Length，
 * 不返回 MediaItem，避免被当成新条目。不传 onSize 时 206 被忽略。
 * 206 的 Content-Length 是这一段的字节数，不一定是整文件；方案已说明这时大小可能不准。
 * 这里不解析 Content-Range，也不另发请求。
 * 本文件不读写 storage。入口把 onFound 接到 addMedia，把 onSize 接到 fillMediaSize。
 * 普通 .m4s 仍然不是一条新媒体。只有 B 站 CDN 上的单个 .m4s 会进列表，
 * 并且同一个文件的多次 Range 请求只上报一次。这不改请求，也不加 Referer。
 */

/** 同一个标签页里，规范化后的 B 站 .m4s 只上报一次。 */
const seenBilibiliM4s = new Set<string>()

import { bilibiliM4sItem } from '../shared/bilibili'
import { classify, normalizeUrl } from '../shared/classify'
import type { MediaItem } from '../shared/types'

/** 响应头里用到的字段。名字大小写不敏感，没有 value 的二进制头会跳过。 */
interface ResponseHeader {
  name?: string
  value?: string
}

/**
 * webRequest 回调里真正参与判断的字段。
 * 用结构类型，单测不必拼出完整的 Chrome details。
 */
export interface ResponseDetails {
  url: string
  tabId: number
  statusCode: number
  responseHeaders?: readonly ResponseHeader[]
  /** Chrome 给出的事件时间，毫秒。没有时用调用方传入的 now。 */
  timeStamp?: number
}

/** 206 能补到已有条目上的大小。没有对应条目时调用方不得新增。 */
interface SizeUpdate {
  tabId: number
  url: string
  size: number
}

function isTabId(tabId: number): boolean {
  return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0
}

function headerValue(headers: ResponseDetails['responseHeaders'], name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined
  const wanted = name.toLowerCase()
  for (const header of headers) {
    if (typeof header?.name !== 'string' || header.name.toLowerCase() !== wanted) continue
    if (typeof header.value !== 'string') continue
    return header.value
  }
  return undefined
}

/** Content-Length 必须是非负整数字符串。带单位、小数、负数都当成没有。 */
function contentLength(headers: ResponseDetails['responseHeaders']): number | undefined {
  const raw = headerValue(headers, 'content-length')
  if (raw === undefined) return undefined
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return undefined
  const value = Number(text)
  if (!Number.isSafeInteger(value)) return undefined
  return value
}

function seenAt(timeStamp: number | undefined, now: number): number {
  if (typeof timeStamp === 'number' && Number.isFinite(timeStamp) && timeStamp > 0) return timeStamp
  if (Number.isFinite(now) && now > 0) return now
  return Date.now()
}

interface Matched {
  url: string
  itemFields: Pick<MediaItem, 'kind' | 'downloadable'> &
    Partial<Pick<MediaItem, 'ext' | 'mime' | 'note'>>
}

/** 规范化 URL 后交给 classify。分片、非媒体、没有 kind 的地址都是 null。 */
function matchMedia(url: string, headers: ResponseDetails['responseHeaders']): Matched | null {
  if (typeof url !== 'string') return null
  const normalized = normalizeUrl(url)
  if (!normalized) return null
  const classified = classify(normalized, headerValue(headers, 'content-type'))
  if (!classified?.kind) return null
  const itemFields: Matched['itemFields'] = {
    kind: classified.kind,
    downloadable: classified.downloadable,
  }
  if (classified.ext) itemFields.ext = classified.ext
  if (classified.mime) itemFields.mime = classified.mime
  if (classified.note) itemFields.note = classified.note
  return { url: normalized, itemFields }
}

function usableDetails(details: ResponseDetails): boolean {
  return isTabId(details.tabId) && Number.isInteger(details.statusCode)
}

/**
 * 把一次响应转成可以新增的媒体条目。
 * 返回 null 的情况：tabId < 0、状态码不是 2xx、206、分片、认不出是媒体。
 * 206 不在这里更新大小，由 startSniffer 的 onSize 处理。
 */
export function detailsToMediaItem(details: ResponseDetails, now = Date.now()): MediaItem | null {
  if (!usableDetails(details)) return null
  if (details.statusCode < 200 || details.statusCode >= 300 || details.statusCode === 206) return null
  const matched = matchMedia(details.url, details.responseHeaders)
  if (!matched) return null
  const item: MediaItem = {
    url: matched.url,
    ...matched.itemFields,
    sources: ['network'],
    firstSeen: seenAt(details.timeStamp, now),
  }
  const size = contentLength(details.responseHeaders)
  if (size !== undefined) item.size = size
  return item
}

/**
 * 仅 206，且能认出是媒体、并带有 Content-Length 时，返回应补的大小。
 * 不产生列表条目。分片和 tabId < 0 同样丢掉。
 */
function readSizeUpdate(details: ResponseDetails): SizeUpdate | null {
  if (!usableDetails(details) || details.statusCode !== 206) return null
  const size = contentLength(details.responseHeaders)
  if (size === undefined) return null
  const matched = matchMedia(details.url, details.responseHeaders)
  if (!matched) return null
  return { tabId: details.tabId, url: matched.url, size }
}

function viewOf(details: chrome.webRequest.OnHeadersReceivedDetails): ResponseDetails {
  return {
    url: details.url,
    tabId: details.tabId,
    statusCode: details.statusCode,
    responseHeaders: details.responseHeaders,
    timeStamp: details.timeStamp,
  }
}

/**
 * 注册观察监听。入口调用一次即可。
 * onFound 只接收新媒体。onSize 可不传；不传时 206 被忽略，不会误新增。
 * 监听回调固定返回 undefined，不提供 BlockingResponse。
 */
function rememberBilibiliM4s(tabId: number, url: string): boolean {
  const key = `${tabId}\n${url}`
  if (seenBilibiliM4s.has(key)) return false
  seenBilibiliM4s.add(key)
  if (seenBilibiliM4s.size > 500) {
    const oldest = seenBilibiliM4s.values().next().value
    if (oldest) seenBilibiliM4s.delete(oldest)
  }
  return true
}

export function startSniffer(
  onFound: (tabId: number, item: MediaItem) => void,
  onSize?: (tabId: number, url: string, size: number) => void,
): void {
  seenBilibiliM4s.clear()
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const view = viewOf(details)
      const bilibili = bilibiliM4sItem(view)
      if (bilibili) {
        // 206 的 Content-Length 是这一段的大小，不能拿去补文件大小。
        if (rememberBilibiliM4s(view.tabId, bilibili.url)) onFound(view.tabId, bilibili)
        return undefined
      }
      const sizeUpdate = readSizeUpdate(view)
      if (sizeUpdate) {
        onSize?.(sizeUpdate.tabId, sizeUpdate.url, sizeUpdate.size)
        return undefined
      }
      const item = detailsToMediaItem(view)
      if (item) onFound(view.tabId, item)
      return undefined
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  )
}
