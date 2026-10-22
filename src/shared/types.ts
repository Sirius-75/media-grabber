/**
 * 媒体条目的类型声明，字段含义见 PLAN.md 第 5 节。
 * 这里只有类型，没有分类、去重或存储逻辑。
 */

/** 媒体种类：普通视频、音频、HLS 清单、DASH 清单。 */
export type MediaKind = 'video' | 'audio' | 'hls' | 'dash'

/** 资源来自 DOM 扫描，还是来自网络请求。 */
export type MediaSource = 'dom' | 'network'

/** 一条可展示的媒体资源。规范化后的 url 作为去重键。 */
export interface MediaItem {
  url: string
  kind: MediaKind
  ext?: string
  mime?: string
  size?: number
  sources: MediaSource[]
  downloadable: boolean
  note?: string
  frameUrl?: string
  firstSeen: number
}
