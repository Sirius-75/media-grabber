/**
 * 示例数据。页面和媒体地址都是造的，用来检查规则形状和删除时机。
 */
import { describe, expect, it } from 'vitest'
import { BILIBILI_TEXT } from '../src/shared/bilibili'
import {
  BILIBILI_RULE_ID_MAX,
  BILIBILI_RULE_ID_MIN,
  buildRefererRules,
  clearOwnedRefererRules,
  createRefererSession,
  refererForPage,
  type BilibiliRefererRule,
  type RefererRuleClient,
} from '../src/shared/bilibili-referer'
import { HLS_TEXT } from '../src/shared/hls'

const PAGE = 'https://www.example.test/watch/sample?p=2#t=3'
const VIDEO = 'https://upos-example.bilivideo.com/example-data/video.m4s?token=sample'
const AUDIO = 'https://upos-example.bilivideo.com/example-data/audio.m4s?token=sample'
const OTHER = 'https://mirror-example.bilivideo.cn/example-data/audio.m4s'

interface StoredRule {
  id: number
}

function memoryClient(seed: StoredRule[] = []): {
  client: RefererRuleClient
  rules: () => StoredRule[]
  calls: () => Array<{ removeRuleIds?: number[]; addRules?: BilibiliRefererRule[] }>
  failNextAdd: () => void
} {
  let rules = seed.map((rule) => ({ ...rule }))
  const calls: Array<{ removeRuleIds?: number[]; addRules?: BilibiliRefererRule[] }> = []
  let failAdd = false
  return {
    rules: () => rules.map((rule) => ({ ...rule })),
    calls: () => calls,
    failNextAdd: () => {
      failAdd = true
    },
    client: {
      async getSessionRules() {
        return rules.map((rule) => ({ id: rule.id }))
      },
      async updateSessionRules(update) {
        calls.push(update)
        if (update.addRules?.length && failAdd) {
          failAdd = false
          throw new Error('updateSessionRules 失败')
        }
        if (update.removeRuleIds?.length) {
          const drop = new Set(update.removeRuleIds)
          rules = rules.filter((rule) => !drop.has(rule.id))
        }
        if (update.addRules?.length) rules = [...rules, ...update.addRules.map((rule) => ({ id: rule.id }))]
      },
    },
  }
}

describe('Referer 规则构造（示例数据）', () => {
  it('每个正在下载的主机一条规则，只设 Referer，tabIds 只有 -1', () => {
    const built = buildRefererRules({ pageUrl: PAGE, mediaUrls: [VIDEO, AUDIO, OTHER] })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.rules).toHaveLength(2)
    expect(built.ids).toEqual([BILIBILI_RULE_ID_MIN, BILIBILI_RULE_ID_MIN + 1])
    for (const rule of built.rules) {
      expect(rule.priority).toBe(1)
      expect(rule.action).toEqual({
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://www.example.test/' }],
      })
      expect(rule.action.requestHeaders).toHaveLength(1)
      expect(rule).not.toHaveProperty('responseHeaders')
      expect(rule.condition.tabIds).toEqual([-1])
      expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest'])
      expect(rule.condition.requestDomains).toHaveLength(1)
    }
    expect(built.rules.map((rule) => rule.condition.requestDomains[0])).toEqual([
      'upos-example.bilivideo.com',
      'mirror-example.bilivideo.cn',
    ])
    expect(JSON.stringify(built.rules)).not.toMatch(/Cookie|User-Agent|Origin/i)
  })

  it('Referer 用页面 origin 加斜杠，不写死站点', () => {
    expect(refererForPage('http://player.example.test/a/b?x=1')).toBe('http://player.example.test/')
    expect(refererForPage(' https://www.example.test/watch/sample ')).toBe('https://www.example.test/')
  })

  it('非 http 页面、坏媒体地址、IP 主机都拒绝，并且不产生规则', () => {
    expect(buildRefererRules({ pageUrl: 'file:///tmp/sample.html', mediaUrls: [VIDEO] })).toEqual({
      ok: false,
      error: BILIBILI_TEXT.badPage,
    })
    expect(buildRefererRules({ pageUrl: 'chrome-extension://abcdefghijklmnop/popup.html', mediaUrls: [VIDEO] })).toEqual({
      ok: false,
      error: BILIBILI_TEXT.badPage,
    })
    expect(buildRefererRules({ pageUrl: PAGE, mediaUrls: ['ftp://cdn.example.test/a.m4s'] })).toEqual({
      ok: false,
      error: BILIBILI_TEXT.badMedia,
    })
    expect(buildRefererRules({ pageUrl: PAGE, mediaUrls: ['http://192.0.2.10/example-data/a.m4s'] })).toEqual({
      ok: false,
      error: BILIBILI_TEXT.badHost,
    })
    expect(buildRefererRules({ pageUrl: PAGE, mediaUrls: [] })).toEqual({
      ok: false,
      error: BILIBILI_TEXT.badMedia,
    })
  })

  it('同一主机只占一个规则号', () => {
    const built = buildRefererRules({
      pageUrl: PAGE,
      mediaUrls: [VIDEO, `${VIDEO}&range=0-1`, AUDIO],
    })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.rules).toHaveLength(1)
  })
})

describe('Referer 规则生命周期（示例数据）', () => {
  const input = { pageUrl: PAGE, mediaUrls: [VIDEO], jobKey: VIDEO }

  it('成功、失败、取消都会删掉刚加的规则', async () => {
    for (const result of [
      { ok: true },
      { ok: false, error: '下载失败（500）' },
      { ok: false, cancelled: true, error: HLS_TEXT.cancelled },
    ] as const) {
      const store = memoryClient()
      const session = createRefererSession(store.client)
      await expect(session.run(input, async () => result)).resolves.toEqual(result)
      expect(store.rules()).toEqual([])
      expect(store.calls().some((call) => call.addRules?.length)).toBe(true)
      expect(store.calls().at(-1)?.removeRuleIds).toEqual([BILIBILI_RULE_ID_MIN])
    }
  })

  it('下载函数抛错时也删除规则', async () => {
    const store = memoryClient()
    const session = createRefererSession(store.client)
    await expect(
      session.run(input, async () => {
        throw new Error('后台页报错')
      }),
    ).resolves.toEqual({ ok: false, error: '后台页报错' })
    expect(store.rules()).toEqual([])
  })

  it('启动时只清自己区间里的残留规则', async () => {
    const store = memoryClient([{ id: BILIBILI_RULE_ID_MIN }, { id: BILIBILI_RULE_ID_MAX }, { id: 42 }, { id: 910_000 }])
    const removed = await clearOwnedRefererRules(store.client)
    expect(removed.sort((a, b) => a - b)).toEqual([BILIBILI_RULE_ID_MIN, BILIBILI_RULE_ID_MAX])
    expect(store.rules().map((rule) => rule.id).sort((a, b) => a - b)).toEqual([42, 910_000])
    const session = createRefererSession(store.client)
    await expect(session.clearLeftovers()).resolves.toEqual([])
  })

  it('offscreen 不再跑这条任务时结束等待并删规则', async () => {
    const store = memoryClient()
    const session = createRefererSession(store.client)
    const result = session.run(input, () => {
      const pending = session.wait(input.jobKey)
      session.onOffscreenActiveKey('https://cdn.example.test/example-data/other.m4s')
      return pending
    })
    await expect(result).resolves.toEqual({ ok: false, error: HLS_TEXT.interrupted })
    expect(store.rules()).toEqual([])
  })

  it('规则还没加上时，offscreen 的空闲汇报不打断这次下载', async () => {
    let release: (() => void) | undefined
    let held = false
    const calls: string[] = []
    const client: RefererRuleClient = {
      async getSessionRules() {
        return []
      },
      async updateSessionRules() {
        calls.push('update')
        if (held) return
        held = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
    }
    const session = createRefererSession(client)
    let downloaded = false
    const pending = session.run(input, async () => {
      downloaded = true
      return { ok: true }
    })
    await Promise.resolve()
    session.onOffscreenActiveKey(undefined)
    release?.()
    await expect(pending).resolves.toEqual({ ok: true })
    expect(downloaded).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('已有下载时不再加第二套规则', async () => {
    const store = memoryClient()
    const session = createRefererSession(store.client)
    let release: ((value: { ok: true }) => void) | undefined
    const first = session.run(input, () => new Promise((resolve) => {
      release = resolve
    }))
    await Promise.resolve()
    await expect(
      session.run(
        { ...input, jobKey: AUDIO, mediaUrls: [AUDIO] },
        async () => ({ ok: true }),
      ),
    ).resolves.toEqual({ ok: false, error: HLS_TEXT.busy })
    expect(store.calls().filter((call) => call.addRules?.length)).toHaveLength(1)
    release?.({ ok: true })
    await expect(first).resolves.toEqual({ ok: true })
    expect(store.rules()).toEqual([])
  })
})

describe('下载流程先加规则（示例数据）', () => {
  const input = { pageUrl: PAGE, mediaUrls: [VIDEO, AUDIO], jobKey: VIDEO }

  it('规则先加上，下载函数里已经能看到这些规则', async () => {
    const store = memoryClient()
    const order: string[] = []
    const client: RefererRuleClient = {
      async getSessionRules() {
        return store.client.getSessionRules()
      },
      async updateSessionRules(update) {
        order.push(update.addRules?.length ? 'add' : 'remove')
        await store.client.updateSessionRules(update)
      },
    }
    const session = createRefererSession(client)
    const result = await session.run(input, async () => {
      order.push('download')
      expect(store.rules().map((rule) => rule.id)).toEqual([BILIBILI_RULE_ID_MIN])
      return { ok: true }
    })
    expect(result).toEqual({ ok: true })
    expect(order).toEqual(['add', 'download', 'remove'])
    expect(store.rules()).toEqual([])
  })

  it('规则没加成功就不开始下载', async () => {
    const store = memoryClient()
    store.failNextAdd()
    const session = createRefererSession(store.client)
    let started = false
    const result = await session.run(input, async () => {
      started = true
      return { ok: true }
    })
    expect(started).toBe(false)
    expect(result).toEqual({ ok: false, error: BILIBILI_TEXT.refererFailed })
    expect(store.rules()).toEqual([])
    expect(store.calls().some((call) => call.removeRuleIds?.length && !call.addRules?.length)).toBe(false)
  })
})
