import { describe, expect, it } from 'vitest'
import { assembleSubtitleFile, mergeWebVttSegments, parseVttTimestamp, webVttToSrt } from '../src/shared/webvtt'
import { readHlsSubtitleSource } from '../src/shared/subtitles'

function vtt(map: string, cue: string): string {
  return `WEBVTT\nX-TIMESTAMP-MAP=${map}\n\n${cue}\n`
}

describe('WebVTT 时间戳映射', () => {
  it('用第一段的 MPEGTS 当 0 点，后面的分片保持相对间隔', () => {
    const merged = mergeWebVttSegments([
      {
        text: vtt('MPEGTS:900000,LOCAL:00:00:00.000', '00:00:01.000 --> 00:00:02.000\n第一句'),
        duration: 10,
      },
      {
        text: vtt('LOCAL:00:00:00.000,MPEGTS:1800000', '00:00:01.000 --> 00:00:03.500\n第二句'),
        duration: 10,
      },
    ])
    expect(merged).toContain('00:00:01.000 --> 00:00:02.000')
    expect(merged).toContain('第一句')
    expect(merged).toContain('00:00:11.000 --> 00:00:13.500')
    expect(merged).toContain('第二句')
    expect(merged.startsWith('WEBVTT')).toBe(true)
    expect(merged).not.toContain('X-TIMESTAMP-MAP')
  })

  it('没有映射、cue 从 0 重新开始时按分片时长顺延', () => {
    const merged = mergeWebVttSegments([
      { text: 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nA\n', duration: 4 },
      { text: 'WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nB\n', duration: 4 },
    ])
    expect(merged).toContain('00:00:00.000 --> 00:00:02.000')
    expect(merged).toContain('00:00:04.500 --> 00:00:05.500')
  })

  it('已经是绝对时间的 cue 不会再被顺延', () => {
    const merged = mergeWebVttSegments([
      { text: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA\n', duration: 4 },
      { text: 'WEBVTT\n\n00:00:10.000 --> 00:00:11.000\nB\n', duration: 4 },
    ])
    expect(merged).toContain('00:00:10.000 --> 00:00:11.000')
    expect(merged).not.toContain('00:00:14.000')
  })

  it('可以转成 SRT，毫秒用逗号', () => {
    const vttText = mergeWebVttSegments([
      { text: vtt('MPEGTS:90000,LOCAL:00:00:00.000', '00:00:01.200 --> 00:00:02.000 align:middle\n你好') },
    ])
    const srt = webVttToSrt(vttText)
    expect(srt).toBe('1\n00:00:01,200 --> 00:00:02,000\n你好\n')
  })

  it('TTML 分片合成后再按选择输出 vtt 或 srt', () => {
    const xml = `<?xml version="1.0"?><tt><body><div><p begin="00:00:01.000" end="00:00:02.000">你好</p></div></body></tt>`
    const vttFile = assembleSubtitleFile({ format: 'vtt', segments: [{ text: xml, kind: 'ttml' }] })
    expect(vttFile.ok).toBe(true)
    if (!vttFile.ok) return
    expect(vttFile.ext).toBe('vtt')
    expect(vttFile.body).toContain('00:00:01.000 --> 00:00:02.000')
    expect(vttFile.body).toContain('你好')
    const srtFile = assembleSubtitleFile({ format: 'srt', segments: [{ text: xml, kind: 'ttml' }] })
    expect(srtFile.ok).toBe(true)
    if (!srtFile.ok) return
    expect(srtFile.body).toContain('00:00:01,000 --> 00:00:02,000')
  })

  it('解析时分秒', () => {
    expect(parseVttTimestamp('00:01.250')).toBe(1250)
    expect(parseVttTimestamp('01:00:01.250')).toBe(3601250)
    expect(parseVttTimestamp('nope')).toBeUndefined()
  })
})

describe('HLS 字幕清单', () => {
  it('点播分片可以读，加密和直播拒绝', () => {
    const vod = ['#EXTM3U', '#EXTINF:4,', 'a.vtt', '#EXTINF:4,', 'b.vtt', '#EXT-X-ENDLIST'].join('\n')
    const parsed = readHlsSubtitleSource(vod, 'https://cdn.example/subs.m3u8')
    expect(parsed).toEqual({
      ok: true,
      kind: 'media',
      segments: [
        { url: 'https://cdn.example/a.vtt', duration: 4 },
        { url: 'https://cdn.example/b.vtt', duration: 4 },
      ],
    })
    const file = readHlsSubtitleSource('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n', 'https://cdn.example/en.vtt')
    expect(file).toEqual({ ok: true, kind: 'file' })
    const encrypted = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key"',
      '#EXTINF:4,',
      'a.vtt',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const blocked = readHlsSubtitleSource(encrypted, 'https://cdn.example/subs.m3u8')
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.error).toContain('加密')
    const live = ['#EXTM3U', '#EXTINF:4,', 'a.vtt'].join('\n')
    const liveResult = readHlsSubtitleSource(live, 'https://cdn.example/subs.m3u8')
    expect(liveResult.ok).toBe(false)
    if (liveResult.ok) return
    expect(liveResult.error).toContain('直播')
  })
})
