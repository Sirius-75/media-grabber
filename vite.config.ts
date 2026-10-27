import { crx } from '@crxjs/vite-plugin'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import manifest from './manifest.config.ts'

/**
 * CRXJS 只会打包 manifest 里点名的 HTML。
 * offscreen 没有自己的字段，所以先临时写成 options_page 让页面进包，
 * 正式构建再从 manifest 里删掉，避免扩展卡片上多出一个选项页。
 * 开发模式留着 options_page，CRXJS 才能把这个页面交给 Vite。
 */
function offscreenPage(): Plugin {
  let command: 'build' | 'serve' = 'build'
  return {
    name: 'media-grabber-offscreen',
    configResolved(config) {
      command = config.command
    },
    transformCrxManifest(manifestDraft: { options_page?: string }) {
      manifestDraft.options_page = 'src/offscreen/offscreen.html'
      return manifestDraft
    },
    renderCrxManifest(manifestDraft: { options_page?: string }) {
      if (command === 'build') delete manifestDraft.options_page
      return manifestDraft
    },
  } as Plugin
}

/**
 * CRXJS 读取 manifest 里的入口并打成 MV3 扩展。
 * `npm run dev` 会把可加载目录写到 dist/，并给 popup / content script 提供热更新。
 * 跑 Vitest 时不挂 CRXJS，避免测试进程去启动扩展开发服务器。
 *
 * content script 的 run_at 是 document_start。不打成独立 IIFE 的话，
 * 开发模式会用异步 loader，脚本要等模块下载完才执行，观察器会装晚。
 */
export default defineConfig({
  plugins: process.env.VITEST
    ? []
    : [
        crx({
          manifest,
          contentScripts: {
            standaloneFiles: ['src/content/index.ts'],
          },
        }),
        offscreenPage(),
      ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 验收要求 classify.ts 覆盖率至少 90%。只统计这个文件，避免被占位模块稀释。
    coverage: {
      provider: 'v8',
      include: ['src/shared/classify.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
})
