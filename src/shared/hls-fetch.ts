/**
 * 拉取清单和分片的字节。
 * 不设置 headers，也不写 Referer。credentials 只是让浏览器带上它已经有的 Cookie。
 */

const PLAYLIST_CHAR_LIMIT = 2_000_000
const ATTEMPT_TIMEOUT_MS = 45_000

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type SegmentFetchResult = { ok: true; bytes: Uint8Array } | { ok: false; status: number }

export type PlaylistFetchResult =
  | { ok: true; text: string }
  | { ok: false; status: number; reason?: 'network' | 'too-large' }

function requestInit(signal: AbortSignal): RequestInit {
  // 这里故意不放 headers。加了就会变成我们在伪造请求头。
  return {
    signal,
    credentials: 'include',
    redirect: 'follow',
  }
}

/** 单次请求的超时。结束时一定清掉定时器，避免测试进程被挂住。 */
function attemptSignal(parent: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
  const onParentAbort = () => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onParentAbort, { once: true })
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      parent.removeEventListener('abort', onParentAbort)
    },
  }
}

/** 只要完整的 200。206 是半截内容，拼进去会坏。 */
export async function fetchSegmentBytes(
  url: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<SegmentFetchResult> {
  const attempt = attemptSignal(signal)
  try {
    const response = await fetchImpl(url, requestInit(attempt.signal))
    if (response.status !== 200) return { ok: false, status: response.status }
    return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) }
  } catch (error) {
    if (signal.aborted) throw error
    return { ok: false, status: 0 }
  } finally {
    attempt.done()
  }
}

export async function fetchPlaylistText(
  url: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<PlaylistFetchResult> {
  const attempt = attemptSignal(signal)
  try {
    const response = await fetchImpl(url, requestInit(attempt.signal))
    if (response.status !== 200) return { ok: false, status: response.status }
    const text = await response.text()
    if (text.length > PLAYLIST_CHAR_LIMIT) return { ok: false, status: 0, reason: 'too-large' }
    return { ok: true, text }
  } catch (error) {
    if (signal.aborted) throw error
    return { ok: false, status: 0, reason: 'network' }
  } finally {
    attempt.done()
  }
}
