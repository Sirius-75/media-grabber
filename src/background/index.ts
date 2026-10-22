/**
 * Service Worker 入口（占位）。
 * 只确认后台脚本能启动，不处理消息、不嗅探、不下载。
 */
import { initStore } from './store'
import { startSniffer } from './sniffer'

initStore()
startSniffer()

chrome.runtime.onInstalled.addListener(() => {
  console.info('[media-grabber] service worker 已安装')
})
