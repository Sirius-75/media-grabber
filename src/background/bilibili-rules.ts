/**
 * 只在 service worker 里改 Referer。
 * offscreen 页面没有 declarativeNetRequest，也不能在 fetch 上自己加这个头。
 * 规则的形状和删除时机在 shared/bilibili-referer.ts。
 */

import { createRefererSession, type RefererDownloadResult, type RefererRuleClient } from '../shared/bilibili-referer'

function client(): RefererRuleClient {
  // 单测导入本文件时可能还没有 chrome。缺了这个 API 就先空转，真正的浏览器里再调用。
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.declarativeNetRequest
  if (!api?.getSessionRules || !api.updateSessionRules) {
    return {
      async getSessionRules() {
        return []
      },
      async updateSessionRules() {
        return undefined
      },
    }
  }
  return {
    getSessionRules: () => api.getSessionRules(),
    updateSessionRules: (update) =>
      api.updateSessionRules({
        removeRuleIds: update.removeRuleIds,
        addRules: update.addRules as chrome.declarativeNetRequest.Rule[] | undefined,
      }),
  }
}

const session = createRefererSession(client())

export function waitForBilibiliDownload(jobKey: string): Promise<RefererDownloadResult> {
  return session.wait(jobKey)
}

export function finishBilibiliDownload(jobKey: string, result: RefererDownloadResult): void {
  session.finish(jobKey, result)
}

/** 同步任务时调用。offscreen 已经不在下这一条，就把规则清掉。 */
export function noteBilibiliOffscreen(activeKey: string | undefined): void {
  session.onOffscreenActiveKey(activeKey)
}

export function clearBilibiliRefererOnStartup(): Promise<number[]> {
  return session.clearLeftovers().catch((error: unknown) => {
    console.warn('[media-grabber] 清理残留 Referer 规则失败', error)
    return []
  })
}

export function runBilibiliWithReferer(
  input: { pageUrl: string; mediaUrls: readonly string[]; jobKey: string },
  download: () => Promise<RefererDownloadResult>,
): Promise<RefererDownloadResult> {
  return session.run(input, download)
}
