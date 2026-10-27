/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../src/shared/types'
import { normalizeUrl } from '../src/shared/classify'
import {
  BUTTON_FLASH_MS,
  bindListActions,
  canOfferDashDownload,
  canOfferDownload,
  canOfferHlsDownload,
  hlsJobForItem,
  downloadFeedback,
  flashButton,
  isMediaItemList,
  itemNote,
  kindLabel,
  renderList,
  setRowStatus,
  statusForItem,
  statusFromDownloadResponse,
  truncateUrl,
} from '../src/popup/view'

function item(overrides: Partial<MediaItem> & Pick<MediaItem, 'url' | 'kind'>): MediaItem {
  return {
    sources: ['dom'],
    downloadable: true,
    firstSeen: 1,
    ...overrides,
  }
}

const video = item({
  url: 'https://cdn.example/videos/clip.mp4',
  kind: 'video',
  ext: 'mp4',
  size: 1536,
})

const audio = item({
  url: 'https://cdn.example/a.mp3',
  kind: 'audio',
  ext: 'mp3',
})

const hls = item({
  url: 'https://cdn.example/live/index.m3u8?token=1',
  kind: 'hls',
  ext: 'm3u8',
  downloadable: false,
  note: 'HLS 清单，可下载未加密的点播',
})

const dash = item({
  url: 'https://cdn.example/manifest.mpd',
  kind: 'dash',
  ext: 'mpd',
  downloadable: false,
})

const blobVideo = item({
  url: 'blob:https://example.com/8c2c6c0e-1111-2222-3333-abcdefabcdef',
  kind: 'video',
  downloadable: false,
  note: 'blob 地址，无法直接下载',
})

const dataAudio = item({
  url: 'data:audio/mpeg;base64,AAAA',
  kind: 'audio',
  downloadable: false,
})

describe('展示文案', () => {
  it('类型用中文标签，大小缺失时交给 formatBytes 显示未知', () => {
    expect(kindLabel('video')).toBe('视频')
    expect(kindLabel('audio')).toBe('音频')
    expect(kindLabel('hls')).toBe('HLS')
    expect(kindLabel('dash')).toBe('DASH')
  })

  it('长地址从中间截断，短地址保持原样', () => {
    expect(truncateUrl('https://cdn.example/a.mp4')).toBe('https://cdn.example/a.mp4')
    const long = `https://cdn.example.com/videos/${'very-long-path/'.repeat(6)}flower.mp4`
    const shown = truncateUrl(long)
    expect(shown.length).toBe(52)
    expect(shown.startsWith('https://cdn.example.com/')).toBe(true)
    expect(shown.endsWith('flower.mp4')).toBe(true)
    expect(shown).toContain('…')
    expect(truncateUrl('   https://cdn.example/a.mp4  ')).toBe('https://cdn.example/a.mp4')
  })

  it('只有可下载的直链才显示下载按钮', () => {
    expect(canOfferDownload(video)).toBe(true)
    expect(canOfferDownload(audio)).toBe(true)
    expect(canOfferDownload(hls)).toBe(false)
    expect(canOfferDownload(dash)).toBe(false)
    expect(canOfferDownload(blobVideo)).toBe(false)
    expect(canOfferDownload(dataAudio)).toBe(false)
    expect(canOfferDownload({ ...video, downloadable: false })).toBe(false)
    expect(canOfferDownload({ ...hls, downloadable: true })).toBe(false)
    expect(
      canOfferDownload({
        ...video,
        url: 'blob:https://example.com/1',
        downloadable: true,
      }),
    ).toBe(false)
    expect(canOfferDownload({ ...audio, url: 'data:audio/mpeg;base64,AA', downloadable: true })).toBe(
      false,
    )
    expect(canOfferHlsDownload(hls)).toBe(true)
    expect(canOfferHlsDownload(dash)).toBe(false)
    expect(canOfferHlsDownload(video)).toBe(false)
    expect(canOfferHlsDownload({ ...hls, url: 'blob:https://example.com/1' })).toBe(false)
  })

  it('不可下载的条目带说明，直链没有多余说明', () => {
    expect(itemNote(video)).toBeUndefined()
    expect(itemNote(hls)).toBe('HLS 清单，可下载未加密的点播')
    expect(itemNote(dash)).toBe('DASH 清单，可下载未加密的点播')
    expect(canOfferDashDownload(dash)).toBe(true)
    expect(canOfferDashDownload(hls)).toBe(false)
    expect(canOfferDashDownload({ ...dash, url: 'blob:https://example.com/1' })).toBe(false)
    expect(itemNote(blobVideo)).toBe('blob 地址，无法直接下载')
    expect(itemNote(dataAudio)).toBe('data 地址，无法直接下载')
    expect(itemNote({ ...video, downloadable: false, note: undefined })).toBe('无法直接下载')
    expect(itemNote({ ...blobVideo, note: '  ' })).toBe('blob 地址，无法直接下载')
  })

  it('下载回复：成功是已开始下载，短原因留在按钮上，长原因收成下载失败', () => {
    expect(downloadFeedback({ ok: true, downloadId: 4 })).toBe('已开始下载')
    expect(downloadFeedback({ ok: false, error: '网络连接失败' })).toBe('网络连接失败')
    expect(downloadFeedback({ ok: false, error: '服务器拒绝访问（403）' })).toBe('服务器拒绝访问（403）')
    expect(downloadFeedback({ ok: false, error: '  网络拒绝了这次下载请求，请稍后再试  ' })).toBe(
      '下载失败',
    )
    expect(downloadFeedback(undefined)).toBe('下载失败')
    expect(downloadFeedback({ ok: false })).toBe('下载失败')
    expect(statusFromDownloadResponse({ ok: true, downloadId: 4 })).toEqual({
      phase: 'started',
      message: '已开始下载',
      downloadId: 4,
    })
    expect(statusFromDownloadResponse({ ok: false, error: '  服务器拒绝访问（403）  ' })).toEqual({
      phase: 'failed',
      message: '服务器拒绝访问（403）',
    })
  })

  it('只接受像 MediaItem 的数组', () => {
    expect(isMediaItemList([video, hls])).toBe(true)
    expect(isMediaItemList([])).toBe(true)
    expect(isMediaItemList(null)).toBe(false)
    expect(isMediaItemList({ items: [video] })).toBe(false)
    expect(isMediaItemList([{ url: 'https://cdn.example/a.mp4' }])).toBe(false)
  })
})

describe('列表', () => {
  it('复制拿到完整链接；HLS 和 DASH 各有下载按钮，blob、data 没有', () => {
    const blocked = item({
      url: 'https://cdn.example/locked.mp4',
      kind: 'video',
      downloadable: false,
    })
    const items = [video, audio, hls, dash, blobVideo, dataAudio, blocked]
    const list = document.createElement('ul')
    renderList(list, items)

    const copied: string[] = []
    const downloads: string[] = []
    bindListActions(list, () => items, {
      onCopy(url) {
        copied.push(url)
      },
      onDownload(url) {
        downloads.push(url)
      },
    })

    const copyButtons = [...list.querySelectorAll<HTMLButtonElement>('[data-action="copy"]')]
    expect(copyButtons).toHaveLength(items.length)
    copyButtons[2].click()
    expect(copied).toEqual([hls.url])

    const downloadButtons = [...list.querySelectorAll<HTMLButtonElement>('[data-action="download"]')]
    expect(downloadButtons).toHaveLength(2)
    downloadButtons[0].click()
    expect(downloads).toEqual([video.url])

    const hlsButtons = [...list.querySelectorAll<HTMLButtonElement>('[data-action="hls-download"]')]
    expect(hlsButtons).toHaveLength(1)
    hlsButtons[0].click()
    expect(downloads).toEqual([video.url])

    const dashButtons = [...list.querySelectorAll<HTMLButtonElement>('[data-action="dash-download"]')]
    expect(dashButtons).toHaveLength(1)

    const urlNodes = [...list.querySelectorAll('.url')]
    expect(urlNodes[4].getAttribute('title')).toBe(blobVideo.url)
    expect(urlNodes[4].textContent).not.toBe(blobVideo.url)
    expect(urlNodes[4].textContent).toContain('…')

    const notes = [...list.querySelectorAll('.note')].map((node) => node.textContent)
    expect(notes).toEqual([
      'HLS 清单，可下载未加密的点播',
      'DASH 清单，可下载未加密的点播',
      'blob 地址，无法直接下载',
      'data 地址，无法直接下载',
      '无法直接下载',
    ])
    expect(list.querySelector('.tag-video')?.textContent).toBe('视频')
    expect(list.querySelector('.tag-audio')?.textContent).toBe('音频')
    expect(list.querySelector('.size')?.textContent).toBe('1.5 KB')
    expect(list.querySelectorAll('.size')[1]?.textContent).toBe('未知')
  })

  it('五十条都能画出来，地址悬停是全文', () => {
    const items = Array.from({ length: 50 }, (_, index) =>
      item({
        url: `https://cdn.example.com/media/${'segment/'.repeat(8)}file-${index}.mp4`,
        kind: 'video',
        ext: 'mp4',
        size: index * 1024,
      }),
    )
    const list = document.createElement('ul')
    list.className = 'list'
    renderList(list, items)
    expect(list.children).toHaveLength(50)
    for (const row of list.querySelectorAll('.url')) {
      const title = row.getAttribute('title') ?? ''
      expect(title.startsWith('https://cdn.example.com/media/')).toBe(true)
      expect(row.textContent?.length).toBeLessThanOrEqual(52)
      expect(row.textContent).not.toBe(title)
    }
    expect(list.querySelectorAll('[data-action="download"]')).toHaveLength(50)
  })

  it('下载状态写在对应条目上，关掉再打开用的是同一份记录', () => {
    const list = document.createElement('ul')
    const stored = {
      [normalizeUrl(video.url)]: {
        phase: 'failed' as const,
        message: '服务器拒绝访问（403）',
        updatedAt: 1,
      },
      [audio.url]: {
        phase: 'complete' as const,
        message: '已完成',
        updatedAt: 2,
      },
    }
    renderList(list, [video, audio], stored)
    const rows = [...list.querySelectorAll('.item')]
    expect(rows[0].querySelector('.status')?.textContent).toBe('服务器拒绝访问（403）')
    expect(rows[0].querySelector('.status-failed')).toBeTruthy()
    expect(rows[1].querySelector('.status')?.textContent).toBe('已完成')
    expect(rows[1].querySelector('.status-complete')).toBeTruthy()
    expect(list.querySelector('.download')?.getAttribute('title')).toBeNull()
    expect(statusForItem(video, stored)?.message).toBe('服务器拒绝访问（403）')

    const button = rows[0].querySelector<HTMLButtonElement>('.download')
    expect(button).toBeTruthy()
    setRowStatus(rows[0] as HTMLElement, { phase: 'started', message: '已开始下载' })
    expect(rows[0].querySelectorAll('.status')).toHaveLength(1)
    expect(rows[0].querySelector('.status')?.textContent).toBe('已开始下载')
    expect(button?.textContent).toBe('下载')
  })

  it('复制按钮短暂显示已复制，连点时恢复最初的字', () => {
    vi.useFakeTimers()
    const button = document.createElement('button')
    button.textContent = '复制'
    flashButton(button, '已复制')
    expect(button.textContent).toBe('已复制')
    vi.advanceTimersByTime(100)
    flashButton(button, '复制失败')
    vi.advanceTimersByTime(BUTTON_FLASH_MS - 1)
    expect(button.textContent).toBe('复制失败')
    vi.advanceTimersByTime(1)
    expect(button.textContent).toBe('复制')
    vi.useRealTimers()
  })
})

describe('HLS 下载界面', () => {
  it('主清单先选清晰度，默认停在列表第一项；下载中显示进度和取消', () => {
    const list = document.createElement('ul')
    const high = 'https://cdn.example/high.m3u8'
    const low = 'https://cdn.example/low.m3u8'
    const starts: string[] = []
    const cancels: string[] = []
    const picks: string[] = []
    bindListActions(list, () => [hls], {
      onCopy() {},
      onDownload() {},
      onHlsStart(_url, mediaUrl) {
        starts.push(mediaUrl)
      },
      onHlsCancel(url) {
        cancels.push(url)
      },
      onHlsVariant(_url, mediaUrl) {
        picks.push(mediaUrl)
      },
    })

    renderList(list, [hls], undefined, {
      [hls.url]: {
        phase: 'picking',
        message: '请选择清晰度',
        completed: 0,
        total: 0,
        updatedAt: 1,
        variants: [
          { url: high, label: '1920×1080 · 4500 kbps', bandwidth: 4500000, separateAudio: false },
          { url: low, label: '640×360 · 800 kbps', bandwidth: 800000, separateAudio: true },
        ],
      },
    })
    const select = list.querySelector('select')
    expect(select).toBeTruthy()
    expect(select?.value).toBe(high)
    if (select) {
      select.value = low
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    expect(picks).toEqual([low])
    list.querySelector<HTMLButtonElement>('[data-action="hls-start"]')?.click()
    expect(starts).toEqual([low])

    const preferred = new Map([[hls.url, low]])
    renderList(
      list,
      [hls],
      undefined,
      {
        [hls.url]: {
          phase: 'downloading',
          message: '已下载 2/10',
          completed: 2,
          total: 10,
          warning: '共 300 个分片，拼接时会占用较多内存',
          updatedAt: 2,
        },
      },
      preferred,
    )
    expect(list.querySelector('.progress-fill')?.getAttribute('style')).toContain('20%')
    expect(list.querySelector('.status')?.textContent).toBe('已下载 2/10')
    expect(list.querySelector('.warning')?.textContent).toContain('内存')
    expect(list.querySelector('[data-action="hls-download"]')).toBeNull()
    list.querySelector<HTMLButtonElement>('[data-action="hls-cancel"]')?.click()
    expect(cancels).toEqual([hls.url])

    renderList(list, [hls], undefined, {
      [hls.url]: {
        phase: 'remuxing',
        message: '正在转成 mp4…',
        completed: 10,
        total: 10,
        warning: '拼接时会占用较多内存',
        updatedAt: 4,
      },
    })
    expect(list.querySelector('.status')?.textContent).toBe('正在转成 mp4…')
    expect(list.querySelector('.status')?.className).toContain('status-started')
    expect(list.querySelector('.progress')).toBeNull()
    expect(list.querySelector('.warning')?.textContent).toContain('内存')
    expect(list.querySelector('[data-action="hls-cancel"]')).toBeTruthy()

    renderList(list, [hls], undefined, {
      [hls.url]: {
        phase: 'complete',
        message: '转封装失败，已保存为 .ts，可用 VLC 播放',
        completed: 10,
        total: 10,
        updatedAt: 5,
      },
    })
    expect(list.querySelector('.status')?.textContent).toBe('转封装失败，已保存为 .ts，可用 VLC 播放')
    expect(list.querySelector('.status')?.className).toContain('status-complete')
    expect(hlsJobForItem(hls, { [hls.url]: { phase: 'failed', message: '服务器拒绝访问（403）', completed: 0, total: 1, updatedAt: 3 } })?.message).toBe(
      '服务器拒绝访问（403）',
    )
  })

  it('旧的「仅复制」说明改成可以下载未加密点播', () => {
    expect(itemNote({ ...hls, note: 'HLS 清单，仅支持复制链接' })).toBe('HLS 清单，可下载未加密的点播')
    expect(itemNote({ ...dash, note: 'DASH 清单，仅支持复制链接' })).toBe('DASH 清单，可下载未加密的点播')
  })
})

describe('DASH 下载界面', () => {
  it('多清晰度默认停在最高的一条，进度和取消走自己的按钮', () => {
    const list = document.createElement('ul')
    const starts: string[] = []
    const cancels: string[] = []
    bindListActions(list, () => [dash], {
      onCopy() {},
      onDownload() {},
      onDashStart(_url, representationId) {
        starts.push(representationId)
      },
      onDashCancel(url) {
        cancels.push(url)
      },
    })
    const high = 'video-high'
    const low = 'video-low'
    renderList(
      list,
      [dash],
      undefined,
      undefined,
      undefined,
      {
        [dash.url]: {
          phase: 'picking',
          message: '请选择清晰度',
          completed: 0,
          total: 0,
          updatedAt: 1,
          warning: '视频和音频是分开的，将保存成两个文件。扩展不能把两路 fMP4 合成一个文件',
          variants: [
            { url: high, label: '1920×1080 · 4500 kbps', bandwidth: 4500000, separateAudio: true },
            { url: low, label: '640×360 · 800 kbps', bandwidth: 800000, separateAudio: true },
          ],
        },
      },
    )
    const select = list.querySelector('select')
    expect(select?.value).toBe(high)
    expect(list.querySelector('.warning')?.textContent).toContain('两个文件')
    expect(list.querySelector('[data-action="hls-start"]')).toBeNull()
    list.querySelector<HTMLButtonElement>('[data-action="dash-start"]')?.click()
    expect(starts).toEqual([high])

    renderList(
      list,
      [dash],
      undefined,
      undefined,
      new Map([[dash.url, high]]),
      {
        [dash.url]: {
          phase: 'downloading',
          message: '已下载 1/4',
          completed: 1,
          total: 4,
          updatedAt: 2,
          warning: '视频和音频是分开的，将保存成两个文件。扩展不能把两路 fMP4 合成一个文件',
        },
      },
    )
    expect(list.querySelector('.progress-fill')?.getAttribute('style')).toContain('25%')
    expect(list.querySelector('.status')?.textContent).toBe('已下载 1/4')
    expect(list.querySelector('[data-action="hls-cancel"]')).toBeNull()
    list.querySelector<HTMLButtonElement>('[data-action="dash-cancel"]')?.click()
    expect(cancels).toEqual([dash.url])

    renderList(list, [dash], undefined, undefined, undefined, {
      [dash.url]: {
        phase: 'complete',
        message: '视频和音频已分开保存。扩展不能把两路 fMP4 合成一个文件',
        completed: 4,
        total: 4,
        updatedAt: 3,
      },
    })
    expect(list.querySelector('.status')?.textContent).toContain('分开保存')
    expect(list.querySelector('.status')?.className).toContain('status-complete')
    expect(list.querySelector('[data-action="dash-download"]')).toBeTruthy()
  })
})

describe('样式约束', () => {
  it('宽度固定在 420px，列表纵向滚动，不出现横向滚动条', () => {
    const css = readFileSync(join(process.cwd(), 'src/popup/style.css'), 'utf8')
    expect(css).toMatch(/width:\s*420px/)
    expect(css).toMatch(/overflow-x:\s*hidden/)
    expect(css).toMatch(/overflow-y:\s*auto/)
    expect(css).toMatch(/text-overflow:\s*ellipsis/)
  })
})
