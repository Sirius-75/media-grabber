/**
 * 媒体条目的类型。字段含义见 PLAN.md 第 5 节。
 * 分类规则在 classify.ts，消息协议在 messages.ts。
 */

/** 能识别的媒体种类。 */
export const MEDIA_KINDS = ['video', 'audio', 'hls', 'dash'] as const

/** 媒体种类：普通视频、音频、HLS 清单、DASH 清单。 */
export type MediaKind = (typeof MEDIA_KINDS)[number]

/** 资源来源。 */
export const MEDIA_SOURCES = ['dom', 'network'] as const

/** 资源来自 DOM 扫描，还是来自网络请求。 */
export type MediaSource = (typeof MEDIA_SOURCES)[number]

/** 一条可展示的媒体资源。规范化后的 url 作为去重键。 */
export interface MediaItem {
  /** 去掉 hash 后的 URL，同一 tab 内用它去重。 */
  url: string
  kind: MediaKind
  /** 不带点的扩展名：mp4 / webm / mp3 / m4a / m3u8 / mpd。 */
  ext?: string
  /** 小写、去掉参数后的 MIME。 */
  mime?: string
  /** 字节数，来自 Content-Length。拿不到就不填。 */
  size?: number
  sources: MediaSource[]
  /** blob、data、HLS、DASH 为 false。 */
  downloadable: boolean
  /** 例如「blob 地址，无法直接下载」。 */
  note?: string
  frameUrl?: string
  firstSeen: number
}

/**
 * 上报或合并前的不完整条目。
 * 方案写的是 Partial<MediaItem>，但没有 url 就无法去重，所以这里把 url 定为必填。
 */
export type MediaItemDraft = Partial<Omit<MediaItem, 'url'>> & { url: string }
