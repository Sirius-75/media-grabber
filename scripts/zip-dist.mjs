/**
 * 把一个目录打成 zip。路径一律用 /，这样 Windows 和 Linux 解压结果一样。
 * 给扩展用时，manifest.json 必须在源目录的根上，打出来也在 zip 根上。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zipSync } from 'fflate'

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** Chrome 扩展版本是数字三段。拒绝 ../ 之类，避免 zip 写到 release 外面。 */
export function releaseZipPath(rootDir, version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`版本号无效：${version}`)
  }
  return path.join(rootDir, 'release', `media-grabber-${version}.zip`)
}

/**
 * 打包前看一眼 manifest。
 * name / description 留在 Chrome 的长度限制里，version 必须是 x.y.z。
 */
export function assertPackableManifest(manifest) {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error('manifest.json 不是对象')
  }
  for (const key of ['name', 'description', 'version']) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') {
      throw new Error(`manifest 的 ${key} 不能是空的`)
    }
  }
  if ([...manifest.name].length > 75) {
    throw new Error('manifest name 超过 75 个字符')
  }
  if ([...manifest.description].length > 132) {
    throw new Error('manifest description 超过 132 个字符')
  }
  if (!VERSION_PATTERN.test(manifest.version)) {
    throw new Error(`manifest 版本号无效：${manifest.version}`)
  }
}

async function collectFiles(sourceDir) {
  /** @type {Record<string, Uint8Array>} */
  const files = {}

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const rel = path.relative(sourceDir, full).split(path.sep).join('/')
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`拒绝把目录外的文件打进 zip：${rel}`)
      }
      files[rel] = new Uint8Array(await readFile(full))
    }
  }

  await walk(sourceDir)
  return files
}

/** 把 sourceDir 里的文件写到 outFile。返回打进去的文件数。 */
export async function zipDirectory(sourceDir, outFile) {
  const files = await collectFiles(sourceDir)
  if (!Object.prototype.hasOwnProperty.call(files, 'manifest.json')) {
    throw new Error('dist 根目录没有 manifest.json，无法打包')
  }
  await mkdir(path.dirname(outFile), { recursive: true })
  await writeFile(outFile, zipSync(files, { level: 6 }))
  return { fileCount: Object.keys(files).length }
}
