import { crx } from '@crxjs/vite-plugin'
import { defineConfig } from 'vitest/config'
import manifest from './manifest.config.ts'

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
