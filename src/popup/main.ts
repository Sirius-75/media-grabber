/**
 * Popup 占位入口。
 * 只把状态写到页面上，方便确认能打开、以及 dev 下改文案能热更新。
 * 不查询当前标签页，也不拉媒体列表。
 */
const status = document.querySelector('#status')

if (status) {
  status.textContent = '扩展已加载。媒体列表将在后续版本显示。'
}
