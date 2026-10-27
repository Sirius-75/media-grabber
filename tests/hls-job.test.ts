import { describe, expect, it } from 'vitest'
import { readHlsJobMap, readHlsUserResponse, trimHlsJobs } from '../src/shared/hls-job'

describe('HLS 任务记录', () => {
  it('坏掉的 session 值丢掉，不让界面崩', () => {
    expect(readHlsJobMap(null)).toEqual({})
    expect(
      readHlsJobMap({
        '': { phase: 'failed', message: 'x', completed: 0, total: 0, updatedAt: 1 },
        good: { phase: 'downloading', message: '已下载 1/4', completed: 1, total: 4, updatedAt: 2 },
        bad: { phase: 'nope', message: 'x', completed: 0, total: 0, updatedAt: 3 },
      }),
    ).toEqual({
      good: { phase: 'downloading', message: '已下载 1/4', completed: 1, total: 4, updatedAt: 2 },
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
  })
})
