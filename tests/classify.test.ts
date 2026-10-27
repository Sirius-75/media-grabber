import { describe, expect, it } from 'vitest'
import { classify, classifyByMime, classifyByUrl, normalizeUrl } from '../src/shared/classify'

const direct = {
  mp4: { kind: 'video', ext: 'mp4', downloadable: true },
  webm: { kind: 'video', ext: 'webm', downloadable: true },
  mp3: { kind: 'audio', ext: 'mp3', downloadable: true },
  m4a: { kind: 'audio', ext: 'm4a', downloadable: true },
  m3u8: {
    kind: 'hls',
    ext: 'm3u8',
    downloadable: false,
    note: 'HLS 清单，可下载未加密的点播',
  },
  mpd: {
    kind: 'dash',
    ext: 'mpd',
    downloadable: false,
    note: 'DASH 清单，可下载未加密的点播',
  },
} as const

describe('classifyByUrl 扩展名', () => {
  it.each(Object.entries(direct))('识别 .%s', (ext, expected) => {
    expect(classifyByUrl(`https://cdn.example/media/file.${ext}`)).toEqual(expected)
    expect(classify(`https://cdn.example/media/file.${ext}`)).toEqual(expected)
  })

  it('去掉 query 和 hash 后再看后缀', () => {
    const url = 'https://cdn.example/dir/movie.mp4?token=abc&file=clip.ts#t=12'
    expect(classifyByUrl(url)).toEqual(direct.mp4)
  })

  it('hash 里的问号不算 query，也不提供扩展名', () => {
    expect(classifyByUrl('https://cdn.example/a.webm#foo?ext=ts')).toEqual(direct.webm)
    expect(classifyByUrl('https://cdn.example/file#video.mp4')).toBeNull()
  })

  it('大写和小写扩展名同等对待', () => {
    expect(classifyByUrl('https://cdn.example/Movie.MP4')).toEqual(direct.mp4)
    expect(classifyByUrl('HTTPS://CDN.Example/A/B.WeBm?Token=AbC#t=1')).toEqual(direct.webm)
    expect(classify('https://cdn.example/SONG.M4A')).toEqual(direct.m4a)
    expect(classifyByUrl('https://cdn.example/list.M3U8?token=ABC')).toEqual(direct.m3u8)
  })

  it('扩展名只出现在 query 里时不命中', () => {
    expect(classifyByUrl('https://cdn.example/get?file=video.mp4')).toBeNull()
    expect(classify('https://cdn.example/stream?format=m3u8')).toBeNull()
  })

  it('多级路径和多重后缀只看最后一段', () => {
    expect(classifyByUrl('https://cdn.example/a/b/archive.tar.mp4')).toEqual(direct.mp4)
    expect(classifyByUrl('https://cdn.example/playlist.m3u8.bak')).toBeNull()
    expect(classifyByUrl('https://cdn.example/file.ts.mp4')).toEqual(direct.mp4)
  })

  it('相对地址同样去掉 query 和 hash', () => {
    expect(classifyByUrl('clip.mp4')).toEqual(direct.mp4)
    expect(classifyByUrl('clip.mp4?x=1')).toEqual(direct.mp4)
    expect(classifyByUrl('clip.mp4#t=1')).toEqual(direct.mp4)
    expect(classifyByUrl('clip.webm?x=1#t=2')).toEqual(direct.webm)
    expect(classifyByUrl('clip.mp3#foo?ext=.ts')).toEqual(direct.mp3)
    expect(classifyByUrl('dir/song.m4a?id=2')).toEqual(direct.m4a)
    expect(classifyByUrl('playlist.m3u8?token=a#row=1')).toEqual(direct.m3u8)
    expect(classifyByUrl('./manifest.mpd')).toEqual(direct.mpd)
  })

  it('空白会被 trim', () => {
    expect(classifyByUrl('  https://cdn.example/a.mp3  ')).toEqual(direct.mp3)
  })

  it('没有扩展名、隐藏文件、末尾的点、未知后缀都不是媒体', () => {
    expect(classifyByUrl('https://cdn.example/stream')).toBeNull()
    expect(classifyByUrl('https://cdn.example/video.mp4/')).toBeNull()
    expect(classifyByUrl('https://cdn.example')).toBeNull()
    expect(classifyByUrl('https://cdn.example/.mp4')).toBeNull()
    expect(classifyByUrl('https://cdn.example/archive.')).toBeNull()
    expect(classifyByUrl('https://cdn.example/readme.txt')).toBeNull()
    expect(classifyByUrl('notes')).toBeNull()
    expect(classify('')).toBeNull()
  })

  it('百分号编码的点、空格和斜线按解码后的文件名判断', () => {
    expect(classifyByUrl('https://cdn.example/a%2Emp4')).toEqual(direct.mp4)
    expect(classifyByUrl('https://cdn.example/my%20video.MP4')).toEqual(direct.mp4)
    expect(classifyByUrl('https://cdn.example/dir%2Fvideo.mp4')).toEqual(direct.mp4)
    expect(classifyByUrl('https://cdn.example/file.mp4%2Fseg.ts')).toBeNull()
  })

  it('非法百分号编码仍按字面后缀判断', () => {
    expect(classifyByUrl('https://cdn.example/100%.mp4')).toEqual(direct.mp4)
    expect(classifyByUrl('100%.mp4')).toEqual(direct.mp4)
  })
})

describe('分片排除', () => {
  it.each(['ts', 'TS', 'm4s', 'M4S'])('排除 .%s', (ext) => {
    expect(classifyByUrl(`https://cdn.example/seg/12.${ext}?x=1#y`)).toBeNull()
    expect(classify(`https://cdn.example/seg/12.${ext}`, 'video/mp4')).toBeNull()
  })

  it('tsx 不是 ts 分片', () => {
    expect(classifyByUrl('https://cdn.example/app.tsx')).toBeNull()
  })

  it('.mp4.ts 是分片，.ts.mp4 是视频', () => {
    expect(classify('https://cdn.example/file.mp4.ts', 'video/mp4')).toBeNull()
    expect(classifyByUrl('https://cdn.example/file.ts.mp4')).toEqual(direct.mp4)
  })
})

describe('classifyByMime', () => {
  it.each([
    ['video/mp4', direct.mp4],
    ['video/webm', direct.webm],
    ['audio/mpeg', direct.mp3],
    ['audio/mp4', direct.m4a],
    ['audio/x-m4a', direct.m4a],
    ['application/vnd.apple.mpegurl', direct.m3u8],
    ['application/x-mpegurl', direct.m3u8],
    ['audio/mpegurl', direct.m3u8],
    ['application/dash+xml', direct.mpd],
  ] as const)('%s', (mime, expected) => {
    expect(classifyByMime(mime)).toEqual({ ...expected, mime })
  })

  it('忽略大小写和参数', () => {
    expect(classifyByMime('  Video/MP4 ; Charset=Binary ')).toEqual({
      ...direct.mp4,
      mime: 'video/mp4',
    })
    expect(classifyByMime('audio/mp4; codecs="mp4a.40.2"')).toEqual({
      ...direct.m4a,
      mime: 'audio/mp4',
    })
    expect(classifyByMime('application/dash+xml;charset=utf-8')).toEqual({
      ...direct.mpd,
      mime: 'application/dash+xml',
    })
    expect(
      classifyByMime('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
    ).toEqual({ ...direct.mp4, mime: 'video/mp4' })
  })

  it('audio/mpeg 与 audio/mpegurl 不会互相吞掉', () => {
    expect(classifyByMime('audio/mpeg')?.ext).toBe('mp3')
    expect(classifyByMime('audio/mpegurl')?.kind).toBe('hls')
  })

  it('空字符串、无斜线、未列入名单的类型都不命中', () => {
    expect(classifyByMime('')).toBeNull()
    expect(classifyByMime('   ')).toBeNull()
    expect(classifyByMime('notamime')).toBeNull()
    expect(classifyByMime(';charset=utf-8')).toBeNull()
    expect(classifyByMime('text/html')).toBeNull()
    expect(classifyByMime('video/mp4x')).toBeNull()
    expect(classifyByMime('application/octet-stream')).toBeNull()
    expect(classifyByMime('video/mp2t')).toBeNull()
  })
})

describe('classify 冲突时以 Content-Type 为准', () => {
  it('种类冲突时采用 MIME', () => {
    expect(classify('https://cdn.example/a.mp4', 'audio/mpeg')).toEqual({
      ...direct.mp3,
      mime: 'audio/mpeg',
    })
    expect(classify('https://cdn.example/a.mp3', 'application/dash+xml')).toEqual({
      ...direct.mpd,
      mime: 'application/dash+xml',
    })
    expect(classify('https://cdn.example/a.m3u8', 'video/mp4')).toEqual({
      ...direct.mp4,
      mime: 'video/mp4',
    })
    expect(classify('https://cdn.example/a.mp4', 'application/vnd.apple.mpegurl')).toEqual({
      ...direct.m3u8,
      mime: 'application/vnd.apple.mpegurl',
    })
  })

  it('种类相同但容器不同时也采用 MIME', () => {
    expect(classify('https://cdn.example/a.mp4', 'video/webm')).toEqual({
      ...direct.webm,
      mime: 'video/webm',
    })
    expect(classify('https://cdn.example/a.mp4', 'audio/mp4')).toEqual({
      ...direct.m4a,
      mime: 'audio/mp4',
    })
  })

  it('两边一致时保留规范化 MIME', () => {
    expect(classify('https://cdn.example/a.MP4?x=1#t=1', 'video/mp4')).toEqual({
      ...direct.mp4,
      mime: 'video/mp4',
    })
  })

  it('MIME 未命中时退回扩展名，不把无关类型写进结果', () => {
    expect(classify('https://cdn.example/a.mp4', 'application/octet-stream')).toEqual(direct.mp4)
    expect(classify('https://cdn.example/a.webm', '   ')).toEqual(direct.webm)
    expect(classify('https://cdn.example/a.mp3', null)).toEqual(direct.mp3)
    expect(classify('https://cdn.example/a.m4a', 'not a mime')).toEqual(direct.m4a)
  })

  it('只有 MIME 命中时也能识别没有后缀的地址', () => {
    expect(classify('https://cdn.example/stream', 'audio/x-m4a')).toEqual({
      ...direct.m4a,
      mime: 'audio/x-m4a',
    })
    expect(classify('./playlist', 'application/x-mpegurl')).toEqual({
      ...direct.m3u8,
      mime: 'application/x-mpegurl',
    })
  })

  it('两边都未命中时返回 null', () => {
    expect(classify('https://cdn.example/stream', 'text/html')).toBeNull()
    expect(classify('https://cdn.example/file.txt', 'application/octet-stream')).toBeNull()
  })
})

describe('blob 和 data', () => {
  it('blob 不可直接下载', () => {
    expect(classifyByUrl('blob:https://example.com/550e8400-e29b-41d4-a716-446655440000')).toEqual({
      downloadable: false,
      note: 'blob 地址，无法直接下载',
    })
    expect(classify('  BLOB:https://example.com/id  ')).toEqual({
      downloadable: false,
      note: 'blob 地址，无法直接下载',
    })
  })

  it('blob 看起来像分片时仍然标成不可下载，而不是丢弃', () => {
    expect(classify('blob:https://example.com/segment.ts')).toEqual({
      downloadable: false,
      note: 'blob 地址，无法直接下载',
    })
  })

  it('调用方传入的 MIME 可以补上种类，但 blob 依然不能下载', () => {
    expect(classify('blob:https://example.com/id', 'video/webm')).toEqual({
      ...direct.webm,
      mime: 'video/webm',
      downloadable: false,
      note: 'blob 地址，无法直接下载',
    })
    expect(classify('blob:https://example.com/id', 'application/vnd.apple.mpegurl')).toEqual({
      kind: 'hls',
      ext: 'm3u8',
      mime: 'application/vnd.apple.mpegurl',
      downloadable: false,
      note: 'blob 地址，无法直接下载',
    })
  })

  it('blob 上无法识别的 MIME 不猜测种类', () => {
    expect(classify('blob:https://example.com/id', 'text/html')).toEqual({
      downloadable: false,
      note: 'blob 地址，无法直接下载',
    })
    expect(classify('blob:https://example.com/id', null)).toEqual({
      downloadable: false,
      note: 'blob 地址，无法直接下载',
    })
  })

  it('data 不可直接下载，头部里的 MIME 用来判断种类', () => {
    expect(classifyByUrl('data:video/mp4;base64,AAAA')).toEqual({
      ...direct.mp4,
      mime: 'video/mp4',
      downloadable: false,
      note: 'data 地址，无法直接下载',
    })
    expect(classify('DATA:audio/mpeg;base64,//uQ')).toEqual({
      ...direct.mp3,
      mime: 'audio/mpeg',
      downloadable: false,
      note: 'data 地址，无法直接下载',
    })
    expect(classify('data:application/dash+xml,<?xml')).toEqual({
      ...direct.mpd,
      mime: 'application/dash+xml',
      downloadable: false,
      note: 'data 地址，无法直接下载',
    })
  })

  it('data 没有媒体类型时只标注不可下载', () => {
    expect(classify('data:,hello')).toEqual({
      downloadable: false,
      note: 'data 地址，无法直接下载',
    })
    expect(classifyByUrl('data:;base64,AAAA')).toEqual({
      downloadable: false,
      note: 'data 地址，无法直接下载',
    })
    expect(classify('data:text/plain,hello')).toEqual({
      downloadable: false,
      note: 'data 地址，无法直接下载',
    })
  })

  it('没有逗号的 data URL 只解析头部', () => {
    expect(classify('data:video/webm')).toEqual({
      ...direct.webm,
      mime: 'video/webm',
      downloadable: false,
      note: 'data 地址，无法直接下载',
    })
  })

  it('显式 MIME 优先于 data 头部；显式值无法识别时再用头部', () => {
    expect(classify('data:audio/mpeg;base64,xx', 'video/webm')).toEqual({
      ...direct.webm,
      mime: 'video/webm',
      downloadable: false,
      note: 'data 地址，无法直接下载',
    })
    expect(classify('data:video/mp4;base64,xx', 'text/html')).toEqual({
      ...direct.mp4,
      mime: 'video/mp4',
      downloadable: false,
      note: 'data 地址，无法直接下载',
    })
  })
})

describe('normalizeUrl', () => {
  it('去掉 hash，保留 query', () => {
    expect(normalizeUrl('https://cdn.example/a.mp4?x=1&y=2#t=3')).toBe(
      'https://cdn.example/a.mp4?x=1&y=2',
    )
    expect(normalizeUrl('https://cdn.example/a.mp4#')).toBe('https://cdn.example/a.mp4')
  })

  it('协议和主机名小写，并去掉默认端口', () => {
    expect(normalizeUrl('HTTP://Example.COM/A.mp4#x')).toBe('http://example.com/A.mp4')
    expect(normalizeUrl('https://Example.COM:443/A.mp4#x')).toBe('https://example.com/A.mp4')
    expect(normalizeUrl('HTTP://Example.COM:443/A.mp4#x')).toBe('http://example.com:443/A.mp4')
  })

  it('保留用户信息、IPv6 和路径大小写', () => {
    expect(normalizeUrl('https://user:pass@Example.com/A/B.mp4#h')).toBe(
      'https://user:pass@example.com/A/B.mp4',
    )
    expect(normalizeUrl('http://[2001:db8::1]/a.mp4#x')).toBe('http://[2001:db8::1]/a.mp4')
  })

  it('裸主机补上斜线，已有斜线保持不变', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com/')
    expect(normalizeUrl('http://example.com/')).toBe('http://example.com/')
  })

  it('blob 和 data 也能去掉 hash', () => {
    expect(normalizeUrl('blob:https://example.com/uuid#t=1')).toBe('blob:https://example.com/uuid')
    expect(normalizeUrl('data:video/mp4;base64,AAAA')).toBe('data:video/mp4;base64,AAAA')
  })

  it('路径里的空格会被编码，解析不了时只去掉 hash', () => {
    expect(normalizeUrl('http://example.com/a b.mp4?x=1#t=2')).toBe(
      'http://example.com/a%20b.mp4?x=1',
    )
    expect(normalizeUrl('not a url#frag')).toBe('not a url')
    expect(normalizeUrl('not a url')).toBe('not a url')
    expect(normalizeUrl('/dir/A.mp4?x=1#t=2')).toBe('/dir/A.mp4?x=1')
    expect(normalizeUrl('clip.mp4?x=1#t=2')).toBe('clip.mp4?x=1')
  })

  it('空白和空字符串', () => {
    expect(normalizeUrl('   ')).toBe('')
    expect(normalizeUrl('')).toBe('')
    expect(normalizeUrl('  https://cdn.example/a.mp4#t  ')).toBe('https://cdn.example/a.mp4')
  })
})
