import { describe, expect, it } from 'vitest'
import { readHlsJobMap, readHlsUserResponse, trimHlsJobs } from '../src/shared/hls-job'

describe('HLS 任务记录', () => {
  it('坏掉的 session 值丢掉，不让界面崩', () => {
    expect(readHlsJobMap(null)).toEqual({})
    expect(
      readHlsJobMap({
        '': { phase: 'failed', message: 'x', completed: 0, total: 0, updatedAt: 1 },
        good: { phase: 'downloading', message: '已下载 1/4', completed: 1, total: 4, updatedAt: 2 },
        remux: { phase: 'remuxing', message: '正在转成 mp4…', completed: 4, total: 4, updatedAt: 4 },
        bad: { phase: 'nope', message: 'x', completed: 0, total: 0, updatedAt: 3 },
        epoch: { phase: 'downloading', message: '已下载 1/2', completed: 1, total: 2, updatedAt: 5, epoch: 3 },
        badEpoch: { phase: 'downloading', message: '已下载 1/2', completed: 1, total: 2, updatedAt: 6, epoch: -1 },
        dash: {
          phase: 'complete',
          message: '已完成',
          completed: 1,
          total: 1,
          updatedAt: 7,
          hasVideo: false,
          hasAudio: true,
          audioOnly: true,
        },
        badFlag: {
          phase: 'complete',
          message: '已完成',
          completed: 1,
          total: 1,
          updatedAt: 8,
          hasVideo: 'yes',
        },
        live: {
          phase: 'recording',
          message: '正在录制 00:10 / 已录 1.5 KB',
          completed: 1536,
          total: 0,
          updatedAt: 9,
          live: true,
          recordedMs: 10_000,
          recordedBytes: 1536,
        },
        badLive: {
          phase: 'recording',
          message: '正在录制',
          completed: 0,
          total: 0,
          updatedAt: 10,
          recordedMs: -1,
        },
      }),
    ).toEqual({
      good: { phase: 'downloading', message: '已下载 1/4', completed: 1, total: 4, updatedAt: 2 },
      remux: { phase: 'remuxing', message: '正在转成 mp4…', completed: 4, total: 4, updatedAt: 4 },
      epoch: { phase: 'downloading', message: '已下载 1/2', completed: 1, total: 2, updatedAt: 5, epoch: 3 },
      dash: {
        phase: 'complete',
        message: '已完成',
        completed: 1,
        total: 1,
        updatedAt: 7,
        hasVideo: false,
        hasAudio: true,
        audioOnly: true,
      },
      live: {
        phase: 'recording',
        message: '正在录制 00:10 / 已录 1.5 KB',
        completed: 1536,
        total: 0,
        updatedAt: 9,
        live: true,
        recordedMs: 10_000,
        recordedBytes: 1536,
      },
    })
  })

  it('超过上限时丢掉最早的', () => {
    const map = {
      a: { phase: 'complete' as const, message: '已完成', completed: 1, total: 1, updatedAt: 1 },
      b: { phase: 'failed' as const, message: '失败', completed: 0, total: 1, updatedAt: 2 },
      c: { phase: 'cancelled' as const, message: '下载已取消', completed: 0, total: 1, updatedAt: 3 },
    }
    expect(Object.keys(trimHlsJobs(map, 2))).toEqual(['b', 'c'])
  })

  it('只接受能画到界面上的检查结果', () => {
    expect(
      readHlsUserResponse({
        ok: true,
        kind: 'master',
        variants: [{ url: 'https://cdn.example/a.m3u8', label: '1080p', bandwidth: 1, separateAudio: false }],
      }),
    ).toMatchObject({ ok: true, kind: 'master' })
    expect(readHlsUserResponse({ ok: false, error: '  服务器拒绝访问（403） ' })).toEqual({
      ok: false,
      error: '服务器拒绝访问（403）',
    })
    expect(readHlsUserResponse({ ok: true })).toEqual({ ok: true })
    expect(readHlsUserResponse({ ok: false })).toBeUndefined()
    expect(
      readHlsUserResponse({ ok: false, error: '清单里只有音频轨', hasVideo: false, hasAudio: true }),
    ).toEqual({ ok: false, error: '清单里只有音频轨', hasVideo: false, hasAudio: true })
    expect(readHlsUserResponse({ ok: false, error: 'x', hasVideo: 'yes' })).toBeUndefined()
  })

  it('直播检查结果带目标时长，直播主清单额外带 live 标记', () => {
    expect(readHlsUserResponse({ ok: true, kind: 'live', targetDuration: 4, warning: '含 AES-128 加密' })).toEqual({
      ok: true,
      kind: 'live',
      targetDuration: 4,
      warning: '含 AES-128 加密',
    })
    expect(readHlsUserResponse({ ok: true, kind: 'live', targetDuration: Number.NaN })).toBeUndefined()
    expect(
      readHlsUserResponse({
        ok: true,
        kind: 'master',
        live: true,
        variants: [{ url: 'https://cdn.example/a.m3u8', label: '1080p', bandwidth: 1, separateAudio: false }],
      }),
    ).toMatchObject({ ok: true, kind: 'master', live: true })
    expect(readHlsUserResponse({ ok: true, kind: 'master', live: 'yes', variants: [] })).toBeUndefined()
  })
})
