/**
 * 按 tab 保存媒体列表。
 *
 * 列表放在 chrome.storage.session，键是 `tab:${tabId}`。service worker 被回收后数据还在，
 * 关掉浏览器后由浏览器自己清掉。去重键用 normalizeUrl（去掉 hash，协议和主机名小写）。
 * 同一条再次出现时合并 sources，并补上还没有的 size / mime / ext / note / frameUrl；
 * 已经有的大小不被后来的值覆盖。每个 tab 最多 200 条，超出时按写入顺序丢掉最早的。
 *
 * 对外主要是 addMedia / addItems / getItems / clearTab / fillMediaSize。
 * T4 嗅探直接调用这些函数，不要自己读写 storage。
 * T5 发 MEDIA_FOUND 即可，initStore 会从 sender.tab.id 取出 tab 再入库。
 * DOWNLOAD 由 download.ts 回复，这里不处理。
 */

import { classify, normalizeUrl } from '../shared/classify'
import { isBlocked } from '../shared/blocklist'
import { isClearMediaMessage, isGetMediaMessage, isMediaFoundMessage } from '../shared/messages'
import {
  MEDIA_KINDS,
  MEDIA_SOURCES,
  type MediaItem,
  type MediaItemDraft,
  type MediaKind,
  type MediaSource,
} from '../shared/types'

/** 单个 tab 最多保留的条数。再写入新 URL 时丢掉最早的那几条。 */
export const MAX_ITEMS_PER_TAB = 200

const STORAGE_PREFIX = 'tab:'
const BADGE_COLOR = '#1a73e8'
const BADGE_TEXT_COLOR = '#ffffff'

/** 同一轮顶层加载是否还在进行。只活在当前 worker 里，用来忽略重复的 loading 通知。 */
interface NavigationState {
  loading: boolean
  url?: string
}

const navigation = new Map<number, NavigationState>()
/**
 * 这次顶层导航已经在 main_frame 的 onBeforeRequest 里清过列表。
 * 文档请求先发出，预加载扫描器随后就会拉 video / audio；这些响应头经常比
 * tabs.onUpdated 里「URL 已提交」的那次 loading 更早到达。若 loading 再清一次，
 * 刚写入的条目会被删掉，而请求不会重来。complete 之后才丢掉这个标记，
 * 让没有 webRequest 的 loading（例如往返缓存）仍能清空。
 */
const topLevelRequests = new Set<number>()
const writeTails = new Map<number, Promise<void>>()
let listening = false

function storageKey(tabId: number): string {
  return `${STORAGE_PREFIX}${tabId}`
}

function isValidTabId(tabId: number): boolean {
  return Number.isInteger(tabId) && tabId >= 0
}

function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === 'string' && (MEDIA_KINDS as readonly string[]).includes(value)
}

function isMediaSource(value: unknown): value is MediaSource {
  return typeof value === 'string' && (MEDIA_SOURCES as readonly string[]).includes(value)
}

function isMediaItem(value: unknown): value is MediaItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<MediaItem>
  if (typeof item.url !== 'string' || item.url === '') return false
  if (!isMediaKind(item.kind)) return false
  if (!Array.isArray(item.sources) || !item.sources.every(isMediaSource)) return false
  if (typeof item.downloadable !== 'boolean') return false
  if (typeof item.firstSeen !== 'number' || !Number.isFinite(item.firstSeen)) return false
  if (item.ext !== undefined && typeof item.ext !== 'string') return false
  if (item.mime !== undefined && typeof item.mime !== 'string') return false
  if (item.note !== undefined && typeof item.note !== 'string') return false
  if (item.frameUrl !== undefined && typeof item.frameUrl !== 'string') return false
  if (
    item.size !== undefined &&
    (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0)
  ) {
    return false
  }
  return true
}

function cloneItem(item: MediaItem): MediaItem {
  return { ...item, sources: [...item.sources] }
}

/**
 * 同一个 tab 的读-改-写串起来。
 * 嗅探和 content script 会同时进来，不排队的话后一次 set 会把前一次的结果盖掉。
 */
function enqueue<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const previous = writeTails.get(tabId) ?? Promise.resolve()
  const current = previous.then(() => task())
  writeTails.set(
    tabId,
    current.then(
      () => undefined,
      () => undefined,
    ),
  )
  return current
}

function warn(message: string, error: unknown): void {
  console.warn(`[media-grabber] ${message}`, error)
}

async function readItems(tabId: number): Promise<MediaItem[]> {
  const key = storageKey(tabId)
  const data = (await chrome.storage.session.get(key)) as Record<string, unknown>
  const value = data[key]
  if (!Array.isArray(value)) return []
  const items: MediaItem[] = []
  for (const entry of value) {
    if (isMediaItem(entry)) items.push(cloneItem(entry))
  }
  return items
}

async function writeItems(tabId: number, items: readonly MediaItem[]): Promise<void> {
  await chrome.storage.session.set({ [storageKey(tabId)]: items.map(cloneItem) })
}

/** 没有条数时传空字符串，浏览器会把角标隐藏掉。 */
async function setBadge(tabId: number, count: number): Promise<void> {
  const text = count > 0 ? String(count) : ''
  try {
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId })
      await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR, tabId })
    }
    await chrome.action.setBadgeText({ text, tabId })
  } catch (error) {
    warn('更新角标失败', error)
  }
}

function cleanExt(ext: string | undefined): string | undefined {
  if (typeof ext !== 'string') return undefined
  const value = ext.trim().toLowerCase().replace(/^\./, '')
  return value || undefined
}

/** 存进展里的 MIME：小写，去掉 `;` 后面的参数。不像 Content-Type 就丢掉。 */
function cleanMime(mime: string | undefined): string | undefined {
  if (typeof mime !== 'string') return undefined
  const mediaType = mime.trim().toLowerCase().split(';')[0]?.trim() ?? ''
  if (!mediaType.includes('/')) return undefined
  return mediaType
}

function cleanText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function cleanSize(size: number | undefined): number | undefined {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined
  return size
}

function unionSources(left: readonly MediaSource[], right: readonly MediaSource[]): MediaSource[] {
  const merged: MediaSource[] = []
  for (const source of [...left, ...right]) {
    if (isMediaSource(source) && !merged.includes(source)) merged.push(source)
  }
  return merged
}

function buildItem(fields: {
  url: string
  kind: MediaKind
  sources: MediaSource[]
  downloadable: boolean
  firstSeen: number
  ext?: string
  mime?: string
  size?: number
  note?: string
  frameUrl?: string
}): MediaItem {
  const item: MediaItem = {
    url: fields.url,
    kind: fields.kind,
    sources: fields.sources,
    downloadable: fields.downloadable,
    firstSeen: fields.firstSeen,
  }
  if (fields.ext !== undefined) item.ext = fields.ext
  if (fields.mime !== undefined) item.mime = fields.mime
  if (fields.size !== undefined) item.size = fields.size
  if (fields.note !== undefined) item.note = fields.note
  if (fields.frameUrl !== undefined) item.frameUrl = fields.frameUrl
  return item
}

/** 调用方没给的字段用 classify 补。补不出 kind 的地址不入库。黑名单直接丢掉。 */
function toMediaItem(draft: MediaItemDraft, now: number): MediaItem | null {
  if (typeof draft !== 'object' || draft === null || typeof draft.url !== 'string') return null
  const url = normalizeUrl(draft.url)
  if (!url) return null
  if (isBlocked(draft.url) || isBlocked(url)) return null

  const mime = cleanMime(draft.mime)
  const classified = classify(url, mime)
  const kind = draft.kind ?? classified?.kind
  if (!kind) return null

  const firstSeen =
    typeof draft.firstSeen === 'number' && Number.isFinite(draft.firstSeen) ? draft.firstSeen : now
  const sources = Array.isArray(draft.sources) ? draft.sources : []

  return buildItem({
    url,
    kind,
    sources: unionSources(sources, []),
    downloadable: draft.downloadable ?? classified?.downloadable ?? false,
    firstSeen,
    ext: cleanExt(draft.ext) ?? classified?.ext,
    mime: mime ?? classified?.mime,
    size: cleanSize(draft.size),
    note: cleanText(draft.note) ?? classified?.note,
    frameUrl: cleanText(draft.frameUrl),
  })
}

/** 只补空缺。kind、downloadable 和已经写过的 size 保持先到的那次。 */
function mergeItems(existing: MediaItem, incoming: MediaItem): MediaItem {
  const firstSeen = Math.min(existing.firstSeen, incoming.firstSeen)
  return buildItem({
    url: existing.url,
    kind: existing.kind,
    sources: unionSources(existing.sources, incoming.sources),
    downloadable: existing.downloadable,
    firstSeen,
    ext: existing.ext ?? incoming.ext,
    mime: existing.mime ?? incoming.mime,
    size: existing.size ?? incoming.size,
    note: existing.note ?? incoming.note,
    frameUrl: existing.frameUrl ?? incoming.frameUrl,
  })
}

async function addItemsUnlocked(
  tabId: number,
  drafts: readonly MediaItemDraft[],
): Promise<MediaItem[]> {
  const items = await readItems(tabId)
  const now = Date.now()
  let changed = false
  for (const draft of drafts) {
    const incoming = toMediaItem(draft, now)
    if (!incoming) continue
    const index = items.findIndex((item) => item.url === incoming.url)
    if (index >= 0) {
      const merged = mergeItems(items[index], incoming)
      items[index] = merged
      changed = true
      continue
    }
    items.push(incoming)
    changed = true
  }
  if (!changed) return items
  // 新条目在数组末尾，从头部丢掉就是丢掉最早写入的。
  while (items.length > MAX_ITEMS_PER_TAB) items.shift()
  await writeItems(tabId, items)
  await setBadge(tabId, items.length)
  return items.map(cloneItem)
}

async function clearItemsUnlocked(tabId: number): Promise<void> {
  await chrome.storage.session.remove(storageKey(tabId))
  await setBadge(tabId, 0)
}

/**
 * 写入一条媒体。url 会先规范化；黑名单、空地址、判断不出种类的地址会被忽略。
 * 返回这个 tab 当前的完整列表（已去重）。
 */
export function addMedia(tabId: number, item: MediaItemDraft): Promise<MediaItem[]> {
  return addItems(tabId, [item])
}

/** 按顺序写入多条。同一批里重复的 URL 会合并，不会占两条名额。 */
export function addItems(tabId: number, items: readonly MediaItemDraft[]): Promise<MediaItem[]> {
  if (!isValidTabId(tabId)) return Promise.resolve([])
  return enqueue(tabId, () => addItemsUnlocked(tabId, items))
}

/** 读取这个 tab 的列表。没有记录时返回空数组。返回值是副本，改它不会写回存储。 */
export function getItems(tabId: number): Promise<MediaItem[]> {
  if (!isValidTabId(tabId)) return Promise.resolve([])
  return enqueue(tabId, async () => (await readItems(tabId)).map(cloneItem))
}

/** 删掉这个 tab 的列表并清掉角标。页面还在，所以不改导航记忆。 */
export function clearTab(tabId: number): Promise<void> {
  if (!isValidTabId(tabId)) return Promise.resolve()
  return enqueue(tabId, () => clearItemsUnlocked(tabId))
}

/**
 * 给已经存在的条目补 size，没有这条 URL 时不新建。
 * 已有 size（包括 0）则不覆盖。给 206 / Range 用：分片响应不能变成一条新记录。
 * 返回是否真的写进了大小。
 */
export function fillMediaSize(tabId: number, url: string, size: number): Promise<boolean> {
  if (!isValidTabId(tabId)) return Promise.resolve(false)
  const normalized = typeof url === 'string' ? normalizeUrl(url) : ''
  const nextSize = cleanSize(size)
  // 黑名单和新增走同一条规则：被屏蔽的主机连大小也不补。
  if (!normalized || nextSize === undefined || isBlocked(url) || isBlocked(normalized)) {
    return Promise.resolve(false)
  }
  return enqueue(tabId, async () => {
    const items = await readItems(tabId)
    const index = items.findIndex((item) => item.url === normalized)
    if (index < 0 || items[index].size !== undefined) return false
    items[index] = buildItem({ ...items[index], size: nextSize })
    await writeItems(tabId, items)
    return true
  })
}

function rememberNavigation(tabId: number, state: NavigationState): void {
  navigation.set(tabId, state)
}

/**
 * 顶层导航和刷新会把 tab.status 设为 loading，这时清掉旧列表。
 * 若这次导航的 main_frame 请求已经清过，后面的 loading 只更新记忆，不再清空。
 * SPA 的 pushState 只会带上新 url，status 不是 loading，列表保留。
 * 同一轮 loading 里重复的通知不再清第二次，避免把这次导航刚收来的条目抹掉。
 */
async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
): Promise<void> {
  if (changeInfo.status === 'complete') {
    topLevelRequests.delete(tabId)
    rememberNavigation(tabId, {
      loading: false,
      url: changeInfo.url ?? tab.url ?? navigation.get(tabId)?.url,
    })
    return
  }

  if (changeInfo.status === 'loading') {
    const nextUrl = changeInfo.url ?? tab.pendingUrl ?? tab.url
    if (topLevelRequests.has(tabId)) {
      rememberNavigation(tabId, { loading: true, url: nextUrl ?? navigation.get(tabId)?.url })
      return
    }
    const current = navigation.get(tabId)
    const sameLoad =
      current?.loading === true &&
      (nextUrl === undefined || current.url === undefined || nextUrl === current.url)
    if (!sameLoad) await clearItemsUnlocked(tabId)
    rememberNavigation(tabId, { loading: true, url: nextUrl ?? current?.url })
    return
  }

  if (changeInfo.url !== undefined) {
    const current = navigation.get(tabId)
    rememberNavigation(tabId, { loading: current?.loading ?? false, url: changeInfo.url })
  }
}

/** 顶层文档请求一发出就清空。此时新页面的媒体请求还没开始，不会误删刚抓到的条目。 */
function onBeforeRequest(details: chrome.webRequest.OnBeforeRequestDetails): undefined {
  if (details.type !== 'main_frame' || !isValidTabId(details.tabId)) return undefined
  topLevelRequests.add(details.tabId)
  void enqueue(details.tabId, () => clearItemsUnlocked(details.tabId)).catch((error: unknown) =>
    warn('顶层导航时清理失败', error),
  )
  return undefined
}

function onTabRemoved(tabId: number): void {
  navigation.delete(tabId)
  topLevelRequests.delete(tabId)
  void clearTab(tabId).catch((error: unknown) => warn('关闭标签页时清理失败', error))
}

function onTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
): void {
  if (!isValidTabId(tabId)) return
  void enqueue(tabId, () => handleTabUpdated(tabId, changeInfo, tab)).catch((error: unknown) =>
    warn('导航时清理失败', error),
  )
}

function onRuntimeMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (isGetMediaMessage(message)) {
    void getItems(message.tabId).then(sendResponse, (error: unknown) => {
      warn('读取媒体失败', error)
      sendResponse([])
    })
    return true
  }
  if (isClearMediaMessage(message)) {
    void clearTab(message.tabId).then(
      () => sendResponse(),
      (error: unknown) => {
        warn('清空媒体失败', error)
        sendResponse()
      },
    )
    return true
  }
  if (isMediaFoundMessage(message)) {
    // 回复一下，避免 content script 那边出现 “message port closed”。
    const tabId = sender.tab?.id
    if (tabId === undefined || !isValidTabId(tabId)) {
      sendResponse()
      return true
    }
    void addItems(tabId, message.items).then(
      () => sendResponse(),
      (error: unknown) => {
        warn('保存媒体失败', error)
        sendResponse()
      },
    )
    return true
  }
  return undefined
}

/** service worker 刚起来时角标是空的，按 session 里的列表把每个 tab 的数字补回去。 */
async function restoreBadges(): Promise<void> {
  let all: Record<string, unknown>
  try {
    all = (await chrome.storage.session.get(null)) as Record<string, unknown>
  } catch (error) {
    warn('恢复角标失败', error)
    return
  }
  const tasks: Promise<unknown>[] = []
  for (const key of Object.keys(all)) {
    if (!key.startsWith(STORAGE_PREFIX)) continue
    const tabId = Number(key.slice(STORAGE_PREFIX.length))
    if (!isValidTabId(tabId)) continue
    tasks.push(
      enqueue(tabId, async () => {
        const items = await readItems(tabId)
        await setBadge(tabId, items.length)
      }).catch((error: unknown) => warn('恢复角标失败', error)),
    )
  }
  await Promise.all(tasks)
}

/**
 * 注册标签页清理和消息监听。重复调用不会叠两层监听。
 * background/index.ts 只需要调用这一次。
 */
export function initStore(): void {
  if (listening) return
  listening = true
  chrome.tabs.onRemoved.addListener(onTabRemoved)
  chrome.tabs.onUpdated.addListener(onTabUpdated)
  // 不申请 webNavigation。webRequest 已有权限，main_frame 比 tabs.onUpdated 的 loading 更早。
  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, {
    urls: ['<all_urls>'],
    types: ['main_frame'],
  })
  chrome.runtime.onMessage.addListener(onRuntimeMessage)
  void restoreBadges()
}
