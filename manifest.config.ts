import { defineManifest } from '@crxjs/vite-plugin'

/**
 * MV3 manifest。权限与 PLAN.md 第 4 节一致，不额外声明。
 * 图标放在 public/icons，CRXJS 会按 public 目录的根路径解析。
 */
export default defineManifest({
  manifest_version: 3,
  name: 'Media Grabber',
  version: '0.1.0',
  description: '识别当前页面里的音视频资源，供复制或下载。仅供个人自用。',
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  permissions: ['webRequest', 'downloads', 'storage', 'tabs', 'clipboardWrite'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      all_frames: true,
      run_at: 'document_idle',
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
