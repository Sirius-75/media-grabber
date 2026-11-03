/**
 * B 站下载专用的 Referer 会话规则。
 * 只描述规则和生命周期，不调用 chrome。真正的 updateSessionRules 在 service worker。
 *
 * offscreen 页面里的 fetch 是扩展自己发出的请求，不会带上网页的 Referer。
 * B 站 CDN 没有 Referer 会回 403。这里只给「正在下载的那一个主机」补上页面源站。
 *
 * resourceTypes 只用 xmlhttprequest：
 * offscreen 是扩展页面，不是标签页。页面里的 fetch() 在 Chromium 里按
 * RequestDestination 为空的子资源处理，webRequest / declarativeNetRequest
 * 把它记成 xmlhttprequest，不是 media（那是 video/audio 元素自己拉的），也不是 other。
 * 下载放在 offscreen 里，所以规则按这个类型匹配。
 *
 * tabIds 只用 -1，也就是 chrome.tabs.TAB_ID_NONE：
 * 只匹配不从标签页发出的请求。用户正常打开 B 站页面时的请求不在此列。
 *
 * requestDomains 只放媒体 URL 的主机名本身。Chrome 还会匹配这个主机的子域，
 * 所以不能填 bilivideo.com 这种父域，否则会波及其它 CDN 主机。
 *
 * 规则按主机匹配，不按某一次 URL。大文件的多条 Range 请求打到同一主机时，
 * 都会命中这一条已经加上的规则，不需要为并发再加规则或权限。
 */

import { BILIBILI_TEXT } from './bilibili'
import { HLS_TEXT } from './hls'

/** 本扩展自己的会话规则号。只删除这个闭区间，不动区间外的规则。 */
export const BILIBILI_RULE_ID_MIN = 910_001
export const BILIBILI_RULE_ID_MAX = 910_032

export interface BilibiliRefererRule {
  id: number
  priority: 1
  action: {
    type: 'modifyHeaders'
    requestHeaders: [{ header: 'Referer'; operation: 'set'; value: string }]
  }
  condition: {
    requestDomains: [string]
    tabIds: [-1]
    resourceTypes: ['xmlhttprequest']
  }
}

export interface RefererRuleClient {
  getSessionRules(): Promise<ReadonlyArray<{ id: number }>>
  updateSessionRules(update: { removeRuleIds?: number[]; addRules?: BilibiliRefererRule[] }): Promise<void>
}

export interface RefererDownloadResult {
  ok: boolean
  error?: string
  cancelled?: boolean
}

export function isOwnedRefererRuleId(id: number): boolean {
  return Number.isInteger(id) && id >= BILIBILI_RULE_ID_MIN && id <= BILIBILI_RULE_ID_MAX
}

/** 页面源站加斜杠。只接受 http / https，不写死某个站点。 */
export function refererForPage(pageUrl: string): string | undefined {
  if (typeof pageUrl !== 'string' || pageUrl.trim() === '') return undefined
  try {
    const url = new URL(pageUrl.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.origin}/`
  } catch {
    return undefined
  }
}

function mediaHost(mediaUrl: string): string | undefined {
  if (typeof mediaUrl !== 'string' || mediaUrl.trim() === '') return undefined
  let url: URL
  try {
    url = new URL(mediaUrl.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  // requestDomains 不接受 IP、端口和空主机。只留域名。
  if (!host || host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined
  if (![...host].every((char) => char.charCodeAt(0) < 128)) return undefined
  return host
}

export function buildRefererRules(input: {
  pageUrl: string
  mediaUrls: readonly string[]
  /** 两条 B 站下载并行时，各用一段规则号。缺省从最小号开始。 */
  idStart?: number
  /** 这一段最多能放几条规则。 */
  maxRules?: number
}): { ok: true; rules: BilibiliRefererRule[]; ids: number[] } | { ok: false; error: string } {
  const referer = refererForPage(input.pageUrl)
  if (!referer) return { ok: false, error: BILIBILI_TEXT.badPage }
  const hosts: string[] = []
  for (const mediaUrl of input.mediaUrls) {
    const host = mediaHost(mediaUrl)
    if (!host) {
      let parsed: URL | undefined
      try {
        parsed = new URL(mediaUrl)
      } catch {
        parsed = undefined
      }
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        return { ok: false, error: BILIBILI_TEXT.badMedia }
      }
      return { ok: false, error: BILIBILI_TEXT.badHost }
    }
    if (!hosts.includes(host)) hosts.push(host)
  }
  if (hosts.length === 0) return { ok: false, error: BILIBILI_TEXT.badMedia }
  const idStart = input.idStart ?? BILIBILI_RULE_ID_MIN
  const maxRules = input.maxRules ?? BILIBILI_RULE_ID_MAX - BILIBILI_RULE_ID_MIN + 1
  if (hosts.length > maxRules) {
    return { ok: false, error: BILIBILI_TEXT.tooManyRules }
  }
  if (idStart < BILIBILI_RULE_ID_MIN || idStart + hosts.length - 1 > BILIBILI_RULE_ID_MAX) {
    return { ok: false, error: BILIBILI_TEXT.tooManyRules }
  }
  const rules: BilibiliRefererRule[] = hosts.map((host, index) => ({
    id: idStart + index,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }],
    },
    condition: {
      requestDomains: [host],
      tabIds: [-1],
      resourceTypes: ['xmlhttprequest'],
    },
  }))
  return { ok: true, rules, ids: rules.map((rule) => rule.id) }
}

async function applyRules(
  client: RefererRuleClient,
  update: { removeRuleIds?: number[]; addRules?: BilibiliRefererRule[] },
): Promise<void> {
  if (!update.removeRuleIds?.length && !update.addRules?.length) return
  const payload: { removeRuleIds?: number[]; addRules?: BilibiliRefererRule[] } = {}
  if (update.removeRuleIds?.length) payload.removeRuleIds = update.removeRuleIds
  if (update.addRules?.length) payload.addRules = update.addRules
  await client.updateSessionRules(payload)
}

/** 启动时清掉上次没删干净的规则。区间外的 id 留着。 */
export async function clearOwnedRefererRules(client: RefererRuleClient): Promise<number[]> {
  const existing = await client.getSessionRules()
  const ids = existing.map((rule) => rule.id).filter(isOwnedRefererRuleId)
  if (ids.length === 0) return []
  await applyRules(client, { removeRuleIds: ids })
  return ids
}

type Phase = 'arming' | 'live'

interface ActiveRefererJob {
  phase: Phase
  slot: number
  ids: number[]
  waiter?: { resolve: (result: RefererDownloadResult) => void }
}

/** 最多两条 B 站下载并行。32 个规则号分成两段，每段 16 个。 */
const MAX_REFERER_JOBS = 2
const RULES_PER_JOB = 16

/**
 * 一次 B 站下载占用的规则。
 * 先加规则再跑 download；成功、失败、取消，以及 offscreen 不再跑这条任务时，都会删掉。
 * 默认仍然一次只跑一条；下载队列传入 allowConcurrent 后最多两条并行。
 */
export function createRefererSession(client: RefererRuleClient) {
  const jobs = new Map<string, ActiveRefererJob>()
  const usedSlots = new Set<number>()

  function finish(key: string, result: RefererDownloadResult): boolean {
    const job = jobs.get(key)
    if (!job?.waiter) return false
    const current = job.waiter
    job.waiter = undefined
    current.resolve(result)
    return true
  }

  function firstFreeSlot(): number | undefined {
    for (let slot = 0; slot < MAX_REFERER_JOBS; slot += 1) {
      if (!usedSlots.has(slot)) return slot
    }
    return undefined
  }

  function markInterrupted(activeKeys: ReadonlySet<string>): void {
    for (const [key, job] of jobs) {
      // 还在加规则时不打断，避免刚开始就被一次同步清掉。
      if (job.phase !== 'live') continue
      if (activeKeys.has(key)) continue
      finish(key, { ok: false, error: HLS_TEXT.interrupted })
    }
  }

  return {
    /** download 里面用 wait 等到 offscreen 做完。finish 或下面的中断会解开这个等待。 */
    wait(key: string): Promise<RefererDownloadResult> {
      return new Promise((resolve) => {
        const job = jobs.get(key)
        if (job) job.waiter = { resolve }
        else resolve({ ok: false, error: HLS_TEXT.interrupted })
      })
    },
    finish,
    /**
     * offscreen 汇报的当前任务。
     * 规则已经加上、但当前任务不在里面时，当成后台页挂了，结束等待并由 finally 删规则。
     */
    onOffscreenActiveKeys(activeKeys: readonly string[] | undefined): void {
      markInterrupted(new Set(activeKeys ?? []))
    },
    /** 兼容只传一条的旧调用。 */
    onOffscreenActiveKey(activeKey: string | undefined): void {
      markInterrupted(new Set(activeKey ? [activeKey] : []))
    },
    async clearLeftovers(): Promise<number[]> {
      return clearOwnedRefererRules(client)
    },
    async run(
      input: { pageUrl: string; mediaUrls: readonly string[]; jobKey: string },
      download: () => Promise<RefererDownloadResult>,
      options: { allowConcurrent?: boolean } = {},
    ): Promise<RefererDownloadResult> {
      if (jobs.has(input.jobKey)) return { ok: false, error: HLS_TEXT.busy }
      if (!options.allowConcurrent && jobs.size > 0) return { ok: false, error: HLS_TEXT.busy }
      if (jobs.size >= MAX_REFERER_JOBS) return { ok: false, error: HLS_TEXT.busy }
      const slot = firstFreeSlot()
      if (slot === undefined) return { ok: false, error: HLS_TEXT.busy }
      const built = buildRefererRules({
        ...input,
        idStart: BILIBILI_RULE_ID_MIN + slot * RULES_PER_JOB,
        maxRules: RULES_PER_JOB,
      })
      if (!built.ok) return built
      usedSlots.add(slot)
      const job: ActiveRefererJob = { phase: 'arming', slot, ids: built.ids }
      jobs.set(input.jobKey, job)
      let added = false
      try {
        try {
          await applyRules(client, { removeRuleIds: built.ids, addRules: built.rules })
          added = true
        } catch {
          return { ok: false, error: BILIBILI_TEXT.refererFailed }
        }
        job.phase = 'live'
        return await download()
      } catch (error) {
        const message = error instanceof Error && error.message.trim() ? error.message.trim() : HLS_TEXT.internal
        return { ok: false, error: message }
      } finally {
        const key = input.jobKey
        jobs.delete(key)
        usedSlots.delete(job.slot)
        if (added) {
          try {
            await applyRules(client, { removeRuleIds: built.ids })
          } catch {
            // 删不掉就留到下次启动时按 id 区间清理。
          }
        }
      }
    },
  }
}
