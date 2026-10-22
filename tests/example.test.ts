import { describe, expect, it } from 'vitest'
import manifestExport from '../manifest.config'

// defineManifest 的返回类型还包含函数和 Promise，运行时这里就是普通对象。
if (typeof manifestExport === 'function' || manifestExport instanceof Promise) {
  throw new Error('manifest 应该是普通对象')
}

const manifest = manifestExport

describe('manifest', () => {
  it('权限与方案第 4 节一致', () => {
    expect(manifest.permissions).toEqual([
      'webRequest',
      'downloads',
      'storage',
      'tabs',
      'clipboardWrite',
    ])
    expect(manifest.host_permissions).toEqual(['<all_urls>'])
    expect(manifest.background).toMatchObject({
      service_worker: 'src/background/index.ts',
      type: 'module',
    })
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['<all_urls>'],
        js: ['src/content/index.ts'],
        all_frames: true,
        run_at: 'document_idle',
      },
    ])
    expect(manifest.action?.default_popup).toBe('src/popup/index.html')
  })
})
