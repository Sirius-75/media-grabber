import { describe, expect, it } from 'vitest'
import {
  MAX_CONCURRENT_JOBS,
  MAX_WAITING_JOBS,
  QUEUE_EXPIRED_TEXT,
  dedupeQueue,
  emptyQueue,
  enqueueJob,
  expireWaiting,
  finishRunning,
  finishRunningByKey,
  queuePosition,
  queuedStatusText,
  readDownloadQueue,
  reconcileRunning,
  removeWaiting,
  removeWaitingByKey,
  takeStartable,
  type BilibiliQueueJob,
  type DashQueueJob,
  type HlsQueueJob,
  type QueueJob,
} from '../src/shared/download-queue'
import { readHlsJobMap } from '../src/shared/hls-job'

function hls(id: string, key = `https://cdn.example/${id}.m3u8`): HlsQueueJob {
  return {
    id,
    kind: 'hls',
    key,
    mediaUrl: key,
    enqueuedAt: 1,
  }
}

function dash(id: string): DashQueueJob {
  return {
    id,
    kind: 'dash',
    key: `https://cdn.example/${id}.mpd`,
    representationId: 'v1',
    separate: false,
    audioOnly: false,
    enqueuedAt: 1,
  }
}

function bilibili(id: string): BilibiliQueueJob {
  return {
    id,
    kind: 'bilibili',
    key: `https://upos.example/${id}.m4s`,
    pageUrl: 'https://www.bilibili.com/video/BV1',
    files: [
      { url: `https://upos.example/${id}-v.m4s`, role: 'video', quality: '1080P' },
      { url: `https://upos.example/${id}-a.m4s`, role: 'audio' },
    ],
    separate: true,
    enqueuedAt: 1,
  }
}

function queue(waiting: QueueJob[]): ReturnType<typeof emptyQueue> {
  return { running: [], waiting }
}

describe('下载队列调度', () => {
  it('常量是 2，排队位置从 1 开始', () => {
    expect(MAX_CONCURRENT_JOBS).toBe(2)
    const state = queue([hls('a'), hls('b'), hls('c')])
    expect(queuePosition(state, 'a')).toBe(1)
    expect(queuePosition(state, 'c')).toBe(3)
    expect(queuePosition(state, 'missing')).toBeUndefined()
    expect(queuedStatusText(2)).toBe('排队中（第 2 位）')
  })

  it('入队后最多启动两个，多出来的继续排队', () => {
    let state = emptyQueue()
    state = enqueueJob(state, hls('a'))
    state = enqueueJob(state, dash('b'))
    state = enqueueJob(state, bilibili('c'))

    const first = takeStartable(state)
    expect(first.started.map((job) => job.id)).toEqual(['a', 'b'])
    expect(first.state.running.map((job) => job.id)).toEqual(['a', 'b'])
    expect(first.state.waiting.map((job) => job.id)).toEqual(['c'])

    const again = takeStartable(first.state)
    expect(again.started).toEqual([])
    expect(again.state.running).toHaveLength(2)
  })

  it('完成一个后自动补位到队首，保持原顺序', () => {
    const first = takeStartable(queue([hls('a'), hls('b'), hls('c'), hls('d')]), 2)
    expect(first.state.running.map((job) => job.id)).toEqual(['a', 'b'])
    expect(first.state.waiting.map((job) => job.id)).toEqual(['c', 'd'])

    const afterFinish = finishRunning(first.state, 'a')
    expect(afterFinish.running.map((job) => job.id)).toEqual(['b'])
    expect(afterFinish.waiting.map((job) => job.id)).toEqual(['c', 'd'])

    const next = takeStartable(afterFinish, 2)
    expect(next.started.map((job) => job.id)).toEqual(['c'])
    expect(next.state.running.map((job) => job.id)).toEqual(['b', 'c'])
    expect(next.state.waiting.map((job) => job.id)).toEqual(['d'])
  })

  it('按 key 完成也能腾出槽位', () => {
    const first = takeStartable(queue([hls('a'), hls('b')]), 2)
    const after = finishRunningByKey(first.state, 'https://cdn.example/a.m3u8')
    expect(after.running.map((job) => job.id)).toEqual(['b'])
  })

  it('取消排队中的任务只移出队列，不影响正在跑的', () => {
    const first = takeStartable(queue([hls('a'), hls('b'), hls('c')]), 2)
    const removed = removeWaiting(first.state, 'c')
    expect(removed.job?.id).toBe('c')
    expect(removed.state.running.map((job) => job.id)).toEqual(['a', 'b'])
    expect(removed.state.waiting).toEqual([])

    const byKey = removeWaitingByKey(removed.state, 'nope')
    expect(byKey.job).toBeUndefined()
    expect(byKey.state).toBe(removed.state)

    const noSuchId = removeWaiting(removed.state, 'missing')
    expect(noSuchId.job).toBeUndefined()
    expect(noSuchId.state).toBe(removed.state)
  })

  it('不能启动的任务留在队列里，先启动后面能跑的，避免空占槽位', () => {
    const state = queue([bilibili('a'), hls('b'), hls('c')])
    const taken = takeStartable(state, 1, (job) => job.kind !== 'bilibili')
    expect(taken.started.map((job) => job.id)).toEqual(['b'])
    expect(taken.state.waiting.map((job) => job.id)).toEqual(['a', 'c'])
  })

  it('僵尸清理只保留 offscreen 还活着的 running，并返回丢失的任务', () => {
    const first = takeStartable(queue([hls('a'), dash('b'), bilibili('c')]), 2)
    const reconciled = reconcileRunning(first.state, new Set(['https://cdn.example/a.m3u8']))
    expect(reconciled.state.running.map((job) => job.id)).toEqual(['a'])
    expect(reconciled.lost.map((job) => job.id)).toEqual(['b'])
    expect(reconciled.state.waiting.map((job) => job.id)).toEqual(['c'])
  })

  it('排队太久和超过上限的任务会被清理', () => {
    const now = 10_000_000
    const old = hls('old')
    old.enqueuedAt = now - 25 * 60 * 60 * 1000
    const fresh = hls('fresh')
    fresh.enqueuedAt = now
    const expired = expireWaiting(queue([old, fresh]), now)
    expect(expired.expired.map((job) => job.id)).toEqual(['old'])
    expect(expired.state.waiting.map((job) => job.id)).toEqual(['fresh'])
    expect(QUEUE_EXPIRED_TEXT).toContain('排队超时')

    const many = Array.from({ length: MAX_WAITING_JOBS + 2 }, (_, index) => hls(`job-${index}`))
    const trimmed = expireWaiting(queue(many), now)
    expect(trimmed.state.waiting).toHaveLength(MAX_WAITING_JOBS)
    expect(trimmed.expired).toHaveLength(2)
  })
})

describe('下载队列存储形状', () => {
  it('合法任务能读回来，字段按类型区分', () => {
    const state = { running: [hls('a')], waiting: [dash('b'), bilibili('c')] }
    const parsed = readDownloadQueue(state)
    expect(parsed.running[0]).toMatchObject({ kind: 'hls', mediaUrl: 'https://cdn.example/a.m3u8' })
    expect(parsed.waiting[0]).toMatchObject({ kind: 'dash', representationId: 'v1' })
    expect(parsed.waiting[1]).toMatchObject({
      kind: 'bilibili',
      pageUrl: 'https://www.bilibili.com/video/BV1',
      separate: true,
    })
    expect(parsed.waiting[1]?.kind === 'bilibili' && parsed.waiting[1].files).toHaveLength(2)

    const live = readDownloadQueue({ running: [{ ...hls('live'), live: true }], waiting: [] })
    expect(live.running[0]).toMatchObject({ kind: 'hls', live: true })
    expect(readDownloadQueue({ running: [{ ...hls('bad'), live: 'yes' }], waiting: [] })).toEqual(emptyQueue())
  })

  it('写坏的值整个丢掉，重复 id 只留第一次', () => {
    expect(readDownloadQueue(undefined)).toEqual(emptyQueue())
    expect(readDownloadQueue({ running: [{ id: 'x' }], waiting: [] })).toEqual(emptyQueue())
    expect(readDownloadQueue({ running: 'no', waiting: [] })).toEqual(emptyQueue())
    const duplicate = { running: [], waiting: [hls('same'), hls('same')] }
    expect(dedupeQueue(readDownloadQueue(duplicate)).waiting).toHaveLength(1)
  })

  it('任务记录接受排队阶段，popup 才能显示排队中', () => {
    const map = readHlsJobMap({
      'https://cdn.example/a.m3u8': {
        phase: 'queued',
        message: queuedStatusText(1),
        completed: 0,
        total: 0,
        updatedAt: 10,
      },
    })
    expect(map['https://cdn.example/a.m3u8']?.phase).toBe('queued')
    expect(map['https://cdn.example/a.m3u8']?.message).toBe('排队中（第 1 位）')
  })
})
