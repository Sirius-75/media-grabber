/**
 * Service Worker 入口。
 * 列表、角标、标签页清理，以及 GET_MEDIA / CLEAR_MEDIA / MEDIA_FOUND
 * 都在 initStore 里接线。
 * 嗅探只观察响应头：新媒体交给 addMedia，206 只交给 fillMediaSize，不在这里另写存储。
 * DOWNLOAD 在 download.ts 里处理：直链交给 chrome.downloads，不改请求头。
 */
import { listenForDownload } from './download'
import { addMedia, fillMediaSize, initStore } from './store'
import { startSniffer } from './sniffer'

initStore()
listenForDownload()

startSniffer(
  (tabId, item) => {
    console.info(
      '[media-grabber] 发现媒体',
      tabId,
      item.kind,
      item.ext ?? '',
      item.size ?? '未知大小',
      item.url,
    )
    void addMedia(tabId, item).catch((error: unknown) => {
      console.warn('[media-grabber] 写入媒体失败', error)
    })
  },
  (tabId, url, size) => {
    console.info('[media-grabber] 206 更新大小', tabId, size, url)
    void fillMediaSize(tabId, url, size).catch((error: unknown) => {
      console.warn('[media-grabber] 更新大小失败', error)
    })
  },
)

chrome.runtime.onInstalled.addListener(() => {
  console.info('[media-grabber] service worker 已安装')
})
