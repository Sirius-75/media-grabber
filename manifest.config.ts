import { defineManifest } from '@crxjs/vite-plugin'

/**
 * MV3 manifest。权限与 PLAN.md 第 4 节一致。
 * offscreen 是 v2 才加的：HLS 和 DASH 分片下载放在 offscreen document 里，不放在 service worker。
 * 图标放在 public/icons，CRXJS 会按 public 目录的根路径解析。
 *
 * name、description、version 是扩展卡片上给用户看的。
 * name 用 Media Grabber，和弹窗标题一致。
 * description 用中文说明用途，并写明仅供个人自用，长度留在 Chrome 的 132 字以内。
 * version 用 0.2.2，和 package.json 相同。打包时会再核对一次。
 * declarativeNetRequestWithHostAccess 只给 B 站分轨下载补 Referer，见 PLAN.md 第 4 节。
 */
export default defineManifest({
  manifest_version: 3,
  name: 'Media Grabber',
  version: '0.2.2',
  description: '识别当前页面里的音视频资源，供复制或下载。仅供个人自用。',
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  permissions: [
    'webRequest',
    'downloads',
    'storage',
    'tabs',
    'clipboardWrite',
    'offscreen',
    'declarativeNetRequestWithHostAccess',
  ],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      // 每个 frame 各自扫自己的 DOM。不设 world，保持默认的隔离世界，不进入 MAIN。
      // document_start 才能在页面脚本改 DOM 之前装上 MutationObserver；
      // 这时 documentElement 可能还没有，入口会等 DOM 可用再扫。
      all_frames: true,
      run_at: 'document_start',
    },
  ],
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Media Grabber',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
})
