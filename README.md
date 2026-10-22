> **本项目通过 vibe coding 方式由 AI 生成实现，仅供个人自用。**

# Media Grabber

Chrome / Edge Manifest V3 扩展。共享层能判断媒体类型并规范化 URL。后台按标签页把媒体存在 `chrome.storage.session`（service worker 被回收后还在），并更新图标角标；`src/shared/blocklist.ts` 里的域名会被忽略，默认名单是空的。Content script 在隔离环境里扫描本 frame 的 `<video>` / `<audio>`（含 `currentSrc` 和 `<source>`），有变化才发 `MEDIA_FOUND`（tabId 由后台从 `sender.tab.id` 取）。网络嗅探用 `chrome.webRequest.onHeadersReceived` 只读响应头：认成媒体的 2xx 交给 `addMedia`，206 只补已有条目的大小。顶层文档请求（`main_frame` 的 `onBeforeRequest`）一发出就清掉该标签页的旧列表；同一次导航里更晚的 `tabs.onUpdated` loading 不会再清，避免把刚抓到的条目删掉。popup 仍是占位，打开扩展还不会列出资源。完整设计见 [PLAN.md](./PLAN.md)。

不破解 DRM，不绕过登录或付费墙，不修改请求。

## 环境

- Node.js `^20.19.0 || >=22.12.0`（Node 24 可以用）
- Chrome 或 Edge

Vite 8 的打包器是 rolldown。Windows 上它要加载 `@rolldown/binding-win32-x64-msvc`，这个包和 Vite 都要求上面的 Node 版本。版本不够时，安装或启动会报找不到 `rolldown-binding.win32-x64-msvc`。`package.json` 的 `engines.node` 写的是同一范围。锁文件里已经包含 Windows 的可选绑定，在本机执行 `npm install` 即可。

## 安装

```bash
npm install
```

## 开发（热更新）

```bash
npm run dev
```

保持这个命令运行。打开 `chrome://extensions`（Edge 为 `edge://extensions`），打开「开发者模式」，选择「加载已解压的扩展程序」，指向本仓库的 `dist` 目录。

之后改 popup 的文案并保存，已打开的 popup 会热更新。加载的是 `dist`，不是仓库根目录。

## 网络嗅探日志

加载 `dist` 后，打开 `chrome://extensions`，在 Media Grabber 卡片上点 Service Worker。再打开 MDN 的 `<video>` 文档页并播放示例。

控制台里：

- `[media-grabber] 发现媒体`：状态码是 2xx（不含 206），并且 URL 或 Content-Type 被认成媒体。有 Content-Length 时会带上字节数。
- `[media-grabber] 206 更新大小`：Range 响应。只带 URL 和这一次读到的 Content-Length，不当成新条目。

`.ts` / `.m4s` 分片、`tabId < 0`、以及 4xx / 5xx 不会出现在这两条日志里。新媒体会写入当前标签页的 session 存储；206 只有在这条 URL 已经存在、且还没有大小时才补上。

## 构建与检查

```bash
npm run build      # 产物在 dist/
npm test           # Vitest
npm run typecheck  # tsc --noEmit，strict
```

构建完成后，用上面同样的方式加载 `dist`。这次的目录不依赖开发服务器，关掉终端也能用。
