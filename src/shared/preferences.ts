/**
 * 弹窗里需要记住的开关。
 * 读写放在 chrome.storage.local，关掉浏览器也还在。这里只做校验，不访问浏览器 API。
 */

export const PREFERENCES_STORAGE_KEY = 'media-grabber-preferences'

export interface GrabberPreferences {
  /**
   * 直播录制时，把点击那一刻清单窗口里已经列出的分片也写入文件。
   * 默认 false：从直播边缘开始，只保留窗口里最新的一片。
   */
  includeExistingLiveSegments: boolean
}

export const DEFAULT_PREFERENCES: GrabberPreferences = {
  includeExistingLiveSegments: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 存储损坏或还没写过时，回到默认：从点击时的直播边缘开始录。 */
export function readPreferences(value: unknown): GrabberPreferences {
  if (!isRecord(value)) return { ...DEFAULT_PREFERENCES }
  return {
    includeExistingLiveSegments: value.includeExistingLiveSegments === true,
  }
}
