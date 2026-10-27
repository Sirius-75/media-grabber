import { describe, expect, it } from 'vitest'
import { fetchPlaylistText, fetchSegmentBytes } from '../src/shared/hls-fetch'

describe('拉取时不带自定义请求头', () => {
  it('分片请求只有 credentials 和 redirect，没有 headers，也没有 Referer', async () => {
    let init: RequestInit | undefined
    const result = await fetchSegmentBytes(
      'https://cdn.example/a.ts',
      new AbortController().signal,
      async (_url, request) => {
        init = request
        return new Response(Uint8Array.of(9, 8), { status: 200 })
      },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(Array.from(result.bytes)).toEqual([9, 8])
    expect(init?.credentials).toBe('include')
    expect(init?.redirect).toBe('follow')
    expect(init?.headers).toBeUndefined()
    expect(init && 'headers' in init).toBe(false)
    expect(JSON.stringify(init).toLowerCase()).not.toContain('referer')
  })

  it('206 和 403 不当成成功的分片', async () => {
    const partial = await fetchSegmentBytes('https://cdn.example/a.ts', new AbortController().signal, async () => {
      return new Response(Uint8Array.of(1), { status: 206 })
    })
    expect(partial).toEqual({ ok: false, status: 206 })
    const forbidden = await fetchSegmentBytes('https://cdn.example/a.ts', new AbortController().signal, async () => {
      return new Response(null, { status: 403 })
    })
    expect(forbidden).toEqual({ ok: false, status: 403 })
  })

  it('清单过大、网络失败，以及调用方已经取消', async () => {
    const tooBig = await fetchPlaylistText('https://cdn.example/a.m3u8', new AbortController().signal, async () => {
      return new Response('x'.repeat(2_000_001), { status: 200 })
    })
    expect(tooBig).toEqual({ ok: false, status: 0, reason: 'too-large' })

    const network = await fetchPlaylistText('https://cdn.example/a.m3u8', new AbortController().signal, async () => {
      throw new Error('offline')
    })
    expect(network).toEqual({ ok: false, status: 0, reason: 'network' })

    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchSegmentBytes('https://cdn.example/a.ts', controller.signal, async () => {
        throw new DOMException('Aborted', 'AbortError')
      }),
    ).rejects.toThrow()
  })
})
