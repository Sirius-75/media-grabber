/**
 * 示例数据。不是真实页面，也不是真实 CDN 响应。
 * 地址只用来检查解析和去重，不能拿去请求。
 */
import { describe, expect, it } from 'vitest'
import {
  BILIBILI_FILE_NOTE,
  BILIBILI_M4S_LABEL,
  BILIBILI_NOTE,
  BILIBILI_TEXT,
  BILIBILI_UNKNOWN_NOTE,
  audioTrackLabel,
  bilibiliM4sItem,
  canonicalBilibiliM4sUrl,
  parsePlayinfoScripts,
  planBilibiliFiles,
  videoTrackLabel,
} from '../src/shared/bilibili'

const PAGE_SCRIPT = `
  var unused = { backupUrl: "https://cdn.example.test/not-playinfo.m4s" };
  window.__playinfo__ = {
    "data": {
      "accept_quality": [80, 64],
      "accept_description": ["1080P", "720P"],
      "dash": {
        "video": [
          {
            "id": 80,
            "baseUrl": "https://upos-example.bilivideo.com/example-data/video-1080.m4s?token=sample",
            "backupUrl": ["https://backup.example.test/example-data/should-not-list.m4s"],
            "bandwidth": 2500000,
            "codecs": "avc1.640032",
            "width": 1920,
            "height": 1080
          },
          {
            "id": 64,
            "base_url": "https://upos-example.bilivideo.com/example-data/video-720.m4s",
            "codecs": "hev1.1.6.L120.90",
            "width": 1280,
            "height": 720
          }
        ],
        "audio": [
          {
            "id": 30280,
            "baseUrl": "https://upos-example.bilivideo.com/example-data/audio-hi.m4s",
            "backup_url": ["https://backup.example.test/example-data/audio-backup.m4s"],
            "bandwidth": 192000,
            "codecs": "mp4a.40.2"
          },
          {
            "id": 30216,
            "baseUrl": "https://upos-example.bilivideo.com/example-data/audio-lo.m4s",
            "bandwidth": 64000
          }
        ]
      }
    }
  };
`

describe('playinfo 解析（示例数据）', () => {
  it('读出视频和音频，画质文字来自 accept_description，不列出 backupUrl', () => {
    const tracks = parsePlayinfoScripts([PAGE_SCRIPT])
    expect(tracks.map((track) => track.label)).toEqual([
      'B站视频 1080P · AVC',
      'B站视频 720P · HEVC',
      'B站音频 192kbps',
      'B站音频 64kbps',
    ])
    expect(tracks.map((track) => track.url)).toEqual([
      'https://upos-example.bilivideo.com/example-data/video-1080.m4s?token=sample',
      'https://upos-example.bilivideo.com/example-data/video-720.m4s',
      'https://upos-example.bilivideo.com/example-data/audio-hi.m4s',
      'https://upos-example.bilivideo.com/example-data/audio-lo.m4s',
    ])
    expect(tracks[0]).toMatchObject({
      role: 'video',
      ext: 'm4s',
      qualityId: 80,
      bandwidth: 2500000,
      width: 1920,
      height: 1080,
      codecs: 'avc1.640032',
    })
    expect(tracks[2]).toMatchObject({ role: 'audio', bandwidth: 192000 })
    expect(JSON.stringify(tracks)).not.toContain('should-not-list')
    expect(JSON.stringify(tracks)).not.toContain('audio-backup')
  })

  it('缺字段时能列的仍列出，缺地址的丢掉', () => {
    const source = `window.__playinfo__ = ${JSON.stringify({
      data: {
        dash: {
          video: [
            { id: 16, baseUrl: 'https://cdn.example.test/example-data/only-url.m4s' },
            { id: 32, width: 640, height: 360 },
            { base_url: 'https://cdn.example.test/example-data/no-id.m4s', codecs: 'vp09.00.10.08' },
          ],
          audio: [{ baseUrl: 'https://cdn.example.test/example-data/silent.m4s' }, { bandwidth: 128000 }],
        },
      },
    })}`
    expect(parsePlayinfoScripts([source]).map((track) => track.label)).toEqual([
      'B站视频 画质 16',
      'B站视频 · VP9',
      'B站音频',
    ])
  })

  it('坐标格式不对、不是对象、JSON 坏了都忽略，不抛错', () => {
    const scripts = [
      'window.__playinfo__ = "示例"',
      'window.__playinfo__ = [1, 2, 3];',
      'window.__playinfo__ = { "data": { "dash": { "video": "nope", "audio": {} } } };',
      'window.__playinfo__ = { "data": { "dash": { "video": [{ "baseUrl": "ftp://cdn.example.test/a.m4s" }] } } };',
      'window.__playinfo__ = { "broken": ',
      'var x = 1;',
    ]
    expect(parsePlayinfoScripts(scripts)).toEqual([])
  })

  it('多个 script 合并，同一地址只留第一条，字符串里的括号不影响截取', () => {
    const first = `window.__playinfo__ = ${JSON.stringify({
      data: {
        accept_quality: [80],
        accept_description: ['1080P'],
        dash: {
          video: [
            {
              id: 80,
              baseUrl: 'https://cdn.example.test/example-data/same.m4s',
              codecs: 'avc1.640028',
            },
          ],
        },
      },
    })};`
    const second = `
      window.__playinfo__ = { "note": "字符串里的 } 和 { 不能截断", "data": { "dash": {
        "video": [{ "id": 32, "baseUrl": "https://cdn.example.test/example-data/second.m4s", "width": 640, "height": 360 }],
        "audio": [{ "baseUrl": "https://cdn.example.test/example-data/same.m4s", "bandwidth": 128000 }]
      } } };
      window.__playinfo__ = { "data": { "dash": { "audio": [
        { "baseUrl": "https://cdn.example.test/example-data/extra-audio.m4s", "bandwidth": 320000 }
      ] } } };
    `
    const tracks = parsePlayinfoScripts(['<script>无标记</script>', first, second])
    expect(tracks.map((track) => track.url)).toEqual([
      'https://cdn.example.test/example-data/same.m4s',
      'https://cdn.example.test/example-data/second.m4s',
      'https://cdn.example.test/example-data/extra-audio.m4s',
    ])
    expect(tracks[0]?.role).toBe('video')
    expect(tracks[0]?.label).toBe('B站视频 1080P · AVC')
  })

  it('accept_description 和 id 对不齐时退回分辨率或画质号', () => {
    expect(videoTrackLabel({ width: 854, height: 480, codecs: 'av01.0.05M.08' })).toBe('B站视频 854×480 · AV1')
    expect(videoTrackLabel({})).toBe('B站视频')
    expect(audioTrackLabel(500)).toBe('B站音频 500bps')
    expect(audioTrackLabel(undefined)).toBe('B站音频')
  })

  it('老式 durl 只收 mp4，flv 忽略，也不读 backup_url', () => {
    const source = `window.__playinfo__ = ${JSON.stringify({
      data: {
        durl: [
          { url: 'https://cdn.example.test/example-data/old.flv', backup_url: ['https://cdn.example.test/example-data/old-backup.mp4'] },
          { url: 'https://cdn.example.test/example-data/old.mp4?deadline=1' },
          { url: 'https://cdn.example.test/example-data/old.MP4' },
        ],
      },
    })}`
    const tracks = parsePlayinfoScripts([source])
    expect(tracks).toMatchObject([
      { url: 'https://cdn.example.test/example-data/old.mp4?deadline=1', role: 'file', ext: 'mp4', label: 'B站视频' },
      { url: 'https://cdn.example.test/example-data/old.MP4', role: 'file', ext: 'mp4' },
    ])
    expect(JSON.stringify(tracks)).not.toContain('backup')
    expect(JSON.stringify(tracks)).not.toContain('.flv')
  })
})

describe('m4s 兜底地址（示例数据）', () => {
  const file = 'https://upos-example.bilivideo.com/example-data/clip.m4s?deadline=9&platform=pc'

  it('去掉字节范围 query，保留签名类参数', () => {
    expect(canonicalBilibiliM4sUrl(`${file}&range=0-1023#t=1`)).toBe(file)
    expect(canonicalBilibiliM4sUrl(`${file}&bytes=1024-2047`)).toBe(file)
    expect(canonicalBilibiliM4sUrl(`${file}&start=0&end=99`)).toBe(file)
    expect(canonicalBilibiliM4sUrl(`${file}&range=not-a-byte-range`)).toBe(`${file}&range=not-a-byte-range`)
    expect(canonicalBilibiliM4sUrl('https://cdn.example.test/seg/1.m4s')).toBeUndefined()
    expect(canonicalBilibiliM4sUrl('https://upos-example.bilivideo.cn/example-data/a.m4s')).toBe(
      'https://upos-example.bilivideo.cn/example-data/a.m4s',
    )
  })

  it('206 只记一条，大小用 Content-Range 的总长度，类型标成未知', () => {
    const item = bilibiliM4sItem({
      url: `${file}&range=0-1023`,
      tabId: 4,
      statusCode: 206,
      responseHeaders: [
        { name: 'Content-Type', value: 'video/mp4' },
        { name: 'Content-Length', value: '1024' },
        { name: 'Content-Range', value: 'bytes 0-1023/4096' },
      ],
      timeStamp: 50,
    })
    expect(item).toMatchObject({
      url: file,
      ext: 'm4s',
      size: 4096,
      downloadable: false,
      note: BILIBILI_UNKNOWN_NOTE,
      firstSeen: 50,
      bilibili: { role: 'unknown', label: BILIBILI_M4S_LABEL },
    })
    expect(item?.note).toContain('类型未知')
    expect(
      bilibiliM4sItem({
        url: 'https://cdn.example.test/seg/1.m4s',
        tabId: 4,
        statusCode: 200,
      }),
    ).toBeNull()
  })
})

describe('下载文件选择（示例数据）', () => {
  const video = {
    url: 'https://cdn.example.test/example-data/v.m4s',
    bilibili: { role: 'video' as const, label: 'B站视频 1080P · AVC' },
  }
  const quiet = {
    url: 'https://cdn.example.test/example-data/a-lo.m4s',
    bilibili: { role: 'audio' as const, label: 'B站音频 64kbps', bandwidth: 64000 },
  }
  const loud = {
    url: 'https://cdn.example.test/example-data/a-hi.m4s',
    bilibili: { role: 'audio' as const, label: 'B站音频 192kbps', bandwidth: 192000 },
  }

  it('组合下载带上带宽最高的音频', () => {
    expect(planBilibiliFiles([video, quiet, loud], video.url, true)).toEqual({
      ok: true,
      files: [
        { url: video.url, role: 'video' },
        { url: loud.url, role: 'audio' },
      ],
    })
    expect(planBilibiliFiles([video], video.url, false)).toEqual({
      ok: true,
      files: [{ url: video.url, role: 'video' }],
    })
  })

  it('没有音频时组合下载失败，单下音频不再附带另一条', () => {
    expect(planBilibiliFiles([video], video.url, true)).toEqual({ ok: false, error: BILIBILI_TEXT.noAudio })
    expect(planBilibiliFiles([loud, quiet], loud.url, true)).toEqual({
      ok: true,
      files: [{ url: loud.url, role: 'audio' }],
    })
  })

  it('页面轨和直链的说明分开写', () => {
    expect(BILIBILI_NOTE).toContain('分开保存')
    expect(BILIBILI_FILE_NOTE).toContain('刷新页面')
  })
})
