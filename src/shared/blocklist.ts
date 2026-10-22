/**
 * 域名黑名单。存储入口用 isBlocked 丢掉这些主机上的媒体。
 *
 * 默认是空数组，不屏蔽任何站点。需要时把主机名写进来，例如 "ads.example.com"。
 * 不要带协议、路径或端口。比较忽略大小写，子域名也算命中。
 */
export const BLOCKED_DOMAINS: string[] = []

function canonicalDomain(entry: string): string | null {
  const domain = entry.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
  // 带协议、路径或端口的写法不当作有效条目，避免误伤。
  if (!domain || domain.includes('/') || domain.includes(':') || /\s/.test(domain)) return null
  return domain
}

/** url 的主机名命中 {@link BLOCKED_DOMAINS} 时返回 true。名单为空或 URL 没有主机名时返回 false。 */
export function isBlocked(url: string): boolean {
  if (BLOCKED_DOMAINS.length === 0) return false
  let host: string
  try {
    // URL.hostname 会去掉端口并小写；末尾的点再剥掉，和名单的写法对齐。
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return false
  }
  if (!host) return false
  for (const entry of BLOCKED_DOMAINS) {
    const domain = canonicalDomain(entry)
    if (!domain) continue
    if (host === domain || host.endsWith(`.${domain}`)) return true
  }
  return false
}
