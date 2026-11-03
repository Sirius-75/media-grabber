/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import type { HlsJobMap } from '../src/shared/hls-job'
import type { DownloadQueueState } from '../src/shared/download-queue'
import type { MediaItem } from '../src/shared/types'
import { renderList } from '../src/popup/view'

function item(overrides: Partial<MediaItem> & Pick<MediaItem, 'url' | 'kind'>): MediaItem {
  return {
    sources: ['dom'],
    downloadable: false,
    firstSeen: 1,
    ...overrides,
  }
}

const hlsA = item({
  url: 'https://cdn.example/a.m3u8',
  kind: 'hls',
  ext: 'm3u8',
})
const hlsB = item({
  url: 'https://cdn.example/b.m3u8',
  kind: 'hls',
  ext: 'm3u8',
})

function queuedJob(id: string, key: string): DownloadQueueState['waiting'][number] {
  return {
    id,
    kind: 'hls',
    key,
    mediaUrl: key,
    enqueuedAt: 1,
  }
}

describe('排队中的条目', () => {
  it('显示「排队中（第 N 位）」并保留取消按钮', () => {
    const jobs: HlsJobMap = {
      [hlsA.url]: { phase: 'queued', message: '排队中', completed: 0, total: 0, updatedAt: 1 },
      [hlsB.url]: { phase: 'queued', message: '排队中', completed: 0, total: 0, updatedAt: 1 },
    }
    const queue: DownloadQueueState = {
      running: [],
      waiting: [queuedJob('a', hlsA.url), queuedJob('b', hlsB.url)],
    }
    const list = document.createElement('ul')
    renderList(list, [hlsA, hlsB], undefined, jobs, undefined, undefined, undefined, queue)

    const statuses = [...list.querySelectorAll('.status')].map((node) => node.textContent)
    expect(statuses).toEqual(['排队中（第 1 位）', '排队中（第 2 位）'])
    expect(list.querySelectorAll('[data-action="hls-cancel"]')).toHaveLength(2)
    expect(list.querySelectorAll('[data-action="hls-download"]')).toHaveLength(0)
  })

  it('队列位置变化后，同一份任务记录也能显示新的位置', () => {
    const jobs: HlsJobMap = {
      [hlsB.url]: { phase: 'queued', message: '排队中（第 2 位）', completed: 0, total: 0, updatedAt: 1 },
    }
    const queue: DownloadQueueState = {
      running: [],
      waiting: [queuedJob('b', hlsB.url)],
    }
    const list = document.createElement('ul')
    renderList(list, [hlsB], undefined, jobs, undefined, undefined, undefined, queue)
    expect(list.querySelector('.status')?.textContent).toBe('排队中（第 1 位）')
  })
})
