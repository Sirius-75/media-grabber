import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_FILENAME_FALLBACK,
  MAX_DOWNLOAD_QUALITY_LENGTH,
  MAX_DOWNLOAD_STEM_LENGTH,
  buildDownloadFilename,
  formatQualitySuffix,
  sanitizeStem,
} from '../src/shared/filename'

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u2028\u2029]/

describe('sanitizeStem', () => {
  it('去掉 Windows / macOS 非法字符和控制字符', () => {
    expect(sanitizeStem('a\\b/c:d*e?f"g<h>i|j')).toBe('abcdefghij')
    expect(sanitizeStem('hello\u0000world\u0001\u001f')).toBe('helloworld')
    expect(sanitizeStem('a\u007fb\u009fc')).toBe('abc')
    expect(sanitizeStem('行\u2028间\u2029隔')).toBe('行间隔')
    expect(sanitizeStem('  hello   world  ')).toBe('hello world')
    expect(sanitizeStem('...hello...')).toBe('hello')
    expect(sanitizeStem('  ..CON..  ')).toBe('CON')
    expect(sanitizeStem('***')).toBe('')
  })
})

describe('buildDownloadFilename', () => {
  it('优先用页面标题加序号，并补上正确扩展名', () => {
    expect(
      buildDownloadFilename({
        title: '页面',
        url: 'https://cdn.example/clip.webm',
        ext: 'mp4',
        index: 2,
      }),
    ).toBe('页面-2.mp4')
    expect(
      buildDownloadFilename({
        title: '直播.mp4',
        ext: 'mp4',
        index: 1,
      }),
    ).toBe('直播-1.mp4')
  })

  it('标题里的非法字符会被去掉，序号和扩展名还在', () => {
    expect(
      buildDownloadFilename({
        title: '直播/:*?"<>|\\回放\u0000',
        ext: 'mp4',
        index: 4,
      }),
    ).toBe('直播回放-4.mp4')
    const name = buildDownloadFilename({
      title: 'a/b:c*d?e"f<g>h|i',
      ext: 'webm',
      index: 1,
    })
    expect(name).toBe('abcdefghi-1.webm')
    expect(name).not.toMatch(ILLEGAL)
  })

  it('标题不可用时用 URL 文件名，不把目录带进下载路径', () => {
    expect(
      buildDownloadFilename({
        title: ' \n\t*** ',
        url: 'https://cdn.example/path/my%20clip.mp4?x=1#t=2',
        ext: 'mp4',
        index: 3,
      }),
    ).toBe('my clip.mp4')
    expect(buildDownloadFilename({ url: 'https://cdn.example/a/b/c.mp3' })).toBe('c.mp3')
    expect(buildDownloadFilename({ url: 'https://cdn.example/a%2Fb.mp4', ext: 'mp4' })).toBe('ab.mp4')
    expect(buildDownloadFilename({ url: 'https://cdn.example/a%2Fb.mp4', ext: 'mp4' })).not.toMatch(ILLEGAL)
  })

  it('处理保留名，大小写不敏感，普通词不会被误伤', () => {
    const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']
    for (const name of reserved) {
      expect(buildDownloadFilename({ filename: name, ext: 'mp4' })).toBe(`${name}_.mp4`)
    }
    expect(buildDownloadFilename({ url: 'https://cdn.example/NUL.mp3', ext: 'mp3' })).toBe('NUL_.mp3')
    expect(buildDownloadFilename({ url: 'https://cdn.example/con.mp3', ext: 'mp3' })).toBe('con_.mp3')
    expect(buildDownloadFilename({ filename: 'CON.txt', ext: 'mp4' })).toBe('CON_.txt.mp4')
    expect(buildDownloadFilename({ filename: 'COM1.extra.mp4', ext: 'mp4' })).toBe('COM1_.extra.mp4')
    expect(buildDownloadFilename({ filename: 'concerto.mp4', ext: 'mp4' })).toBe('concerto.mp4')
    expect(buildDownloadFilename({ filename: 'null.mp4', ext: 'mp4' })).toBe('null.mp4')
    expect(buildDownloadFilename({ filename: 'com0.mp4', ext: 'mp4' })).toBe('com0.mp4')
    // 加上序号之后不再是保留名，不必再加下划线。
    expect(buildDownloadFilename({ title: 'CON', ext: 'mp4', index: 1 })).toBe('CON-1.mp4')
    expect(buildDownloadFilename({ title: 'C/O/N', ext: 'mp4' })).toBe('CON_.mp4')
    expect(buildDownloadFilename({ title: 'N*U*L', ext: 'm4a' })).toBe('NUL_.m4a')
  })

  it('限制长度，截断时保留扩展名和序号，也不切断 emoji', () => {
    const named = buildDownloadFilename({
      title: '测'.repeat(200),
      ext: 'mp4',
      index: 3,
    })
    expect(named.endsWith('-3.mp4')).toBe(true)
    const stem = named.slice(0, -'.mp4'.length)
    expect(Array.from(stem).length).toBeLessThanOrEqual(MAX_DOWNLOAD_STEM_LENGTH)
    expect(named).not.toMatch(ILLEGAL)

    const emoji = buildDownloadFilename({
      title: '🎬'.repeat(100),
      ext: 'webm',
      index: 12,
    })
    expect(emoji.endsWith('-12.webm')).toBe(true)
    const emojiStem = emoji.slice(0, -'.webm'.length)
    expect(Array.from(emojiStem).length).toBeLessThanOrEqual(MAX_DOWNLOAD_STEM_LENGTH)
    expect(emojiStem).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('消息里自带的文件名会清洗，并换成正确扩展名', () => {
    expect(
      buildDownloadFilename({
        filename: 'dir\\a:b?.mp4',
        title: '页面',
        url: 'https://cdn.example/clip.mp4',
        ext: 'mp4',
        index: 4,
      }),
    ).toBe('ab.mp4')
    expect(buildDownloadFilename({ filename: 'clip.webm', ext: 'mp4' })).toBe('clip.mp4')
    expect(buildDownloadFilename({ filename: '../CON.mp4', ext: 'mp4' })).toBe('CON_.mp4')
    expect(buildDownloadFilename({ filename: '***', title: '备用', ext: 'mp3', index: 2 })).toBe(
      '备用-2.mp3',
    )
  })

  it('什么都没有时用兜底名', () => {
    expect(buildDownloadFilename({})).toBe(DOWNLOAD_FILENAME_FALLBACK)
    expect(buildDownloadFilename({ title: ':::', url: 'https://cdn.example/', ext: 'mp4', index: 1 })).toBe(
      `${DOWNLOAD_FILENAME_FALLBACK}-1.mp4`,
    )
  })

  it('大写扩展名会改成小写，MIME 指定的扩展名盖过 URL', () => {
    expect(buildDownloadFilename({ url: 'https://cdn.example/clip.MP4' })).toBe('clip.mp4')
    expect(buildDownloadFilename({ url: 'https://cdn.example/clip.webm', ext: 'mp4' })).toBe('clip.mp4')
    expect(buildDownloadFilename({ title: '音频', ext: '.M4A', index: 1 })).toBe('音频-1.m4a')
  })
})

describe('formatQualitySuffix', () => {
  it('优先用高度，没有高度时用带宽，都没有就不加', () => {
    expect(formatQualitySuffix({ height: 1080, bandwidth: 4_500_000 })).toBe('1080P')
    expect(formatQualitySuffix({ height: 720 })).toBe('720P')
    expect(formatQualitySuffix({ bandwidth: 4_500_000 })).toBe('4500kbps')
    expect(formatQualitySuffix({ bandwidth: 999 })).toBe('1kbps')
    expect(formatQualitySuffix({})).toBeUndefined()
    expect(formatQualitySuffix({ height: 0, bandwidth: 0 })).toBeUndefined()
    expect(formatQualitySuffix({ height: Number.NaN, bandwidth: -1 })).toBeUndefined()
  })
})

describe('下载文件名里的清晰度后缀', () => {
  it('有清晰度时是「标题-清晰度.扩展名」', () => {
    expect(
      buildDownloadFilename({
        title: '某视频',
        url: 'https://cdn.example/video.mpd',
        ext: 'mp4',
        quality: '1080P',
      }),
    ).toBe('某视频-1080P.mp4')
    expect(
      buildDownloadFilename({
        title: '某视频',
        ext: 'mp4',
        quality: formatQualitySuffix({ bandwidth: 4_500_000 }),
      }),
    ).toBe('某视频-4500kbps.mp4')
  })

  it('没有清晰度时不加后缀，序号仍然可用', () => {
    expect(buildDownloadFilename({ title: '某视频', ext: 'mp4' })).toBe('某视频.mp4')
    expect(buildDownloadFilename({ title: '某视频', ext: 'mp4', index: 2 })).toBe('某视频-2.mp4')
  })

  it('音频用「标题-音频.m4a」', () => {
    expect(
      buildDownloadFilename({
        title: '某视频',
        url: 'https://cdn.example/audio.m4s',
        ext: 'm4a',
        quality: '音频',
      }),
    ).toBe('某视频-音频.m4a')
  })

  it('清晰度里的非法字符会被清洗，且不会太长', () => {
    expect(
      buildDownloadFilename({
        title: '某视频',
        ext: 'mp4',
        quality: '10/80:P',
      }),
    ).toBe('某视频-1080P.mp4')
    const long = buildDownloadFilename({
      title: '某视频',
      ext: 'mp4',
      quality: '超'.repeat(100),
    })
    expect(long.endsWith('.mp4')).toBe(true)
    const stem = long.slice(0, -'.mp4'.length)
    expect(Array.from(stem).length).toBeLessThanOrEqual(MAX_DOWNLOAD_STEM_LENGTH)
    expect(stem).toContain(`-${'超'.repeat(MAX_DOWNLOAD_QUALITY_LENGTH)}`)
  })

  it('长标题截断后仍保留清晰度和扩展名', () => {
    const name = buildDownloadFilename({
      title: '测'.repeat(200),
      ext: 'mp4',
      quality: '1080P',
    })
    expect(name.endsWith('-1080P.mp4')).toBe(true)
    const stem = name.slice(0, -'.mp4'.length)
    expect(Array.from(stem).length).toBeLessThanOrEqual(MAX_DOWNLOAD_STEM_LENGTH)
    expect(name).not.toMatch(ILLEGAL)
  })
})
