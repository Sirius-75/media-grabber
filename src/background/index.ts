/**
 * Service Worker 入口。
 * 列表、角标、标签页清理，以及 GET_MEDIA / CLEAR_MEDIA / MEDIA_FOUND
 * 都在 initStore 里接线。嗅探得到的条目调用 store.addMedia，不要在这里再写一套存储。
 * DOWNLOAD 留给后续任务。
 */
import { initStore } from './store'
import { startSniffer } from './sniffer'

initStore()
startSniffer()

chrome.runtime.onInstalled.addListener(() => {
  console.info('[media-grabber] service worker 已安装')
})
