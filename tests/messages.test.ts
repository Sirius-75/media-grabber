import { describe, expect, it } from 'vitest'
import {
  MESSAGE_TYPE,
  isClearMediaMessage,
  isDownloadMessage,
  isExtensionMessage,
  isGetMediaMessage,
  isBilibiliCancelMessage,
  isBilibiliDownloadMessage,
  isBilibiliSyncMessage,
  isDashCancelMessage,
  isDashDownloadMessage,
  isDashInspectMessage,
  isDashSyncMessage,
  isHlsCancelMessage,
  isHlsDownloadMessage,
  isHlsInspectMessage,
  isHlsSyncMessage,
  isMediaFoundMessage,
} from '../src/shared/messages'

describe('消息常量', () => {
  it('与方案里的协议名一致', () => {
    expect(MESSAGE_TYPE).toEqual({
      MEDIA_FOUND: 'MEDIA_FOUND',
      GET_MEDIA: 'GET_MEDIA',
      CLEAR_MEDIA: 'CLEAR_MEDIA',
      DOWNLOAD: 'DOWNLOAD',
      HLS_INSPECT: 'HLS_INSPECT',
      HLS_DOWNLOAD: 'HLS_DOWNLOAD',
      HLS_CANCEL: 'HLS_CANCEL',
      HLS_SYNC: 'HLS_SYNC',
      DASH_INSPECT: 'DASH_INSPECT',
      DASH_DOWNLOAD: 'DASH_DOWNLOAD',
      DASH_CANCEL: 'DASH_CANCEL',
      DASH_SYNC: 'DASH_SYNC',
      BILIBILI_DOWNLOAD: 'BILIBILI_DOWNLOAD',
      BILIBILI_CANCEL: 'BILIBILI_CANCEL',
      BILIBILI_SYNC: 'BILIBILI_SYNC',
    })
  })
})

describe('isMediaFoundMessage', () => {
  it('接受带 url 的不完整条目，也接受空列表', () => {
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [
          { url: 'https://cdn.example/a.mp4' },
          {
            url: 'https://cdn.example/b.mp3',
            kind: 'audio',
            ext: 'mp3',
            mime: 'audio/mpeg',
            size: 0,
            sources: ['dom', 'network'],
            downloadable: true,
            note: '',
            frameUrl: 'https://example.com/frame',
            firstSeen: 0,
            extra: true,
          },
        ],
        extra: true,
      }),
    ).toBe(true)
    expect(isMediaFoundMessage({ type: MESSAGE_TYPE.MEDIA_FOUND, items: [] })).toBe(true)
  })

  it('拒绝缺 url、类型不对或条目里有非法字段的消息', () => {
    expect(isMediaFoundMessage(null)).toBe(false)
    expect(isMediaFoundMessage([])).toBe(false)
    expect(isMediaFoundMessage({ type: 'media_found', items: [] })).toBe(false)
    expect(isMediaFoundMessage({ type: MESSAGE_TYPE.MEDIA_FOUND })).toBe(false)
    expect(isMediaFoundMessage({ type: MESSAGE_TYPE.MEDIA_FOUND, items: [{ url: '  ' }] })).toBe(
      false,
    )
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4' }, { url: 1 }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', kind: 'subtitle' }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', ext: 1 }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', mime: 1 }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', note: 1 }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', frameUrl: 1 }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', size: -1 }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', size: Number.NaN }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', downloadable: 'yes' }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', firstSeen: Number.POSITIVE_INFINITY }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', sources: ['dom', 'page'] }],
      }),
    ).toBe(false)
    expect(
      isMediaFoundMessage({
        type: MESSAGE_TYPE.MEDIA_FOUND,
        items: [{ url: 'https://cdn.example/a.mp4', sources: 'dom' }],
      }),
    ).toBe(false)
  })
})

describe('isGetMediaMessage / isClearMediaMessage', () => {
  it('tabId 必须是非负整数', () => {
    expect(isGetMediaMessage({ type: MESSAGE_TYPE.GET_MEDIA, tabId: 3 })).toBe(true)
    expect(isClearMediaMessage({ type: MESSAGE_TYPE.CLEAR_MEDIA, tabId: 0 })).toBe(true)
    expect(isGetMediaMessage({ type: MESSAGE_TYPE.GET_MEDIA, tabId: -1 })).toBe(false)
    expect(isGetMediaMessage({ type: MESSAGE_TYPE.GET_MEDIA, tabId: 1.5 })).toBe(false)
    expect(isClearMediaMessage({ type: MESSAGE_TYPE.CLEAR_MEDIA, tabId: '3' })).toBe(false)
    expect(isGetMediaMessage({ type: MESSAGE_TYPE.CLEAR_MEDIA, tabId: 3 })).toBe(false)
    expect(isClearMediaMessage(null)).toBe(false)
  })
})

describe('isDownloadMessage', () => {
  it('url 必填，filename 可省略但不能是空的', () => {
    expect(isDownloadMessage({ type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/a.mp4' })).toBe(
      true,
    )
    expect(
      isDownloadMessage({
        type: MESSAGE_TYPE.DOWNLOAD,
        url: 'https://cdn.example/a.mp4',
        filename: 'clip.mp4',
      }),
    ).toBe(true)
    expect(isDownloadMessage({ type: MESSAGE_TYPE.DOWNLOAD, url: '  ' })).toBe(false)
    expect(
      isDownloadMessage({ type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/a.mp4', filename: '  ' }),
    ).toBe(false)
    expect(
      isDownloadMessage({ type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/a.mp4', filename: 1 }),
    ).toBe(false)
    expect(
      isDownloadMessage({ type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/a.mp4', tabId: 3 }),
    ).toBe(true)
    expect(
      isDownloadMessage({ type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/a.mp4', tabId: -1 }),
    ).toBe(false)
    expect(
      isDownloadMessage({ type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/a.mp4', tabId: 1.5 }),
    ).toBe(false)
    expect(isDownloadMessage({ type: MESSAGE_TYPE.GET_MEDIA, url: 'https://cdn.example/a.mp4' })).toBe(
      false,
    )
  })
})

describe('HLS 消息', () => {
  it('检查、下载、取消和同步都要带上该有的地址', () => {
    expect(isHlsInspectMessage({ type: MESSAGE_TYPE.HLS_INSPECT, url: 'https://cdn.example/a.m3u8', tabId: 2 })).toBe(
      true,
    )
    expect(isHlsInspectMessage({ type: MESSAGE_TYPE.HLS_INSPECT, url: '  ' })).toBe(false)
    expect(
      isHlsDownloadMessage({
        type: MESSAGE_TYPE.HLS_DOWNLOAD,
        url: 'https://cdn.example/a.m3u8',
        mediaUrl: 'https://cdn.example/720.m3u8',
      }),
    ).toBe(true)
    expect(isHlsDownloadMessage({ type: MESSAGE_TYPE.HLS_DOWNLOAD, url: 'https://cdn.example/a.m3u8' })).toBe(false)
    expect(isHlsCancelMessage({ type: MESSAGE_TYPE.HLS_CANCEL, url: 'https://cdn.example/a.m3u8' })).toBe(true)
    expect(isHlsSyncMessage({ type: MESSAGE_TYPE.HLS_SYNC })).toBe(true)
    expect(isHlsSyncMessage({ type: MESSAGE_TYPE.HLS_CANCEL })).toBe(false)
  })
})

describe('DASH 消息', () => {
  it('检查、下载、取消和同步都要带上该有的字段', () => {
    expect(isDashInspectMessage({ type: MESSAGE_TYPE.DASH_INSPECT, url: 'https://cdn.example/a.mpd', tabId: 2 })).toBe(
      true,
    )
    expect(isDashInspectMessage({ type: MESSAGE_TYPE.DASH_INSPECT, url: '  ' })).toBe(false)
    expect(
      isDashDownloadMessage({
        type: MESSAGE_TYPE.DASH_DOWNLOAD,
        url: 'https://cdn.example/a.mpd',
        representationId: 'video-1080',
      }),
    ).toBe(true)
    expect(isDashDownloadMessage({ type: MESSAGE_TYPE.DASH_DOWNLOAD, url: 'https://cdn.example/a.mpd' })).toBe(false)
    expect(isDashDownloadMessage({ type: MESSAGE_TYPE.DASH_DOWNLOAD, url: 'https://cdn.example/a.mpd', representationId: '  ' })).toBe(
      false,
    )
    expect(
      isDashDownloadMessage({
        type: MESSAGE_TYPE.DASH_DOWNLOAD,
        url: 'https://cdn.example/a.mpd',
        representationId: 'video-1080',
        separate: true,
      }),
    ).toBe(true)
    expect(
      isDashDownloadMessage({
        type: MESSAGE_TYPE.DASH_DOWNLOAD,
        url: 'https://cdn.example/a.mpd',
        representationId: 'video-1080',
        separate: 'yes',
      }),
    ).toBe(false)
    expect(isDashCancelMessage({ type: MESSAGE_TYPE.DASH_CANCEL, url: 'https://cdn.example/a.mpd' })).toBe(true)
    expect(isDashSyncMessage({ type: MESSAGE_TYPE.DASH_SYNC })).toBe(true)
    expect(isDashSyncMessage({ type: MESSAGE_TYPE.DASH_CANCEL })).toBe(false)
  })
})

describe('B 站消息', () => {
  it('接受下载、取消和同步', () => {
    expect(
      isBilibiliDownloadMessage({
        type: MESSAGE_TYPE.BILIBILI_DOWNLOAD,
        url: 'https://cdn.example.test/example-data/v.m4s',
        tabId: 2,
        withAudio: true,
      }),
    ).toBe(true)
    expect(isBilibiliDownloadMessage({ type: MESSAGE_TYPE.BILIBILI_DOWNLOAD, url: '  ' })).toBe(false)
    expect(
      isBilibiliDownloadMessage({
        type: MESSAGE_TYPE.BILIBILI_DOWNLOAD,
        url: 'https://cdn.example.test/example-data/v.m4s',
        withAudio: 'yes',
      }),
    ).toBe(false)
    expect(
      isBilibiliDownloadMessage({
        type: MESSAGE_TYPE.BILIBILI_DOWNLOAD,
        url: 'https://cdn.example.test/example-data/a.m4s',
        audioOnly: true,
      }),
    ).toBe(true)
    expect(
      isBilibiliDownloadMessage({
        type: MESSAGE_TYPE.BILIBILI_DOWNLOAD,
        url: 'https://cdn.example.test/example-data/a.m4s',
        audioOnly: false,
      }),
    ).toBe(true)
    expect(
      isBilibiliDownloadMessage({
        type: MESSAGE_TYPE.BILIBILI_DOWNLOAD,
        url: 'https://cdn.example.test/example-data/a.m4s',
        audioOnly: 'yes',
      }),
    ).toBe(false)
    expect(isBilibiliCancelMessage({ type: MESSAGE_TYPE.BILIBILI_CANCEL, url: 'https://cdn.example.test/a.m4s' })).toBe(
      true,
    )
    expect(isBilibiliSyncMessage({ type: MESSAGE_TYPE.BILIBILI_SYNC })).toBe(true)
    expect(isBilibiliSyncMessage({ type: MESSAGE_TYPE.BILIBILI_CANCEL })).toBe(false)
  })
})

describe('isExtensionMessage', () => {
  it('协议里的消息都能通过，其它值不行', () => {
    expect(isExtensionMessage({ type: MESSAGE_TYPE.MEDIA_FOUND, items: [] })).toBe(true)
    expect(isExtensionMessage({ type: MESSAGE_TYPE.GET_MEDIA, tabId: 1 })).toBe(true)
    expect(isExtensionMessage({ type: MESSAGE_TYPE.CLEAR_MEDIA, tabId: 1 })).toBe(true)
    expect(isExtensionMessage({ type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/a.mp4' })).toBe(
      true,
    )
    expect(isExtensionMessage({ type: MESSAGE_TYPE.HLS_INSPECT, url: 'https://cdn.example/a.m3u8' })).toBe(true)
    expect(isExtensionMessage({ type: MESSAGE_TYPE.HLS_SYNC })).toBe(true)
    expect(isExtensionMessage({ type: MESSAGE_TYPE.DASH_INSPECT, url: 'https://cdn.example/a.mpd' })).toBe(true)
    expect(
      isExtensionMessage({
        type: MESSAGE_TYPE.DASH_DOWNLOAD,
        url: 'https://cdn.example/a.mpd',
        representationId: 'video-1080',
      }),
    ).toBe(true)
    expect(isExtensionMessage({ type: MESSAGE_TYPE.DASH_SYNC })).toBe(true)
    expect(
      isExtensionMessage({
        type: MESSAGE_TYPE.BILIBILI_DOWNLOAD,
        url: 'https://cdn.example.test/example-data/v.m4s',
        withAudio: false,
        audioOnly: true,
      }),
    ).toBe(true)
    expect(isExtensionMessage({ type: MESSAGE_TYPE.BILIBILI_SYNC })).toBe(true)
    expect(isExtensionMessage({ type: 'NOPE' })).toBe(false)
    expect(isExtensionMessage(undefined)).toBe(false)
  })
})
