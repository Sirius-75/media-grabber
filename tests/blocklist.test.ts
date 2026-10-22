import { afterEach, describe, expect, it } from 'vitest'
import { BLOCKED_DOMAINS, isBlocked } from '../src/shared/blocklist'

afterEach(() => {
  BLOCKED_DOMAINS.length = 0
})

describe('isBlocked', () => {
  it('默认空数组，任何地址都不屏蔽', () => {
    expect(BLOCKED_DOMAINS).toEqual([])
    expect(isBlocked('https://cdn.example/a.mp4')).toBe(false)
    expect(isBlocked('https://ads.example/a.mp4')).toBe(false)
    expect(isBlocked('blob:https://example.com/uuid')).toBe(false)
    expect(isBlocked('不是 URL')).toBe(false)
    expect(isBlocked('')).toBe(false)
  })

  it('主机名相等或为其子域名时命中，大小写和末尾的点忽略', () => {
    BLOCKED_DOMAINS.push('Ads.Example.', ' ', 'https://nope.example/a')
    expect(isBlocked('https://ads.example/a.mp4')).toBe(true)
    expect(isBlocked('https://ADS.EXAMPLE./b.mp4#t=1')).toBe(true)
    expect(isBlocked('https://cdn.ads.example/c.mp4')).toBe(true)
    expect(isBlocked('https://user:pass@ads.example:443/d.mp4')).toBe(true)
  })

  it('不会误伤前后缀只是长得像的主机', () => {
    BLOCKED_DOMAINS.push('example.com')
    expect(isBlocked('https://notexample.com/a.mp4')).toBe(false)
    expect(isBlocked('https://example.com.evil.test/a.mp4')).toBe(false)
    expect(isBlocked('https://example.org/a.mp4')).toBe(false)
    expect(isBlocked('https://cdn.example.org/a.mp4')).toBe(false)
  })

  it('名单里有条目时，解析不出主机名的地址仍然放过', () => {
    BLOCKED_DOMAINS.push('example.com')
    expect(isBlocked('相对路径.mp4')).toBe(false)
    expect(isBlocked('data:video/mp4,AAAA')).toBe(false)
  })
})
