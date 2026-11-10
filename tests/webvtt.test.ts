import { describe, expect, it } from 'vitest'
import { SUBTITLE_TEXT, assembleSubtitleFile, mergeWebVttSegments, parseVttTimestamp, webVttToSrt } from '../src/shared/webvtt'
import { readHlsSubtitleSource, shouldShowAutomaticSubtitleError } from '../src/shared/subtitles'
import { DASH_TEXT } from '../src/shared/dash-text'
import { HLS_TEXT } from '../src/shared/hls'

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

  it('MPEGTS 在 33 位回绕后仍接上，不会丢掉后一段', () => {
    const first = (2 ** 33 - 90000).toString()
    const merged = mergeWebVttSegments([
      { text: vtt(`MPEGTS:${first},LOCAL:00:00:00.000`, '00:00:00.000 --> 00:00:01.000\n回绕前'), duration: 2 },
      { text: vtt('MPEGTS:90000,LOCAL:00:00:00.000', '00:00:00.000 --> 00:00:01.000\n回绕后'), duration: 2 },
    ])
    expect(merged).toContain('00:00:00.000 --> 00:00:01.000')
    expect(merged).toContain('回绕前')
    expect(merged).toContain('00:00:02.000 --> 00:00:03.000')
    expect(merged).toContain('回绕后')
  })

  it('写出 VTT 时保留转义和样式标签，SRT 只保留原文里的 i、b、u', () => {
    const source = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n&lt;b&gt;粗体&lt;/b&gt; <i>斜体</i> <c.red>红</c>\n'
    const merged = mergeWebVttSegments([{ text: source }])
    expect(merged).toContain('&lt;b&gt;粗体&lt;/b&gt; <i>斜体</i> <c.red>红</c>')
    const srt = webVttToSrt(merged)
    expect(srt).toContain('&lt;b&gt;粗体&lt;/b&gt; <i>斜体</i> 红')
    expect(srt).not.toContain('<b>')
    expect(srt).not.toContain('<c')
  })

  it('有分片时长时，第一句超过 1 秒的相对时间也会按累计起点顺延', () => {
    const merged = mergeWebVttSegments([
      { text: 'WEBVTT\n\n00:00:01.500 --> 00:00:02.500\nA\n', duration: 4 },
      { text: 'WEBVTT\n\n00:00:01.500 --> 00:00:02.500\nB\n', duration: 4 },
      { text: 'WEBVTT\n\n00:00:01.500 --> 00:00:02.500\nC\n', duration: 4 },
    ])
    expect(merged).toContain('00:00:01.500 --> 00:00:02.500')
    expect(merged).toContain('00:00:05.500 --> 00:00:06.500')
    expect(merged).toContain('00:00:09.500 --> 00:00:10.500')
  })

  it('绝对时间里重复的跨段 cue 不会被顺延复制', () => {
    const cross = '00:00:00.500 --> 00:00:05.000\n跨段'
    const merged = mergeWebVttSegments([
      { text: `WEBVTT\n\n${cross}\n`, duration: 2 },
      { text: `WEBVTT\n\n${cross}\n\n00:00:02.500 --> 00:00:03.500\n后句\n`, duration: 2 },
      { text: `WEBVTT\n\n${cross}\n`, duration: 2 },
    ])
    expect(merged.match(/跨段/g)).toHaveLength(1)
    expect(merged).toContain('00:00:02.500 --> 00:00:03.500')
    expect(merged).toContain('后句')
    expect(merged).not.toContain('00:00:04.500')
  })

  it('TTML 写入 VTT 时重新转义 & < >', () => {
    const xml = `<?xml version="1.0"?><tt><body><div><p begin="00:00:01.000" end="00:00:02.000">A &amp; B &lt; C &gt; D</p></div></body></tt>`
    const file = assembleSubtitleFile({ format: 'vtt', segments: [{ text: xml, kind: 'ttml' }] })
    expect(file.ok).toBe(true)
    if (!file.ok) return
    expect(file.body).toContain('A &amp; B &lt; C &gt; D')
    expect(file.body).not.toContain('A & B')
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
    const wvtt = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4,', 'a.m4s', '#EXT-X-ENDLIST'].join('\n')
    const packed = readHlsSubtitleSource(wvtt, 'https://cdn.example/subs.m3u8')
    expect(packed).toEqual({ ok: false, error: SUBTITLE_TEXT.unsupportedWvtt })
  })

  it('自动检查只展示 DRM、ContentProtection 和字幕格式不支持', () => {
    expect(shouldShowAutomaticSubtitleError(SUBTITLE_TEXT.encrypted)).toBe(true)
    expect(shouldShowAutomaticSubtitleError(DASH_TEXT.protected)).toBe(true)
    expect(shouldShowAutomaticSubtitleError(HLS_TEXT.drm)).toBe(true)
    expect(shouldShowAutomaticSubtitleError(SUBTITLE_TEXT.unsupportedWvtt)).toBe(true)
    expect(shouldShowAutomaticSubtitleError(SUBTITLE_TEXT.unsupportedStpp)).toBe(true)
    expect(shouldShowAutomaticSubtitleError(DASH_TEXT.live)).toBe(false)
    expect(shouldShowAutomaticSubtitleError(HLS_TEXT.byterange)).toBe(false)
    expect(shouldShowAutomaticSubtitleError(HLS_TEXT.variables)).toBe(false)
    expect(shouldShowAutomaticSubtitleError(HLS_TEXT.sampleAes)).toBe(false)
  })
})
