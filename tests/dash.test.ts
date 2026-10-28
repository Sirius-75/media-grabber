/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { DASH_TEXT } from '../src/shared/dash-text'
import { describeDashFetchFailure, fillDashTemplate, parseIsoDuration, parseMpd, planDashDownload } from '../src/shared/dash'

const MANIFEST = 'https://origin.example/dash/master.mpd?token=secret'

function mpd(body: string, extra = ''): string {
  return `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" ${extra}>
  ${body}
</MPD>`
}

describe('DASH 时长', () => {
  it('解析常见的 ISO 时长', () => {
    expect(parseIsoDuration('PT4S')).toBe(4)
    expect(parseIsoDuration('PT10M')).toBe(600)
    expect(parseIsoDuration('PT1H2M3.5S')).toBe(3723.5)
    expect(parseIsoDuration('P1DT2H')).toBe(93600)
    expect(parseIsoDuration('PT')).toBeUndefined()
    expect(parseIsoDuration('nope')).toBeUndefined()
  })
})

describe('DASH 模板', () => {
  it('替换序号、时间和带宽，不认识的占位失败', () => {
    expect(fillDashTemplate('a-$Number%05d$-$Time$-$RepresentationID$-$Bandwidth$.m4s', {
      Number: 3,
      Time: 180000,
      RepresentationID: 'high',
      Bandwidth: 800000,
    })).toBe('a-00003-180000-high-800000.m4s')
    expect(fillDashTemplate('$$', {})).toBe('$')
    expect(fillDashTemplate('$SubNumber$.m4s', { Number: 1 })).toBeUndefined()
  })
})

describe('解析 MPD', () => {
  it('SegmentTemplate 用相对 BaseURL，默认选最高视频，音轨另存', () => {
    const parsed = parseMpd(
      mpd(`
        <BaseURL>media/</BaseURL>
        <Period>
          <AdaptationSet mimeType="video/mp4" contentType="video">
            <SegmentTemplate timescale="1" duration="2" startNumber="1" initialization="init-$RepresentationID$.mp4" media="v-$Number%05d$.m4s"/>
            <Representation id="low" bandwidth="500000" width="640" height="360"/>
            <Representation id="high" bandwidth="2000000" width="1280" height="720"/>
          </AdaptationSet>
          <AdaptationSet mimeType="audio/mp4">
            <SegmentTemplate timescale="1" duration="2" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s"/>
            <Representation id="quiet" bandwidth="64000"/>
            <Representation id="main-audio" bandwidth="128000">
              <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
            </Representation>
          </AdaptationSet>
          <AdaptationSet contentType="text" mimeType="text/vtt">
            <Representation id="subs" bandwidth="1000"/>
          </AdaptationSet>
        </Period>
      `),
      MANIFEST,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.videos.map((track) => track.id)).toEqual(['high', 'low'])
    const plan = planDashDownload(parsed, 'high')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.separateAudio).toBe(true)
    expect(plan.urls).toEqual([
      'https://origin.example/dash/media/init-high.mp4',
      'https://origin.example/dash/media/v-00001.m4s',
      'https://origin.example/dash/media/v-00002.m4s',
      'https://origin.example/dash/media/main-audio/init.mp4',
      'https://origin.example/dash/media/main-audio/1.m4s',
      'https://origin.example/dash/media/main-audio/2.m4s',
    ])
    expect(plan.urls.some((url) => url.includes('token'))).toBe(false)
    expect(plan.warning).toContain('合并')
    expect(plan.warning).toContain('带宽最高')
    expect(plan.files.map((file) => file.ext)).toEqual(['mp4', 'm4a'])
  })

  it('多清晰度时先返回选项，默认顺序是最高在前', () => {
    const parsed = parseMpd(
      mpd(`
        <Period>
          <AdaptationSet mimeType="video/mp4">
            <SegmentTemplate timescale="1" duration="4" initialization="i.mp4" media="$Number$.m4s"/>
            <Representation id="low" bandwidth="1000" width="320" height="180"/>
            <Representation id="high" bandwidth="9000" width="1920" height="1080"/>
          </AdaptationSet>
        </Period>
      `),
      MANIFEST,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const pending = planDashDownload(parsed)
    expect(pending.ok).toBe(true)
    if (!pending.ok) return
    expect(pending.files).toEqual([])
    expect(pending.variants.map((variant) => variant.url)).toEqual(['high', 'low'])
    expect(pending.variants[0]?.label).toContain('1920×1080')
  })

  it('SegmentTimeline 的 $Time$ 和重复次数', () => {
    const parsed = parseMpd(
      mpd(`
        <Period duration="PT3S">
          <AdaptationSet mimeType="video/mp4">
            <Representation id="v" bandwidth="1000">
              <SegmentTemplate timescale="1000" initialization="i.mp4" media="t-$Time$.m4s">
                <SegmentTimeline>
                  <S t="0" d="1000" r="1"/>
                  <S d="500"/>
                </SegmentTimeline>
              </SegmentTemplate>
            </Representation>
          </AdaptationSet>
        </Period>
      `),
      MANIFEST,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = planDashDownload(parsed)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.urls.slice(1)).toEqual([
      'https://origin.example/dash/t-0.m4s',
      'https://origin.example/dash/t-1000.m4s',
      'https://origin.example/dash/t-2000.m4s',
    ])
  })

  it('SegmentList 按列出的地址下载', () => {
    const parsed = parseMpd(
      mpd(`
        <Period>
          <AdaptationSet mimeType="audio/mp4">
            <Representation id="a" bandwidth="96000">
              <SegmentList>
                <Initialization sourceURL="init.mp4"/>
                <SegmentURL media="1.m4s"/>
                <SegmentURL media="https://cdn.example/2.m4s"/>
              </SegmentList>
            </Representation>
          </AdaptationSet>
        </Period>
      `),
      MANIFEST,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = planDashDownload(parsed)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.files[0]?.ext).toBe('m4a')
    expect(plan.urls).toEqual([
      'https://origin.example/dash/init.mp4',
      'https://origin.example/dash/1.m4s',
      'https://cdn.example/2.m4s',
    ])
  })

  it('直播、加密、多 Period、SegmentBase 都拒绝', () => {
    expect(parseMpd('<MPD type="dynamic"><Period/></MPD>', MANIFEST)).toEqual({ ok: false, error: DASH_TEXT.live })
    expect(
      parseMpd(
        mpd(`<Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="v" bandwidth="1"><SegmentTemplate media="a.m4s" initialization="i.mp4" duration="1" timescale="1"/></Representation></AdaptationSet></Period>`),
        MANIFEST,
      ),
    ).toEqual({ ok: false, error: DASH_TEXT.protected })
    expect(parseMpd(mpd('<Period/><Period/>'), MANIFEST)).toEqual({ ok: false, error: DASH_TEXT.multiPeriod })
    expect(
      parseMpd(
        mpd(`<Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"><SegmentBase indexRange="0-99"><Initialization range="0-10"/></SegmentBase></Representation></AdaptationSet></Period>`),
        MANIFEST,
      ),
    ).toEqual({ ok: false, error: DASH_TEXT.segmentBase })
  })

  it('不支持的模板和缺少初始化段会说明原因', () => {
    expect(
      parseMpd(
        mpd(`<Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate initialization="i.mp4" media="$SubNumber$.m4s" duration="4" timescale="1"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`),
        MANIFEST,
      ).ok,
    ).toBe(false)
    const missingInit = parseMpd(
      mpd(`<Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate media="$Number$.m4s" duration="4" timescale="1"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`),
      MANIFEST,
    )
    expect(missingInit).toEqual({ ok: false, error: DASH_TEXT.noInit })
  })

  it('分片失败时能指出是视频还是音频', () => {
    const plan = {
      files: [
        { kind: 'video' as const, ext: 'mp4' as const, mime: 'video/mp4', urls: ['i', 'a', 'b'] },
        { kind: 'audio' as const, ext: 'm4a' as const, mime: 'audio/mp4', urls: ['ai', 'c'] },
      ],
    }
    expect(describeDashFetchFailure(plan, 2, 404)).toBe('视频第 2 个分片缺失（404）')
    expect(describeDashFetchFailure(plan, 3, 404)).toBe('音频初始化段缺失（404）')
    expect(describeDashFetchFailure(plan, 0, 403)).toBe('服务器拒绝访问（403）')
  })

  it('选中的清晰度必须在清单里', () => {
    const parsed = parseMpd(
      mpd(`<Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate initialization="i.mp4" media="$Number$.m4s" duration="4" timescale="1"/><Representation id="only" bandwidth="10"/></AdaptationSet></Period>`),
      MANIFEST,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(planDashDownload(parsed, 'missing')).toEqual({ ok: false, error: DASH_TEXT.variantMissing })
  })
})
