/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../src/shared/types'
import { MESSAGE_TYPE } from '../src/shared/messages'
import {
  DOWNLOAD_PENDING_ERROR,
  handleDownloadMessage,
} from '../src/background/download'
import {
  BUTTON_FLASH_MS,
  bindListActions,
  canOfferDownload,
  downloadFeedback,
  flashButton,
  isMediaItemList,
  itemNote,
  kindLabel,
  renderList,
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
  note: 'HLS 清单，仅支持复制链接',
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
  })

  it('不可下载的条目带说明，直链没有多余说明', () => {
    expect(itemNote(video)).toBeUndefined()
    expect(itemNote(hls)).toBe('HLS 清单，仅支持复制链接')
    expect(itemNote(dash)).toBe('DASH 清单，仅支持复制链接')
    expect(itemNote(blobVideo)).toBe('blob 地址，无法直接下载')
    expect(itemNote(dataAudio)).toBe('data 地址，无法直接下载')
    expect(itemNote({ ...video, downloadable: false, note: undefined })).toBe('无法直接下载')
    expect(itemNote({ ...blobVideo, note: '  ' })).toBe('blob 地址，无法直接下载')
  })

  it('下载回复：成功、占位错误，以及看不懂的响应', () => {
    expect(downloadFeedback({ ok: true, downloadId: 4 })).toBe('已开始')
    expect(downloadFeedback({ ok: false, error: DOWNLOAD_PENDING_ERROR })).toBe('即将支持')
    expect(downloadFeedback({ ok: false, error: '  网络拒绝了这次下载请求，请稍后再试  ' })).toBe(
      '即将支持',
    )
    expect(downloadFeedback(undefined)).toBe('即将支持')
    expect(downloadFeedback({ ok: false })).toBe('即将支持')
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
  it('复制拿到完整链接；HLS、DASH、blob、data 和不可下载条目没有下载按钮', () => {
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

    const urlNodes = [...list.querySelectorAll('.url')]
    expect(urlNodes[4].getAttribute('title')).toBe(blobVideo.url)
    expect(urlNodes[4].textContent).not.toBe(blobVideo.url)
    expect(urlNodes[4].textContent).toContain('…')

    const notes = [...list.querySelectorAll('.note')].map((node) => node.textContent)
    expect(notes).toEqual([
      'HLS 清单，仅支持复制链接',
      'DASH 清单，仅支持复制链接',
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

describe('样式约束', () => {
  it('宽度固定在 420px，列表纵向滚动，不出现横向滚动条', () => {
    const css = readFileSync(join(process.cwd(), 'src/popup/style.css'), 'utf8')
    expect(css).toMatch(/width:\s*420px/)
    expect(css).toMatch(/overflow-x:\s*hidden/)
    expect(css).toMatch(/overflow-y:\s*auto/)
    expect(css).toMatch(/text-overflow:\s*ellipsis/)
  })
})

describe('DOWNLOAD 占位', () => {
  it('只回复即将支持，不把别的消息当成下载', () => {
    const replies: unknown[] = []
    const sendResponse = (response?: unknown) => {
      replies.push(response)
    }
    const sender = {} as chrome.runtime.MessageSender
    expect(
      handleDownloadMessage(
        { type: MESSAGE_TYPE.DOWNLOAD, url: 'https://cdn.example/a.mp4' },
        sender,
        sendResponse,
      ),
    ).toBe(true)
    expect(replies).toEqual([{ ok: false, error: '即将支持' }])

    expect(
      handleDownloadMessage({ type: MESSAGE_TYPE.GET_MEDIA, tabId: 1 }, sender, sendResponse),
    ).toBeUndefined()
    expect(replies).toHaveLength(1)
  })
})
