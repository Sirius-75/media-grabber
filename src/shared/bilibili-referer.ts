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
  if (hosts.length > BILIBILI_RULE_ID_MAX - BILIBILI_RULE_ID_MIN + 1) {
    return { ok: false, error: BILIBILI_TEXT.tooManyRules }
  }
  const rules: BilibiliRefererRule[] = hosts.map((host, index) => ({
    id: BILIBILI_RULE_ID_MIN + index,
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

type Phase = 'idle' | 'arming' | 'live'

/**
 * 一次 B 站下载占用的规则。
 * 先加规则再跑 download；成功、失败、取消，以及 offscreen 不再跑这条任务时，都会删掉。
 */
export function createRefererSession(client: RefererRuleClient) {
  let phase: Phase = 'idle'
  let jobKey: string | undefined
  let waiter: { jobKey: string; resolve: (result: RefererDownloadResult) => void } | undefined

  function finish(key: string, result: RefererDownloadResult): boolean {
    if (waiter?.jobKey !== key) return false
    const current = waiter
    waiter = undefined
    current.resolve(result)
    return true
  }

  return {
    /** download 里面用 wait 等到 offscreen 做完。finish 或下面的中断会解开这个等待。 */
    wait(key: string): Promise<RefererDownloadResult> {
      return new Promise((resolve) => {
        waiter = { jobKey: key, resolve }
      })
    },
    finish,
    /**
     * offscreen 汇报的当前任务。
     * 规则已经加上、但当前任务不是这一条时，当成后台页挂了，结束等待并由 finally 删规则。
     * 还在加规则时不打断，避免刚开始就被一次同步清掉。
     */
    onOffscreenActiveKey(activeKey: string | undefined): void {
      if (phase !== 'live' || !jobKey) return
      if (activeKey === jobKey) return
      finish(jobKey, { ok: false, error: HLS_TEXT.interrupted })
    },
    async clearLeftovers(): Promise<number[]> {
      return clearOwnedRefererRules(client)
    },
    async run(
      input: { pageUrl: string; mediaUrls: readonly string[]; jobKey: string },
      download: () => Promise<RefererDownloadResult>,
    ): Promise<RefererDownloadResult> {
      if (phase !== 'idle') return { ok: false, error: HLS_TEXT.busy }
      const built = buildRefererRules(input)
      if (!built.ok) return built
      phase = 'arming'
      jobKey = input.jobKey
      let added = false
      try {
        try {
          await applyRules(client, { removeRuleIds: built.ids, addRules: built.rules })
          added = true
        } catch {
          return { ok: false, error: BILIBILI_TEXT.refererFailed }
        }
        phase = 'live'
        return await download()
      } catch (error) {
        const message = error instanceof Error && error.message.trim() ? error.message.trim() : HLS_TEXT.internal
        return { ok: false, error: message }
      } finally {
        const key = jobKey
        phase = 'idle'
        jobKey = undefined
        if (key && waiter?.jobKey === key) finish(key, { ok: false, error: HLS_TEXT.interrupted })
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
