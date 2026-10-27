/**
 * DASH 进度和 HLS 用同一份记录形状，但单独放在 session 里。
 * popup 关掉再打开，还是读这一份。
 */

export const DASH_JOB_STORAGE_KEY = 'dash-jobs'

export { readHlsJobMap as readDashJobMap } from './hls-job'
