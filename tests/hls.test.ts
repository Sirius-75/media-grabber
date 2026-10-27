import { describe, expect, it } from 'vitest'
import { buildDownloadFilename } from '../src/shared/filename'
import {
  HLS_HARD_BYTE_LIMIT,
  HLS_TEXT,
  HLS_WARN_SEGMENT_COUNT,
  assessHlsSize,
  describeFetchFailure,
  describePlaylistStatus,
  hlsEncryptedText,
  mediaDownloadWarning,
  parseAttributeList,
  parseHlsPlaylist,
  variantLabel,
} from '../src/shared/hls'

const MASTER = 'https://cdn.example/hls/master.m3u8?token=abc'

describe('parseAttributeList', () => {
  it('引号里的逗号不当成分隔', () => {
    const attrs = parseAttributeList(
      'BANDWIDTH=1280000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aac"',
    )
    expect(attrs.get('BANDWIDTH')).toBe('1280000')
    expect(attrs.get('CODECS')).toBe('avc1.64001f,mp4a.40.2')
    expect(attrs.get('AUDIO')).toBe('aac')
  })
})

describe('主清单', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"',
    'https://other.example/full.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
    '/hls/hi/index.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframe.m3u8"',
  ].join('\n')

  it('按带宽从高到低排，相对地址按清单目录解析，不继承 query', () => {
    const parsed = parseHlsPlaylist(text, MASTER)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'master') return
    expect(parsed.variants.map((variant) => variant.url)).toEqual([
      'https://other.example/full.m3u8',
      'https://cdn.example/hls/hi/index.m3u8',
      'https://cdn.example/hls/low/index.m3u8',
    ])
    expect(parsed.variants[0]).toMatchObject({
      bandwidth: 4500000,
      width: 1920,
      height: 1080,
      separateAudio: true,
      label: '1920×1080 · 4500 kbps',
    })
    expect(parsed.variants[2]?.separateAudio).toBe(false)
    expect(parsed.variants[2]?.label).toBe('640×360 · 800 kbps')
    expect(variantLabel({ bandwidth: 0 })).toBe('未知清晰度')
  })

  it('没有 EXT-X-ENDLIST 的主清单仍然可以选清晰度', () => {
    const parsed = parseHlsPlaylist(text, MASTER)
    expect(parsed.ok).toBe(true)
  })

  it('只有关键帧预览时拒绝', () => {
    const onlyIframe = ['#EXTM3U', '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI="i.m3u8"'].join('\n')
    expect(parseHlsPlaylist(onlyIframe, MASTER)).toEqual({ ok: false, error: HLS_TEXT.iframeOnlyMaster })
  })
})

describe('媒体清单', () => {
  it('相对路径、上级目录、EXT-X-MAP 和 EXT-X-DISCONTINUITY', () => {
    const text = [
      '\uFEFF#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="init/header.mp4"',
      '#EXTINF:4.0,',
      '../seg/a.m4s',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-PROGRAM-DATE-TIME:2020-01-01T00:00:00.000Z',
      '#EXTINF:2.5,标题',
      'b.m4s?x=1',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const parsed = parseHlsPlaylist(text, 'https://cdn.example/hls/v/index.m3u8')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'media') return
    expect(parsed.media.container).toBe('mp4')
    expect(parsed.media.initUrl).toBe('https://cdn.example/hls/v/init/header.mp4')
    expect(parsed.media.segments.map((segment) => segment.url)).toEqual([
      'https://cdn.example/hls/seg/a.m4s',
      'https://cdn.example/hls/v/b.m4s?x=1',
    ])
    expect(parsed.media.durationSeconds).toBeCloseTo(6.5)
    expect(parsed.media.segmentCount).toBe(2)
  })

  it('没有初始化段的 TS 清单容器是 ts', () => {
    const text = ['#EXTM3U', '#EXTINF:1,', 'a.ts', '#EXTINF:1,', 'b.ts', '#EXT-X-ENDLIST'].join('\n')
    const parsed = parseHlsPlaylist(text, 'https://cdn.example/p.m3u8')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'media') return
    expect(parsed.media.container).toBe('ts')
    expect(parsed.media.initUrl).toBeUndefined()
  })

  it('METHOD=NONE 不算加密，广告打点标签忽略', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:1,',
      'a.ts',
      '#EXT-X-CUE-OUT:30',
      '#EXTINF:1,',
      'b.ts',
      '#EXT-X-ENDLIST',
    ].join('\n')
    expect(parseHlsPlaylist(text, 'https://cdn.example/p.m3u8').ok).toBe(true)
  })
})

describe('拒绝', () => {
  const base = 'https://cdn.example/p.m3u8'

  function media(body: string) {
    return parseHlsPlaylist(`#EXTM3U\n${body}\n#EXT-X-ENDLIST\n`, base)
  }

  it('不是清单、直播、加密、字节范围、缺口、多个初始化段、fMP4 缺 MAP', () => {
    expect(parseHlsPlaylist('hello', base)).toEqual({ ok: false, error: HLS_TEXT.notPlaylist })
    expect(parseHlsPlaylist('#EXTM3U\n#EXTINF:1,\na.ts\n', base)).toEqual({ ok: false, error: HLS_TEXT.live })
    expect(media('#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key"\n#EXTINF:1,\na.ts')).toEqual({
      ok: false,
      error: hlsEncryptedText('AES-128'),
    })
    expect(media('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:1,\na.ts')).toEqual({
      ok: false,
      error: hlsEncryptedText('SAMPLE-AES'),
    })
    expect(media('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:1,\na.ts')).toEqual({
      ok: false,
      error: HLS_TEXT.sessionKey,
    })
    expect(media('#EXTINF:1,\n#EXT-X-BYTERANGE:1000@0\na.ts')).toEqual({ ok: false, error: HLS_TEXT.byterange })
    expect(media('#EXT-X-GAP\n#EXTINF:1,\na.ts')).toEqual({ ok: false, error: HLS_TEXT.gap })
    expect(media('#EXT-X-I-FRAMES-ONLY\n#EXTINF:1,\na.ts')).toEqual({ ok: false, error: HLS_TEXT.iframesOnly })
    expect(media('#EXT-X-MAP:URI="a.mp4",BYTERANGE="100@0"\n#EXTINF:1,\nb.m4s')).toEqual({
      ok: false,
      error: HLS_TEXT.mapByterange,
    })
    expect(media('#EXT-X-MAP:URI="a.mp4"\n#EXT-X-MAP:URI="b.mp4"\n#EXTINF:1,\nc.m4s')).toEqual({
      ok: false,
      error: HLS_TEXT.multipleMap,
    })
    expect(media('#EXTINF:1,\na.m4s')).toEqual({ ok: false, error: HLS_TEXT.fmp4NoMap })
    expect(media('#EXT-X-DEFINE:NAME="x",VALUE="y"\n#EXTINF:1,\na.ts')).toEqual({
      ok: false,
      error: HLS_TEXT.variables,
    })
    expect(parseHlsPlaylist('#EXTM3U\n#EXT-X-ENDLIST\n', base)).toEqual({ ok: false, error: HLS_TEXT.empty })
    expect(parseHlsPlaylist('#EXTM3U', 'ftp://cdn.example/p.m3u8')).toEqual({
      ok: false,
      error: HLS_TEXT.badPlaylistUrl,
    })
  })

  it('分片下载失败时写出 403 和缺失的是哪一片', () => {
    expect(describeFetchFailure({ index: 2, initCount: 1, status: 404 })).toBe('第 2 个分片缺失（404）')
    expect(describeFetchFailure({ index: 0, initCount: 1, status: 404 })).toBe('初始化段缺失（404）')
    expect(describeFetchFailure({ index: 0, initCount: 0, status: 403 })).toBe('服务器拒绝访问（403）')
    expect(describeFetchFailure({ index: 0, initCount: 0, status: 0 })).toBe('第 1 个分片下载失败：网络连接失败')
    expect(describePlaylistStatus(403)).toBe('服务器拒绝访问（403）')
    expect(describePlaylistStatus(404)).toBe('找不到清单（404）')
    expect(describePlaylistStatus(0, 'too-large')).toBe('清单文件过大，无法解析')
  })
})

describe('体积', () => {
  it('超过 2GB 拒绝，分片多或体积大时只警告', () => {
    const tooBig = assessHlsSize({ segmentCount: 10, durationSeconds: 1000, bandwidth: 20_000_000 })
    expect(tooBig.ok).toBe(false)
    if (!tooBig.ok) expect(tooBig.error).toContain('2GB')

    const exact = assessHlsSize({ segmentCount: 1, durationSeconds: 8, bandwidth: HLS_HARD_BYTE_LIMIT })
    expect(exact.ok).toBe(true)

    const bulky = assessHlsSize({ segmentCount: 10, durationSeconds: 600, bandwidth: 8_000_000 })
    expect(bulky.ok).toBe(true)
    if (bulky.ok) expect(bulky.warning).toContain('内存')

    const many = assessHlsSize({ segmentCount: HLS_WARN_SEGMENT_COUNT, durationSeconds: 0 })
    expect(many.ok).toBe(true)
    if (many.ok) expect(many.warning).toContain(`${HLS_WARN_SEGMENT_COUNT}`)

    const small = assessHlsSize({ segmentCount: 3, durationSeconds: 9, bandwidth: 800_000 })
    expect(small).toEqual({ ok: true, estimatedBytes: expect.any(Number) })

    const audio = mediaDownloadWarning({
      segmentCount: 3,
      durationSeconds: 9,
      bandwidth: 800_000,
      separateAudio: true,
    })
    expect(audio.ok).toBe(true)
    if (audio.ok) expect(audio.warning).toBe(HLS_TEXT.separateAudio)
  })

  it('保存时沿用现有文件名，TS 用 .ts，fMP4 用 .mp4', () => {
    expect(
      buildDownloadFilename({
        title: '示例',
        url: 'https://cdn.example/hls/index.m3u8',
        ext: 'ts',
        index: 2,
      }),
    ).toBe('示例-2.ts')
    expect(
      buildDownloadFilename({
        url: 'https://cdn.example/hls/index.m3u8?token=1',
        ext: 'mp4',
      }),
    ).toBe('index.mp4')
  })
})
