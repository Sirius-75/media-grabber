import { afterEach, describe, expect, it, vi } from 'vitest'
import { detailsToMediaItem, startSniffer, type ResponseDetails } from '../src/background/sniffer'

const SEEN = 1_711_000_000_000

function response(overrides: Partial<ResponseDetails> = {}): ResponseDetails {
  return {
    url: 'https://cdn.example/media/clip.mp4',
    tabId: 3,
    statusCode: 200,
    timeStamp: SEEN,
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '12345' },
    ],
    ...overrides,
  }
}

describe('detailsToMediaItem 识别并带上大小', () => {
  it('mp4：按 Content-Type 识别，带上 Content-Length', () => {
    expect(detailsToMediaItem(response())).toEqual({
      url: 'https://cdn.example/media/clip.mp4',
      kind: 'video',
      ext: 'mp4',
      mime: 'video/mp4',
      size: 12345,
      sources: ['network'],
      downloadable: true,
      firstSeen: SEEN,
    })
  })

  it('mp3', () => {
    expect(
      detailsToMediaItem(
        response({
          url: 'https://cdn.example/audio/song',
          responseHeaders: [
            { name: 'content-type', value: 'audio/mpeg; charset=binary' },
            { name: 'Content-Length', value: '2048' },
          ],
        }),
      ),
    ).toEqual({
      url: 'https://cdn.example/audio/song',
      kind: 'audio',
      ext: 'mp3',
      mime: 'audio/mpeg',
      size: 2048,
      sources: ['network'],
      downloadable: true,
      firstSeen: SEEN,
    })
  })

  it('m3u8', () => {
    expect(
      detailsToMediaItem(
        response({
          url: 'https://cdn.example/live/index.m3u8?token=abc#row=1',
          responseHeaders: [
            { name: 'Content-Type', value: 'application/vnd.apple.mpegurl' },
            { name: 'CONTENT-LENGTH', value: '300' },
          ],
        }),
      ),
    ).toEqual({
      url: 'https://cdn.example/live/index.m3u8?token=abc',
      kind: 'hls',
      ext: 'm3u8',
      mime: 'application/vnd.apple.mpegurl',
      size: 300,
      sources: ['network'],
      downloadable: false,
      note: 'HLS 清单，可下载未加密的点播',
      firstSeen: SEEN,
    })
  })

  it('mpd', () => {
    expect(
      detailsToMediaItem(
        response({
          url: 'https://cdn.example/dash/manifest.mpd',
          responseHeaders: [
            { name: 'Content-Type', value: 'application/dash+xml' },
            { name: 'Content-Length', value: '4096' },
          ],
        }),
      ),
    ).toEqual({
      url: 'https://cdn.example/dash/manifest.mpd',
      kind: 'dash',
      ext: 'mpd',
      mime: 'application/dash+xml',
      size: 4096,
      sources: ['network'],
      downloadable: false,
      note: 'DASH 清单，可下载未加密的点播',
      firstSeen: SEEN,
    })
  })

  it('没有 Content-Type 时按扩展名识别，长度照样带上', () => {
    expect(
      detailsToMediaItem(
        response({
          responseHeaders: [{ name: 'Content-Length', value: ' 99 ' }],
        }),
      ),
    ).toEqual({
      url: 'https://cdn.example/media/clip.mp4',
      kind: 'video',
      ext: 'mp4',
      size: 99,
      sources: ['network'],
      downloadable: true,
      firstSeen: SEEN,
    })
  })

  it('Content-Length 不是整数时不填 size，条目仍然保留', () => {
    const item = detailsToMediaItem(
      response({
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Length', value: '12kb' },
        ],
      }),
    )
    expect(item).toMatchObject({ kind: 'video', ext: 'mp4' })
    expect(item).not.toHaveProperty('size')
  })

  it('没有 timeStamp 时用调用方传入的时间', () => {
    const item = detailsToMediaItem(response({ timeStamp: undefined }), 42)
    expect(item?.firstSeen).toBe(42)
  })
})

describe('detailsToMediaItem 忽略不该进列表的响应', () => {
  it.each(['ts', 'TS', 'm4s', 'M4S'])('.%s 分片不进列表', (ext) => {
    expect(
      detailsToMediaItem(
        response({
          url: `https://cdn.example/seg/12.${ext}?x=1`,
          responseHeaders: [
            { name: 'Content-Type', value: 'video/mp4' },
            { name: 'Content-Length', value: '188' },
          ],
        }),
      ),
    ).toBeNull()
  })

  it('query 里的 .ts 不影响真正的 mp4', () => {
    const item = detailsToMediaItem(response({ url: 'https://cdn.example/a.mp4?file=seg.ts#t=1' }))
    expect(item).toMatchObject({
      url: 'https://cdn.example/a.mp4?file=seg.ts',
      kind: 'video',
      size: 12345,
    })
  })

  it.each([-1, -5])('tabId %s 被忽略', (tabId) => {
    expect(detailsToMediaItem(response({ tabId }))).toBeNull()
  })

  it.each([301, 302, 304, 400, 403, 404, 500])('状态码 %s 被忽略', (statusCode) => {
    expect(detailsToMediaItem(response({ statusCode }))).toBeNull()
  })

  it('206 不产生新条目', () => {
    expect(detailsToMediaItem(response({ statusCode: 206 }))).toBeNull()
  })

  it('普通页面和未知类型不是媒体', () => {
    expect(
      detailsToMediaItem(
        response({
          url: 'https://example.com/',
          responseHeaders: [
            { name: 'Content-Type', value: 'text/html' },
            { name: 'Content-Length', value: '100' },
          ],
        }),
      ),
    ).toBeNull()
    expect(
      detailsToMediaItem(
        response({
          url: 'https://cdn.example/pic.png',
          responseHeaders: [{ name: 'Content-Type', value: 'image/png' }],
        }),
      ),
    ).toBeNull()
  })
})

describe('206 只更新大小', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function capture() {
    const addListener = vi.fn()
    const onBeforeSendHeaders = vi.fn()
    vi.stubGlobal('chrome', {
      webRequest: {
        onHeadersReceived: { addListener },
        onBeforeSendHeaders: { addListener: onBeforeSendHeaders },
      },
    })
    const onFound = vi.fn()
    const onSize = vi.fn()
    startSniffer(onFound, onSize)
    const [listener, filter, extra] = addListener.mock.calls[0] as [
      (details: ResponseDetails) => unknown,
      { urls: string[] },
      string[],
    ]
    return { listener, filter, extra, onFound, onSize, onBeforeSendHeaders }
  }

  it('206 把规范化 URL 和 Content-Length 交给 onSize，不调用 onFound', () => {
    const { listener, onFound, onSize } = capture()
    expect(
      listener(
        response({
          url: 'https://CDN.Example/media/clip.mp4#t=3',
          statusCode: 206,
          responseHeaders: [
            { name: 'Content-Type', value: 'video/mp4' },
            { name: 'Content-Length', value: '65536' },
          ],
        }),
      ),
    ).toBeUndefined()
    expect(onFound).not.toHaveBeenCalled()
    expect(onSize).toHaveBeenCalledTimes(1)
    expect(onSize).toHaveBeenCalledWith(3, 'https://cdn.example/media/clip.mp4', 65536)
  })

  it('没有扩展名时靠 Content-Type', () => {
    const { listener, onFound, onSize } = capture()
    listener(
      response({
        url: 'https://cdn.example/media/123',
        statusCode: 206,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/dash+xml' },
          { name: 'Content-Length', value: '80' },
        ],
      }),
    )
    expect(onFound).not.toHaveBeenCalled()
    expect(onSize).toHaveBeenCalledWith(3, 'https://cdn.example/media/123', 80)
  })

  it.each([
    ['分片', { url: 'https://cdn.example/seg/1.ts', statusCode: 206 }],
    ['tabId < 0', { tabId: -1, statusCode: 206 }],
    ['没有长度', { statusCode: 206, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] }],
    ['4xx', { statusCode: 404 }],
  ] as const)('%s 不更新大小', (_label, overrides) => {
    const { listener, onFound, onSize } = capture()
    listener(response(overrides))
    expect(onFound).not.toHaveBeenCalled()
    expect(onSize).not.toHaveBeenCalled()
  })

  it('200 只走 onFound，不走 onSize', () => {
    const { listener, onFound, onSize } = capture()
    listener(response())
    expect(onSize).not.toHaveBeenCalled()
    expect(onFound).toHaveBeenCalledTimes(1)
    expect(onFound.mock.calls[0][0]).toBe(3)
    expect(onFound.mock.calls[0][1]).toMatchObject({
      kind: 'video',
      ext: 'mp4',
      size: 12345,
      sources: ['network'],
    })
  })
})

describe('startSniffer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('只观察 onHeadersReceived，不拦截也不改请求头', () => {
    const addListener = vi.fn()
    const onBeforeSendHeaders = vi.fn()
    vi.stubGlobal('chrome', {
      webRequest: {
        onHeadersReceived: { addListener },
        onBeforeSendHeaders: { addListener: onBeforeSendHeaders },
      },
    })

    const onFound = vi.fn()
    const onSize = vi.fn()
    startSniffer(onFound, onSize)

    expect(addListener).toHaveBeenCalledTimes(1)
    const [listener, filter, extra] = addListener.mock.calls[0] as [
      (details: ResponseDetails) => unknown,
      { urls: string[] },
      string[],
    ]
    expect(filter).toEqual({ urls: ['<all_urls>'] })
    expect(extra).toEqual(['responseHeaders'])
    expect(onBeforeSendHeaders).not.toHaveBeenCalled()

    expect(listener(response({ url: 'https://cdn.example/seg/1.ts' }))).toBeUndefined()
    expect(onFound).not.toHaveBeenCalled()
    expect(onSize).not.toHaveBeenCalled()

    expect(listener(response({ tabId: -1 }))).toBeUndefined()
    expect(listener(response({ statusCode: 404 }))).toBeUndefined()
    expect(onFound).not.toHaveBeenCalled()

    expect(
      listener(
        response({
          statusCode: 206,
          responseHeaders: [
            { name: 'Content-Type', value: 'video/mp4' },
            { name: 'Content-Length', value: '10' },
          ],
        }),
      ),
    ).toBeUndefined()
    expect(onFound).not.toHaveBeenCalled()
    expect(onSize).toHaveBeenCalledTimes(1)
    expect(onSize).toHaveBeenCalledWith(3, 'https://cdn.example/media/clip.mp4', 10)

    listener(response())
    expect(onFound).toHaveBeenCalledTimes(1)
    expect(onFound.mock.calls[0][0]).toBe(3)
    expect(onFound.mock.calls[0][1]).toMatchObject({
      kind: 'video',
      ext: 'mp4',
      size: 12345,
      sources: ['network'],
    })
  })

  it('B 站 CDN 上的 .m4s 只列一次，普通分片仍然忽略（示例数据）', () => {
    const addListener = vi.fn()
    vi.stubGlobal('chrome', {
      webRequest: { onHeadersReceived: { addListener } },
    })
    const onFound = vi.fn()
    const onSize = vi.fn()
    startSniffer(onFound, onSize)
    const listener = addListener.mock.calls[0][0] as (details: ResponseDetails) => void
    const file = 'https://upos-example.bilivideo.com/example-data/clip.m4s?deadline=9&platform=pc'
    const headers = [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '1024' },
      { name: 'Content-Range', value: 'bytes 0-1023/4096' },
    ]
    listener(response({ url: `${file}&range=0-1023`, statusCode: 206, responseHeaders: headers }))
    listener(response({ url: `${file}&range=1024-2047`, statusCode: 206, responseHeaders: headers }))
    listener(response({ url: 'https://cdn.example/seg/1.m4s', statusCode: 200 }))
    expect(onSize).not.toHaveBeenCalled()
    expect(onFound).toHaveBeenCalledTimes(1)
    expect(onFound.mock.calls[0][1]).toMatchObject({
      url: file,
      size: 4096,
      downloadable: false,
      bilibili: { role: 'unknown', label: 'B站 m4s 分轨文件' },
    })
    expect(onFound.mock.calls[0][1].note).toContain('类型未知')
  })

  it('不传 onSize 时 206 被忽略', () => {
    const addListener = vi.fn()
    vi.stubGlobal('chrome', {
      webRequest: { onHeadersReceived: { addListener } },
    })
    const onFound = vi.fn()
    startSniffer(onFound)
    const listener = addListener.mock.calls[0][0] as (details: ResponseDetails) => void
    listener(response({ statusCode: 206 }))
    expect(onFound).not.toHaveBeenCalled()
  })
})
