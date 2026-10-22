import { crx } from '@crxjs/vite-plugin'
import { defineConfig } from 'vitest/config'
import manifest from './manifest.config.ts'

/**
 * CRXJS 读取 manifest 里的入口并打成 MV3 扩展。
 * `npm run dev` 会把可加载目录写到 dist/，并给 popup / content script 提供热更新。
 * 跑 Vitest 时不挂 CRXJS，避免测试进程去启动扩展开发服务器。
 */
export default defineConfig({
  plugins: process.env.VITEST ? [] : [crx({ manifest })],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
