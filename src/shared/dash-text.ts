/**
 * DASH 给用户看的中文。不解析 XML，service worker 也可以引用。
 */

export const DASH_NOTE = 'DASH 清单，可下载未加密的点播'

export const DASH_TEXT = {
  notManifest: '这不是有效的 DASH 清单',
  badUrl: '只支持 http 或 https 清单',
  live: '这是直播流（MPD type=dynamic），暂不支持下载',
  multiPeriod: '清单包含多个 Period，暂不支持复杂时间线',
  protected: '清单使用了加密（ContentProtection），不支持加密或 DRM 内容',
  segmentBase: '暂不支持 SegmentBase（需要按字节范围请求，扩展不设置自定义请求头）',
  noMedia: '没有可下载的 mp4 音视频',
  unsupportedTemplate: '清单使用了不支持的分片地址模板',
  noInit: '缺少初始化段，无法拼成可播放文件',
  unknownCount: '无法确定分片数量，可能是直播或不完整清单',
  tooMany: '分片过多，为避免占满内存已拒绝下载',
  badSegmentUrl: '清单里有不是 http 或 https 的分片地址',
  missingId: '有一条 Representation 缺少 id',
  variantMissing: '清晰度不在这个清单里',
  picking: '请选择清晰度',
  separatePlan: '视频和音频是分开的，默认合并成一个 mp4。勾选「分开保存视频和音频」则各存一份',
  separateChosenPlan: '视频和音频是分开的，将按你的选择保存成两个文件',
  audioChoice: '有多条音轨，已选带宽最高的一条',
  audioMain: '有多条音轨，已选主音轨里带宽最高的一条',
  directBlock: 'DASH 清单不能当直链保存，请用列表里的下载',
  saveFailed: '保存文件失败',
  audioSaveFailed: '视频已保存，音频保存失败',
} as const
