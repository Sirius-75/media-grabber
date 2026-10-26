/**
 * 下载文件名。
 * 由页面标题或 URL 里的文件名得到，再收成 Windows / macOS 都能保存的名字。
 * 不访问 chrome，方便单测。
 */

/** 主体（不含扩展名）最长这么多个码点。远小于 Windows 单段 255 的上限。 */
export const MAX_DOWNLOAD_STEM_LENGTH = 80

/** 标题和 URL 都拿不出名字时用它。 */
export const DOWNLOAD_FILENAME_FALLBACK = '媒体'

/**
 * Windows 和 macOS 都不允许放进文件名的字符：
 * \ / : * ? " < > |，以及 C0 / DEL / C1 控制字符、行分隔符。
 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/**
 * Windows 保留设备名。大小写不敏感，后面跟不跟扩展名都算。
 * 例如 CON.txt、NUL.mp4 也不能用。
 */
const RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 会从名字末尾拿掉的媒体扩展名，避免补上正确扩展名后变成 clip.webm.mp4。 */
const TRAILING_MEDIA_EXT = /\.(mp4|webm|mp3|m4a|m3u8|mpd)$/i

export interface DownloadFilenameInput {
  /** 页面标题。清洗后为空则不用。 */
  title?: string
  /** 媒体 URL。标题不可用时，取路径最后一段当文件名。 */
  url?: string
  /** 正确的扩展名，不带点。有的话一定会补上。 */
  ext?: string
  /**
   * 列表里的序号，从 1 开始。
   * 只用在标题（或兜底名）上，形式是「标题-序号.扩展名」。
   * 调用方已经给了 filename，或名字来自 URL 时不追加。
   */
  index?: number
  /** 消息里自带的文件名。先清洗；洗完是空的再退回标题或 URL。 */
  filename?: string
}

function graphemes(value: string): string[] {
  return Array.from(value)
}

function trimEdges(value: string): string {
  return value.replace(/^[\s.]+|[\s.]+$/g, '')
}

/** 去掉非法字符和控制字符，收紧空白，去掉首尾的空格和点。 */
export function sanitizeStem(raw: string): string {
  const stripped = raw.replace(ILLEGAL_FILENAME_CHARS, '')
  const collapsed = stripped.replace(/\s+/g, ' ')
  return trimEdges(collapsed)
}

function cleanExt(ext: string | undefined): string | undefined {
  if (typeof ext !== 'string') return undefined
  const value = ext.trim().toLowerCase().replace(/^\./, '')
  if (!/^[a-z0-9]{1,8}$/.test(value)) return undefined
  return value
}

function baseName(filename: string): string {
  const normalized = filename.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] ?? ''
}

function extensionFromUrl(url: string | undefined): string | undefined {
  const stem = fileNameFromUrl(url)
  const dot = stem.lastIndexOf('.')
  if (dot <= 0 || dot === stem.length - 1) return undefined
  return cleanExt(stem.slice(dot + 1))
}

/** URL 路径的最后一段，已解码。拿不到就返回空字符串。 */
function fileNameFromUrl(url: string | undefined): string {
  if (typeof url !== 'string') return ''
  let path = url.trim()
  if (!path) return ''
  try {
    path = new URL(path).pathname
  } catch {
    const hash = path.indexOf('#')
    if (hash >= 0) path = path.slice(0, hash)
    const query = path.indexOf('?')
    if (query >= 0) path = path.slice(0, query)
  }
  let base = path.split('/').pop() ?? ''
  if (!base) return ''
  try {
    base = decodeURIComponent(base)
  } catch {
    // 非法的 % 序列保持原样，后面还会再清洗。
  }
  return base
}

function stripMediaExt(stem: string, ext: string | undefined): string {
  let value = stem
  if (ext && value.toLowerCase().endsWith(`.${ext}`)) {
    value = value.slice(0, -(ext.length + 1))
  } else if (TRAILING_MEDIA_EXT.test(value)) {
    value = value.replace(TRAILING_MEDIA_EXT, '')
  }
  return trimEdges(value)
}

/** 保留名在第一个点之前。CON.txt 改成 CON_.txt，避免 Windows 当成设备。 */
function avoidReserved(stem: string): string {
  const dot = stem.indexOf('.')
  const head = dot === -1 ? stem : stem.slice(0, dot)
  if (!RESERVED_FILENAME.test(head)) return stem
  if (dot === -1) return `${head}_`
  return `${head}_${stem.slice(dot)}`
}

/** 按码点截断，避免把 emoji 的代理对切成一半，并去掉截断后末尾的空格和点。 */
function limitCodePoints(value: string, max: number): string {
  const chars = graphemes(value)
  if (chars.length <= max) return trimEdges(value)
  return trimEdges(chars.slice(0, max).join(''))
}

/**
 * 先避开保留名，再保证非空且不超过 max。
 * 序号要先拼上再检查：CON-1 不是保留名，单独的 CON 才是。
 */
function fitStem(stem: string, max: number): string {
  const cleaned = trimEdges(stem)
  let value = avoidReserved(cleaned || DOWNLOAD_FILENAME_FALLBACK)
  if (graphemes(value).length <= max && value) return value

  const sliced = trimEdges(graphemes(value).slice(0, max).join(''))
  value = avoidReserved(sliced || DOWNLOAD_FILENAME_FALLBACK)
  if (graphemes(value).length <= max && value) return value

  const room = Math.max(1, max - 1)
  const shorter = trimEdges(graphemes(value).slice(0, room).join(''))
  value = avoidReserved(shorter || DOWNLOAD_FILENAME_FALLBACK)
  if (graphemes(value).length <= max && value) return value
  return graphemes(value).slice(0, max).join('') || DOWNLOAD_FILENAME_FALLBACK
}

function positiveIndex(index: number | undefined): number | undefined {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) return undefined
  return index
}

/**
 * 生成最终文件名，带正确扩展名。
 * 优先用 filename，其次页面标题（加序号），再其次 URL 文件名，最后用「媒体」。
 */
export function buildDownloadFilename(input: DownloadFilenameInput): string {
  const fromUrl = fileNameFromUrl(input.url)
  const ext = cleanExt(input.ext) ?? cleanExt(extensionFromUrl(input.url))
  const explicit = sanitizeStem(baseName(input.filename ?? ''))
  const fromTitle = sanitizeStem(input.title ?? '')
  const urlStem = sanitizeStem(fromUrl)

  let stem = ''
  let withIndex = false
  if (explicit) {
    stem = explicit
  } else if (fromTitle) {
    stem = fromTitle
    withIndex = true
  } else if (urlStem) {
    stem = urlStem
  } else {
    stem = DOWNLOAD_FILENAME_FALLBACK
    withIndex = true
  }

  stem = stripMediaExt(stem, ext) || DOWNLOAD_FILENAME_FALLBACK

  const index = withIndex ? positiveIndex(input.index) : undefined
  const suffix = index === undefined ? '' : `-${index}`
  const room = Math.max(1, MAX_DOWNLOAD_STEM_LENGTH - graphemes(suffix).length)
  // 先给序号留位置，再对完整主体做保留名和长度检查。
  const head = limitCodePoints(stem, room) || DOWNLOAD_FILENAME_FALLBACK
  const combined = fitStem(`${head}${suffix}`, MAX_DOWNLOAD_STEM_LENGTH)
  if (!ext) return combined
  return `${combined}.${ext}`
}
