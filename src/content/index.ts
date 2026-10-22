/**
 * Content Script 入口。
 * manifest 用 document_start 注入，这里会等 DOM 可用再扫描。
 * 运行在隔离世界：globalThis 不是页面主世界，不注入脚本，也不挂钩网络。
 */
import { deliverMediaFound, startScanner } from './scanner'

const marker = '__mediaGrabberContentStarted'
const host = globalThis as typeof globalThis & Record<string, boolean>

if (!host[marker]) {
  host[marker] = true
  console.debug('[media-grabber] content script 已注入')
  startScanner({ send: deliverMediaFound })
}
