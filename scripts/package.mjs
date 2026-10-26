/**
 * npm run package
 * 先用 Vite 构建 dist，再把 dist 压成 release/media-grabber-<version>.zip。
 * 用 node 直接启动 vite，不经过 shell，Windows 和 Linux 同一套。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { assertPackableManifest, releaseZipPath, zipDirectory } from './zip-dist.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function runBuild() {
  // vite 的 exports 没有暴露 bin，先定位包目录再进 bin/vite.js。
  const viteDir = path.dirname(require.resolve('vite/package.json'))
  const viteBin = path.join(viteDir, 'bin', 'vite.js')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, 'build'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`构建失败，退出码 ${code ?? '未知'}`))
    })
  })
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

export async function packageExtension() {
  await runBuild()

  const pkg = await readJson(path.join(rootDir, 'package.json'))
  const manifestPath = path.join(rootDir, 'dist', 'manifest.json')
  const manifest = await readJson(manifestPath)
  assertPackableManifest(manifest)
  if (manifest.version !== pkg.version) {
    throw new Error(`manifest 版本 ${manifest.version} 和 package.json 的 ${pkg.version} 不一致`)
  }

  const outFile = releaseZipPath(rootDir, pkg.version)
  const { fileCount } = await zipDirectory(path.join(rootDir, 'dist'), outFile)
  console.log(`已打包 ${fileCount} 个文件：${path.relative(rootDir, outFile)}`)
  console.log('解压后，用「加载已解压的扩展程序」选择解压出来的文件夹。')
  return outFile
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  packageExtension().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
