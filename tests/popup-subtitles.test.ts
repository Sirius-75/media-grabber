/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../src/shared/types'
import { bindListActions, renderList, type ShownSubtitles } from '../src/popup/view'

const hls: MediaItem = {
  url: 'https://cdn.example/master.m3u8',
  kind: 'hls',
  ext: 'm3u8',
  sources: ['network'],
  downloadable: false,
  firstSeen: 1,
}

describe('列表里的字幕', () => {
  it('显示语言，并能按所选格式下载；不支持的格式只给出说明', () => {
    document.body.innerHTML = '<ul id="list"></ul>'
    const list = document.querySelector('#list')
    if (!(list instanceof HTMLElement)) throw new Error('缺少列表')
    const shown = new Map<string, ShownSubtitles>([
      [
        hls.url,
        {
          tracks: [
            { id: 'https://cdn.example/zh.m3u8', label: '中文（zh）', language: 'zh', format: 'vtt' },
            { id: 'stpp', label: '德语（de）', language: 'de', format: 'unsupported', note: '这种字幕格式（TTML/stpp）暂不支持' },
          ],
        },
      ],
    ])
    renderList(list, [hls], undefined, undefined, undefined, undefined, undefined, undefined, shown)
    expect(list.textContent).toContain('中文（zh）')
    expect(list.textContent).toContain('下载字幕')
    expect(list.textContent).toContain('这种字幕格式（TTML/stpp）暂不支持')
    const select = list.querySelector('select.subtitle-format')
    if (!(select instanceof HTMLSelectElement)) throw new Error('缺少格式选择')
    select.value = 'srt'
    const downloaded: Array<{ url: string; trackId: string; format: string }> = []
    bindListActions(list, () => [hls], {
      onCopy: vi.fn(),
      onDownload: vi.fn(),
      onSubtitleDownload(url, trackId, format) {
        downloaded.push({ url, trackId, format })
      },
    })
    list.querySelector<HTMLButtonElement>('[data-action="subtitle-download"]')?.click()
    expect(downloaded).toEqual([
      { url: hls.url, trackId: 'https://cdn.example/zh.m3u8', format: 'srt' },
    ])
    expect(list.querySelectorAll('[data-track="stpp"]')).toHaveLength(0)
  })
})