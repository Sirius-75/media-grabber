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
  ivFromMediaSequence,
  mediaDownloadWarning,
  parseAttributeList,
  parseAesIv,
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
    expect(media('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://cdn.example/key"\n#EXTINF:1,\na.ts')).toEqual({
      ok: false,
      error: HLS_TEXT.sampleAes,
    })
    expect(media('#EXT-X-KEY:METHOD=FOO,URI="https://cdn.example/key"\n#EXTINF:1,\na.ts')).toEqual({
      ok: false,
      error: hlsEncryptedText('FOO'),
    })
    expect(media('#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="https://cdn.example/key"\n#EXTINF:1,\na.ts')).toEqual({
      ok: false,
      error: HLS_TEXT.sampleAes,
    })
    expect(media('#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key",KEYFORMAT="org.w3.clearkey"\n#EXTINF:1,\na.ts')).toEqual({
      ok: false,
      error: HLS_TEXT.keyFormat,
    })
    expect(media('#EXT-X-KEY:METHOD=AES-128,URI="skd://x"\n#EXTINF:1,\na.ts')).toEqual({
      ok: false,
      error: HLS_TEXT.drm,
    })
    expect(
      media(
        '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="https://cdn.example/key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:1,\na.ts',
      ),
    ).toEqual({
      ok: false,
      error: HLS_TEXT.drm,
    })
    expect(
      media(
        '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="https://cdn.example/key",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n#EXTINF:1,\na.ts',
      ),
    ).toEqual({
      ok: false,
      error: HLS_TEXT.drm,
    })
    expect(
      media(
        '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key",KEYFORMAT="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"\n#EXTINF:1,\na.ts',
      ),
    ).toEqual({
      ok: false,
      error: HLS_TEXT.drm,
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

    const encrypted = mediaDownloadWarning({
      segmentCount: 2,
      durationSeconds: 4,
      aes128: true,
    })
    expect(encrypted.ok).toBe(true)
    if (encrypted.ok) expect(encrypted.warning).toBe(HLS_TEXT.aes128Note)
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

describe('AES-128 清单', () => {
  const base = 'https://cdn.example/hls/v/index.m3u8?token=abc'

  function bytesOf(value: Uint8Array | undefined): number[] {
    return value ? [...value] : []
  }

  it('密钥轮换、显式 IV、默认 media sequence，以及 METHOD=NONE 之后不再加密', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:9',
      '#EXT-X-KEY:METHOD=AES-128,URI="enc.key",KEYFORMAT="identity"',
      '#EXTINF:2,',
      'a.ts',
      '#EXTINF:2,',
      'b.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k2",IV=0x11',
      '#EXTINF:2,',
      'c.ts',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:2,',
      'd.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="enc.key",KEYFORMAT="Identity"',
      '#EXTINF:2,',
      'e.ts',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const parsed = parseHlsPlaylist(text, base)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'media') return
    expect(parsed.media.aes128).toBe(true)
    expect(parsed.media.container).toBe('ts')
    const segments = parsed.media.segments
    expect(segments.map((segment) => segment.url)).toEqual([
      'https://cdn.example/hls/v/a.ts',
      'https://cdn.example/hls/v/b.ts',
      'https://cdn.example/hls/v/c.ts',
      'https://cdn.example/hls/v/d.ts',
      'https://cdn.example/hls/v/e.ts',
    ])
    expect(segments[0]?.aes128?.keyUrl).toBe('https://cdn.example/hls/v/enc.key')
    expect(bytesOf(segments[0]?.aes128?.iv)).toEqual(bytesOf(ivFromMediaSequence(9)))
    expect(segments[1]?.aes128?.keyUrl).toBe('https://cdn.example/hls/v/enc.key')
    expect(bytesOf(segments[1]?.aes128?.iv)).toEqual(bytesOf(ivFromMediaSequence(10)))
    expect(segments[0]?.aes128?.iv).not.toBe(segments[1]?.aes128?.iv)
    expect(segments[2]?.aes128?.keyUrl).toBe('https://keys.example/k2')
    expect(bytesOf(segments[2]?.aes128?.iv)).toEqual(bytesOf(parseAesIv('0x11')))
    expect(segments[3]?.aes128).toBeUndefined()
    expect(segments[4]?.aes128?.keyUrl).toBe('https://cdn.example/hls/v/enc.key')
    expect(bytesOf(segments[4]?.aes128?.iv)).toEqual(bytesOf(ivFromMediaSequence(13)))
  })

  it('同一条显式 IV 覆盖后面的分片，相对密钥地址不继承清单 query', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/a.key",IV=0X0000000000000000000000000000002A',
      '#EXTINF:1,',
      'a.ts',
      '#EXTINF:1,',
      'b.ts',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const parsed = parseHlsPlaylist(text, base)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'media') return
    expect(parsed.media.segments[0]?.aes128?.keyUrl).toBe('https://cdn.example/hls/v/keys/a.key')
    expect(parsed.media.segments[0]?.aes128?.keyUrl).not.toContain('token')
    const iv = bytesOf(parsed.media.segments[0]?.aes128?.iv)
    expect(iv[15]).toBe(0x2a)
    expect(iv.slice(0, 15).every((part) => part === 0)).toBe(true)
    expect(bytesOf(parsed.media.segments[1]?.aes128?.iv)).toEqual(iv)
  })

  it('主清单里的 SAMPLE-AES 会话密钥仍然拒绝，AES-128 会话密钥不影响选清晰度', () => {
    const sample = [
      '#EXTM3U',
      '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="https://cdn.example/k"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000',
      'media.m3u8',
    ].join('\n')
    expect(parseHlsPlaylist(sample, base)).toEqual({ ok: false, error: HLS_TEXT.sampleAes })
    const allowed = [
      '#EXTM3U',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://cdn.example/k",KEYFORMAT="identity"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000',
      'media.m3u8',
    ].join('\n')
    const parsed = parseHlsPlaylist(allowed, base)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'master') return
    expect(parsed.variants).toHaveLength(1)
  })

  it('EXT-X-SESSION-KEY 的 AES-128 不拿来解密分片', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://cdn.example/preload.key"',
      '#EXTINF:1,',
      'a.ts',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const parsed = parseHlsPlaylist(text, base)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.kind !== 'media') return
    expect(parsed.media.aes128).toBe(false)
    expect(parsed.media.segments[0]?.aes128).toBeUndefined()
  })

  it('带初始化段的 AES-128、坏 IV、非 http 密钥、直播仍然拒绝', () => {
    const end = '#EXT-X-ENDLIST'
    expect(
      parseHlsPlaylist(
        `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/k"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.ts\n${end}\n`,
        base,
      ),
    ).toEqual({ ok: false, error: HLS_TEXT.aesMap })
    expect(
      parseHlsPlaylist(
        `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/k",IV=xyz\n#EXTINF:1,\na.ts\n${end}\n`,
        base,
      ),
    ).toEqual({ ok: false, error: HLS_TEXT.badIv })
    expect(
      parseHlsPlaylist(
        `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:application/octet-stream,abcd"\n#EXTINF:1,\na.ts\n${end}\n`,
        base,
      ),
    ).toEqual({ ok: false, error: HLS_TEXT.badKeyUri })
    expect(
      parseHlsPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/k"\n#EXTINF:1,\na.ts\n', base),
    ).toEqual({ ok: false, error: HLS_TEXT.live })
    expect(
      parseHlsPlaylist(
        `#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:100@0\na.ts\n${end}\n`,
        base,
      ),
    ).toEqual({ ok: false, error: HLS_TEXT.byterange })
  })
})
