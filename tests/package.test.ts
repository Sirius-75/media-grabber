import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  assertPackableManifest,
  releaseZipPath,
  zipDirectory,
} from '../scripts/zip-dist.mjs'

describe('release 路径', () => {
  it('用版本号生成 zip 文件名', () => {
    expect(releaseZipPath(path.join('repo'), '0.2.1')).toBe(
      path.join('repo', 'release', 'media-grabber-0.2.1.zip'),
    )
  })

  it('拒绝能逃出 release 目录的版本号', () => {
    expect(() => releaseZipPath('repo', '../0.2.0')).toThrow(/版本号无效/)
    expect(() => releaseZipPath('repo', '0.1')).toThrow(/版本号无效/)
    expect(() => releaseZipPath('repo', '1.2.3-beta')).toThrow(/版本号无效/)
  })
})

describe('manifest 检查', () => {
  it('接受当前这种名字、说明和版本', () => {
    expect(() =>
      assertPackableManifest({
        name: 'Media Grabber',
        description: '识别当前页面里的音视频资源，供复制或下载。仅供个人自用。',
        version: '0.2.1',
      }),
    ).not.toThrow()
  })

  it('空字段、过长说明、非法版本都会被拒绝', () => {
    expect(() => assertPackableManifest({ name: '  ', description: '说明', version: '0.2.1' })).toThrow(
      /name/,
    )
    expect(() =>
      assertPackableManifest({
        name: 'Media Grabber',
        description: '字'.repeat(133),
        version: '0.2.1',
      }),
    ).toThrow(/132/)
    expect(() =>
      assertPackableManifest({
        name: 'Media Grabber',
        description: '说明',
        version: '1.2',
      }),
    ).toThrow(/版本号无效/)
  })
})

describe('zip 目录', () => {
  it('manifest.json 在 zip 根目录，子路径只用正斜杠', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mg-zip-'))
    try {
      const src = path.join(root, 'dist')
      await mkdir(path.join(src, 'icons'), { recursive: true })
      await mkdir(path.join(src, 'src', 'popup'), { recursive: true })
      await writeFile(path.join(src, 'manifest.json'), '{"name":"Media Grabber"}\n')
      await writeFile(path.join(src, 'icons', 'icon.txt'), 'icon')
      await writeFile(path.join(src, 'src', 'popup', 'index.html'), '<p>hi</p>')

      const out = path.join(root, 'release', 'media-grabber-0.2.1.zip')
      const result = await zipDirectory(src, out)
      expect(result.fileCount).toBe(3)

      const unzipped = unzipSync(new Uint8Array(await readFile(out)))
      expect(Object.keys(unzipped).sort()).toEqual([
        'icons/icon.txt',
        'manifest.json',
        'src/popup/index.html',
      ])
      expect(new TextDecoder().decode(unzipped['manifest.json'])).toContain('Media Grabber')
      for (const name of Object.keys(unzipped)) {
        expect(name.includes('\\')).toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('根上没有 manifest.json 时不打包', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mg-zip-'))
    try {
      const src = path.join(root, 'dist')
      await mkdir(src)
      await writeFile(path.join(src, 'readme.txt'), 'x')
      await expect(zipDirectory(src, path.join(root, 'out.zip'))).rejects.toThrow(/manifest\.json/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
