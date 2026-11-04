import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_RETRY_STORAGE_KEY,
  readDownloadRetryMap,
} from '../src/shared/download-retry'

describe('重试参数', () => {
  it('认出 HLS、DASH 和 B 站各自需要的参数', () => {
    expect(DOWNLOAD_RETRY_STORAGE_KEY).toBe('download-retry')
    expect(
      readDownloadRetryMap({
        'https://cdn.example/master.m3u8': {
          kind: 'hls',
          mode: 'download',
          mediaUrl: 'https://cdn.example/high.m3u8',
        },
        'https://cdn.example/manifest.mpd': {
          kind: 'dash',
          mode: 'download',
          representationId: 'video-1080',
          audioOnly: false,
          separate: true,
        },
        'https://cdn.example.test/v.m4s': {
          kind: 'bilibili',
          mode: 'with-audio',
          separate: false,
        },
      }),
    ).toEqual({
      'https://cdn.example/master.m3u8': {
        kind: 'hls',
        mode: 'download',
        mediaUrl: 'https://cdn.example/high.m3u8',
      },
      'https://cdn.example/manifest.mpd': {
        kind: 'dash',
        mode: 'download',
        representationId: 'video-1080',
        audioOnly: false,
        separate: true,
      },
      'https://cdn.example.test/v.m4s': {
        kind: 'bilibili',
        mode: 'with-audio',
        separate: false,
      },
    })
  })

  it('丢掉坏数据后仍接受其它正常参数', () => {
    expect(readDownloadRetryMap(null)).toEqual({})
    expect(
      readDownloadRetryMap({
        '': { kind: 'hls', mode: 'inspect' },
        noMedia: { kind: 'hls', mode: 'download' },
        noId: { kind: 'dash', mode: 'download', audioOnly: false, separate: false },
        badMode: { kind: 'bilibili', mode: 'both', separate: false },
        badFlag: { kind: 'dash', mode: 'inspect', audioOnly: 'yes', separate: false },
        good: { kind: 'bilibili', mode: 'video-only', separate: false },
      }),
    ).toEqual({
      good: { kind: 'bilibili', mode: 'video-only', separate: false },
    })
  })
})
