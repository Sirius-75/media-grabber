import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_FAILED_TEXT,
  describeInterruptReason,
  downloadBlockReason,
  readDownloadStatusMap,
  trimDownloadStatuses,
} from '../src/shared/download-status'

describe('describeInterruptReason', () => {
  it('把 SERVER_FORBIDDEN 和 NETWORK_FAILED 翻成中文', () => {
    expect(describeInterruptReason('SERVER_FORBIDDEN')).toBe('服务器拒绝访问（403）')
    expect(describeInterruptReason('NETWORK_FAILED')).toBe('网络连接失败')
    expect(describeInterruptReason('Download error: SERVER_FORBIDDEN')).toBe('服务器拒绝访问（403）')
    expect(describeInterruptReason('403 Forbidden')).toBe('服务器拒绝访问（403）')
    expect(describeInterruptReason('network failed')).toBe('网络连接失败')
  })

  it('认不出的错误用固定文案，不把英文原句丢给界面', () => {
    expect(describeInterruptReason(undefined)).toBe(DOWNLOAD_FAILED_TEXT)
    expect(describeInterruptReason('  ')).toBe(DOWNLOAD_FAILED_TEXT)
    expect(describeInterruptReason('something else')).toBe(DOWNLOAD_FAILED_TEXT)
    expect(describeInterruptReason('USER_CANCELED')).toBe('下载已取消')
  })
})

describe('downloadBlockReason', () => {
  it('拒绝 HLS、DASH、blob、data 和不可下载的条目', () => {
    expect(
      downloadBlockReason({
        url: 'https://cdn.example/live/index.m3u8',
        fromStore: false,
      }),
    ).toBe('HLS 清单不能当直链保存，请用列表里的下载')
    expect(
      downloadBlockReason({
        url: 'https://cdn.example/manifest.mpd',
        fromStore: false,
      }),
    ).toBe('DASH 清单，仅支持复制链接')
    expect(
      downloadBlockReason({
        url: 'blob:https://example.com/8c2c',
        fromStore: false,
      }),
    ).toBe('blob 地址，无法直接下载')
    expect(
      downloadBlockReason({
        url: 'data:audio/mpeg;base64,AAAA',
        fromStore: false,
      }),
    ).toBe('data 地址，无法直接下载')
    expect(
      downloadBlockReason({
        url: 'https://cdn.example/seg.ts',
        fromStore: false,
      }),
    ).toBe('无法直接下载')
    expect(
      downloadBlockReason({
        url: 'ftp://cdn.example/a.mp4',
        fromStore: false,
      }),
    ).toBe('只支持 http 或 https 直链')
  })

  it('列表里 downloadable 为 false 时用条目自己的说明', () => {
    expect(
      downloadBlockReason({
        url: 'https://cdn.example/locked.mp4',
        kind: 'video',
        downloadable: false,
        note: '需要登录才能下载',
        fromStore: true,
      }),
    ).toBe('需要登录才能下载')
    expect(
      downloadBlockReason({
        url: 'https://cdn.example/a.mp4',
        kind: 'video',
        downloadable: true,
        fromStore: true,
      }),
    ).toBeUndefined()
  })

  it('不在列表里的直链 mp4 可以下载', () => {
    expect(
      downloadBlockReason({
        url: 'https://cdn.example/a.mp4?x=1#t=2',
        fromStore: false,
      }),
    ).toBeUndefined()
  })
})

describe('readDownloadStatusMap / trimDownloadStatuses', () => {
  it('丢掉坏数据', () => {
    expect(readDownloadStatusMap(null)).toEqual({})
    expect(
      readDownloadStatusMap({
        '': { phase: 'failed', message: '不会留下', updatedAt: 1 },
        good: { phase: 'complete', message: '已完成', updatedAt: 2, downloadId: 4 },
        bad: { phase: 'nope', message: '已完成', updatedAt: 2 },
        missing: { phase: 'started', message: '  ', updatedAt: 2 },
      }),
    ).toEqual({
      good: { phase: 'complete', message: '已完成', updatedAt: 2, downloadId: 4 },
    })
  })

  it('超过上限时留下最近的', () => {
    const map = {
      old: { phase: 'failed' as const, message: '旧的', updatedAt: 1 },
      mid: { phase: 'started' as const, message: '已开始下载', updatedAt: 2 },
      now: { phase: 'complete' as const, message: '已完成', updatedAt: 3 },
    }
    expect(trimDownloadStatuses(map, 2)).toEqual({
      mid: map.mid,
      now: map.now,
    })
  })
})
