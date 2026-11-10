import { describe, expect, it } from 'vitest'
import { readDownloadQueue } from '../src/shared/download-queue'
import { DEFAULT_PREFERENCES, readPreferences } from '../src/shared/preferences'

describe('录制起点开关', () => {
  it('缺省、空值和别的类型都是从点击时的边缘开始', () => {
    expect(readPreferences(undefined)).toEqual(DEFAULT_PREFERENCES)
    expect(readPreferences(null)).toEqual({ includeExistingLiveSegments: false })
    expect(readPreferences({})).toEqual({ includeExistingLiveSegments: false })
    expect(readPreferences({ includeExistingLiveSegments: 'yes' })).toEqual({
      includeExistingLiveSegments: false,
    })
    expect(readPreferences({ includeExistingLiveSegments: false })).toEqual({
      includeExistingLiveSegments: false,
    })
  })

  it('只有明确的 true 才包含清单里已有的分片，并且能从队列里读回来', () => {
    expect(readPreferences({ includeExistingLiveSegments: true })).toEqual({
      includeExistingLiveSegments: true,
    })
    const queue = readDownloadQueue({
      running: [
        {
          id: 'job-1',
          kind: 'hls',
          key: 'https://cdn.example/live.m3u8',
          mediaUrl: 'https://cdn.example/live.m3u8',
          enqueuedAt: 1,
          live: true,
          includeExisting: true,
        },
      ],
      waiting: [],
    })
    expect(queue.running[0]).toMatchObject({ live: true, includeExisting: true })
    const edge = readDownloadQueue({
      running: [
        {
          id: 'job-2',
          kind: 'hls',
          key: 'https://cdn.example/live.m3u8',
          mediaUrl: 'https://cdn.example/live.m3u8',
          enqueuedAt: 1,
          live: true,
        },
      ],
      waiting: [],
    })
    expect(edge.running[0]).not.toHaveProperty('includeExisting')
    expect(
      readDownloadQueue({
        running: [
          {
            id: 'job-3',
            kind: 'hls',
            key: 'https://cdn.example/live.m3u8',
            mediaUrl: 'https://cdn.example/live.m3u8',
            enqueuedAt: 1,
            live: true,
            includeExisting: 'yes',
          },
        ],
        waiting: [],
      }).running,
    ).toEqual([])
  })
})
