/**
 * 在隔离世界里扫描本 frame 的 video / audio。
 * 只读 DOM：不往页面主世界注入脚本，也不改页面的网络请求或解析函数。
 * 其它 frame 由 all_frames 各自注入，这里不碰 iframe.contentDocument。
 */

import { draftFromTrack, parsePlayinfoScripts, preferBilibiliMeta } from '../shared/bilibili'
import { classify, normalizeUrl, type MediaClassification } from '../shared/classify'
import { MESSAGE_TYPE } from '../shared/messages'
import type { MediaItemDraft, MediaKind } from '../shared/types'

/**
 * 连续 DOM 变化合成一次上报。
 * 300ms 足够把同一轮插入并在一起，并且保证 1 秒内能发给后台。
 */
export const DOM_SCAN_DEBOUNCE_MS = 300

/**
 * currentSrc 往往要等资源选择之后才有值。
 * 这些媒体事件不冒泡，所以在 document 上用捕获阶段听。
 * emptied 表示当前资源被清空或换掉，需要再扫一遍。
 */
const MEDIA_EVENTS = ['loadstart', 'loadedmetadata', 'emptied'] as const

export interface ScannerOptions {
  /** 默认用当前文档。测试可以传入别的 document。 */
  document?: Document
  /** 发现变化时调用。扩展里负责发给 background。 */
  send: (items: MediaItemDraft[]) => void
  /** 默认 {@link DOM_SCAN_DEBOUNCE_MS}。 */
  debounceMs?: number
  /** 默认 Date.now。同一个 URL 的 firstSeen 只记第一次。 */
  now?: () => number
  /**
   * 本 frame 的页面地址。
   * 传入空字符串表示不附带；不传则从 location 推断 http(s) 地址。
   */
  frameUrl?: string
}

export interface ScannerHandle {
  stop: () => void
}

interface CollectOptions {
  now: number
  frameUrl?: string
  firstSeen: Map<string, number>
}

/**
 * document_start 时 documentElement 可能还不存在。
 * 等到能观察 DOM 再回调；返回的函数会卸掉等待中的监听。
 */
export function whenDocumentElementReady(doc: Document, ready: () => void): () => void {
  if (doc.documentElement) {
    ready()
    return () => {}
  }

  let settled = false
  const state: { observer?: MutationObserver } = {}

  const finish = () => {
    if (settled || !doc.documentElement) return
    settled = true
    state.observer?.disconnect()
    doc.removeEventListener('DOMContentLoaded', finish)
    ready()
  }

  state.observer = new MutationObserver(finish)
  state.observer.observe(doc, { childList: true })
  doc.addEventListener('DOMContentLoaded', finish)

  return () => {
    if (settled) return
    settled = true
    state.observer?.disconnect()
    doc.removeEventListener('DOMContentLoaded', finish)
  }
}

/** 把变化过的条目发给 background。失败时不往页面控制台抛。 */
export function deliverMediaFound(items: MediaItemDraft[]): void {
  if (items.length === 0) return
  const chromeApi = (globalThis as { chrome?: typeof chrome }).chrome
  if (!chromeApi?.runtime?.sendMessage) return

  try {
    void chromeApi.runtime
      .sendMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items,
      })
      .catch(() => {
        // 接收端不存在或扩展上下文已失效时静默忽略，避免页面出现未捕获错误。
      })
  } catch {
    // sendMessage 同步抛错时同样吞掉，避免页面出现 console error。
  }
}

/** 扫描当前文档并在变化时调用 send。重复调用 stop 是安全的。 */
export function startScanner(options: ScannerOptions): ScannerHandle {
  const doc = options.document ?? globalThis.document
  if (!doc) return { stop() {} }

  const debounceMs = options.debounceMs ?? DOM_SCAN_DEBOUNCE_MS
  const now = options.now ?? (() => Date.now())
  const frameUrl = resolveFrameUrl(doc, options.frameUrl)
  const reported = new Map<string, string>()
  const firstSeen = new Map<string, number>()

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let domObserver: MutationObserver | null = null

  const flush = () => {
    timer = null
    if (stopped || !doc.documentElement) return
    publish(
      collectMediaItems(doc, { now: now(), frameUrl, firstSeen }),
      reported,
      options.send,
    )
  }

  const schedule = () => {
    if (stopped) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }

  const onMediaEvent = (event: Event) => {
    if (!isVideoOrAudio(event.target)) return
    schedule()
  }

  const onMutation = (records: MutationRecord[]) => {
    if (records.some(mutationTouchesMedia)) schedule()
  }

  const arm = () => {
    if (stopped || domObserver) return
    domObserver = new MutationObserver(onMutation)
    domObserver.observe(doc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    })
    for (const name of MEDIA_EVENTS) {
      doc.addEventListener(name, onMediaEvent, true)
    }
    schedule()
  }

  const cancelReady = whenDocumentElementReady(doc, arm)

  return {
    stop() {
      if (stopped) return
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      cancelReady()
      domObserver?.disconnect()
      domObserver = null
      for (const name of MEDIA_EVENTS) {
        doc.removeEventListener(name, onMediaEvent, true)
      }
    },
  }
}

function resolveFrameUrl(doc: Document, explicit: string | undefined): string | undefined {
  if (explicit !== undefined) return explicit.trim() || undefined
  const href = doc.defaultView?.location?.href
  if (!href || href === 'about:blank') return undefined
  try {
    const protocol = new URL(href).protocol
    if (protocol !== 'http:' && protocol !== 'https:') return undefined
  } catch {
    return undefined
  }
  return normalizeUrl(href) || undefined
}

/**
 * 和上次成功发出的签名比较，只提交新出现或字段有变化的条目。
 * 发送抛错时不记签名，下一轮扫描会重试。
 */
function publish(
  items: MediaItemDraft[],
  reported: Map<string, string>,
  send: (items: MediaItemDraft[]) => void,
): void {
  const changed: MediaItemDraft[] = []
  const signatures = new Map<string, string>()
  for (const item of items) {
    const signature = itemSignature(item)
    signatures.set(item.url, signature)
    if (reported.get(item.url) === signature) continue
    changed.push(item)
  }
  if (changed.length === 0) return

  try {
    send(changed)
  } catch {
    return
  }

  for (const item of changed) {
    const signature = signatures.get(item.url)
    if (signature !== undefined) reported.set(item.url, signature)
  }
}

function itemSignature(item: MediaItemDraft): string {
  return JSON.stringify([
    item.url,
    item.kind ?? null,
    item.ext ?? null,
    item.mime ?? null,
    item.downloadable ?? null,
    item.note ?? null,
    item.frameUrl ?? null,
    item.sources ?? null,
    item.bilibili?.role ?? null,
    item.bilibili?.label ?? null,
  ])
}

function collectMediaItems(doc: Document, options: CollectOptions): MediaItemDraft[] {
  const found = new Map<string, MediaItemDraft>()
  for (const node of doc.querySelectorAll('video, audio')) {
    if (!isVideoOrAudio(node)) continue
    const kind: MediaKind = node.tagName.toLowerCase() === 'audio' ? 'audio' : 'video'
    // currentSrc 才是正在播的地址，不能只看 src 属性。
    consider(found, readCurrentSrc(node), kind, undefined, options)
    consider(found, readReflectedSrc(node), kind, undefined, options)
    for (const source of sourceChildren(node)) {
      consider(found, readReflectedSrc(source), kind, mimeHint(source), options)
    }
  }
  // 隔离世界读不到 window.__playinfo__，所以只解析 script 文本。失败的脚本跳过。
  for (const track of parsePlayinfoScripts(playinfoScriptTexts(doc))) {
    const draft = draftFromTrack(track, options)
    const existing = found.get(draft.url)
    found.set(draft.url, existing ? mergeDraft(existing, draft) : draft)
  }
  return [...found.values()]
}

function playinfoScriptTexts(doc: Document): string[] {
  const texts: string[] = []
  for (const node of doc.querySelectorAll('script')) {
    const text = node.textContent ?? ''
    if (!text.includes('__playinfo__')) continue
    texts.push(text)
  }
  return texts
}

function consider(
  found: Map<string, MediaItemDraft>,
  raw: string,
  elementKind: MediaKind,
  mime: string | undefined,
  options: CollectOptions,
): void {
  if (!raw) return
  const url = normalizeUrl(raw)
  if (!url) return

  const classification = classify(url, mime)
  if (!shouldReport(url, classification)) return

  const draft = toDraft(url, elementKind, classification, options)
  const existing = found.get(url)
  found.set(url, existing ? mergeDraft(existing, draft) : draft)
}

function toDraft(
  url: string,
  elementKind: MediaKind,
  classification: MediaClassification | null,
  options: CollectOptions,
): MediaItemDraft {
  let firstSeen = options.firstSeen.get(url)
  if (firstSeen === undefined) {
    firstSeen = options.now
    options.firstSeen.set(url, firstSeen)
  }

  const draft: MediaItemDraft = {
    url,
    kind: classification?.kind ?? elementKind,
    sources: ['dom'],
    downloadable: classification?.downloadable ?? true,
    firstSeen,
  }
  if (classification?.ext) draft.ext = classification.ext
  if (classification?.mime) draft.mime = classification.mime
  if (classification?.note) draft.note = classification.note
  if (options.frameUrl) draft.frameUrl = options.frameUrl
  return draft
}

function mergeDraft(current: MediaItemDraft, extra: MediaItemDraft): MediaItemDraft {
  const merged: MediaItemDraft = { ...current }
  if (!merged.kind && extra.kind) merged.kind = extra.kind
  if (!merged.ext && extra.ext) merged.ext = extra.ext
  if (!merged.mime && extra.mime) merged.mime = extra.mime
  if (!merged.note && extra.note) merged.note = extra.note
  if (!merged.frameUrl && extra.frameUrl) merged.frameUrl = extra.frameUrl
  if (extra.downloadable === false) merged.downloadable = false
  const bilibili = preferBilibiliMeta(current.bilibili, extra.bilibili)
  if (bilibili) merged.bilibili = bilibili
  return merged
}

/**
 * blob / data 由 classify 标成不可下载。
 * 扩展名认不出、但仍是 http(s) 的地址也保留（播放器直链经常没有后缀）。
 * .ts / .m4s 分片不收录，和分类规则一致。
 */
function shouldReport(url: string, classification: MediaClassification | null): boolean {
  if (classification) return true
  if (isSegmentUrl(url)) return false
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isSegmentUrl(url: string): boolean {
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    return false
  }
  const base = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return false
  const ext = base.slice(dot + 1).toLowerCase()
  return ext === 'ts' || ext === 'm4s'
}

/**
 * 空的 src 属性在浏览器里会把 .src 反射成文档地址，不能当成媒体。
 * 属性非空时优先用反射后的绝对地址，相对路径才能和绝对路径去重。
 */
function readReflectedSrc(element: Element): string {
  const raw = element.getAttribute('src')
  if (raw === null || raw.trim() === '') return ''
  const reflected = (element as { src?: unknown }).src
  if (typeof reflected === 'string' && reflected.trim() !== '') return reflected.trim()
  return raw.trim()
}

function readCurrentSrc(element: Element): string {
  const value = (element as HTMLMediaElement).currentSrc
  return typeof value === 'string' ? value.trim() : ''
}

function mimeHint(element: Element): string | undefined {
  const type = element.getAttribute('type')
  if (!type) return undefined
  const trimmed = type.trim()
  return trimmed || undefined
}

/** media 元素只用直接子级的 source 作为候选。 */
function sourceChildren(element: Element): Element[] {
  const sources: Element[] = []
  for (const child of element.children) {
    if (child.tagName.toLowerCase() === 'source') sources.push(child)
  }
  return sources
}

function isVideoOrAudio(node: EventTarget | null): node is Element {
  if (!(node instanceof Element)) return false
  const tag = node.tagName.toLowerCase()
  return tag === 'video' || tag === 'audio'
}

function nodeContainsMedia(node: Node): boolean {
  if (!(node instanceof Element)) return false
  const tag = node.tagName.toLowerCase()
  if (tag === 'video' || tag === 'audio' || tag === 'source') return true
  return node.querySelector('video, audio, source') !== null
}

function mutationTouchesMedia(record: MutationRecord): boolean {
  if (record.type === 'attributes') {
    if (!(record.target instanceof Element)) return false
    const tag = record.target.tagName.toLowerCase()
    return tag === 'video' || tag === 'audio' || tag === 'source'
  }
  if (record.type !== 'childList') return false
  if (isVideoOrAudio(record.target)) return true
  for (const node of record.addedNodes) {
    if (nodeContainsMedia(node) || nodeHasPlayinfoScript(node)) return true
  }
  for (const node of record.removedNodes) {
    if (nodeContainsMedia(node)) return true
  }
  return false
}

function nodeHasPlayinfoScript(node: Node): boolean {
  if (!(node instanceof Element)) return false
  if (node.localName === 'script') return (node.textContent ?? '').includes('__playinfo__')
  if (typeof node.querySelectorAll !== 'function') return false
  for (const script of node.querySelectorAll('script')) {
    if ((script.textContent ?? '').includes('__playinfo__')) return true
  }
  return false
}
