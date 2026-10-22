# media-grabber 方案（MVP）

Chrome / Edge Manifest V3 扩展，**仅自用**。作用是识别当前页面里的音视频资源，列出来供复制或下载。

> 不做的事：不破解 DRM（Widevine/PlayReady 等），不绕过付费墙或登录，不伪造请求头去拿受保护的资源。遇到加密内容只标注一下，不做处理。

## 1. MVP 范围

| 能力 | MVP | 第二版 |
|---|---|---|
| 识别 `<video>`/`<audio>` 的 `src` 以及 `<source>` 子元素 | ✅ | |
| `blob:` / `data:` 地址标注为"无法直接下载" | ✅ | |
| 通过 webRequest 监听 mp4/webm/mp3/m4a/m3u8/mpd | ✅ | |
| 按 tab 去重存储 | ✅ | |
| popup 列表：类型 / 大小 / URL，复制链接 | ✅ | |
| 直链用 `chrome.downloads` 下载 | ✅ | |
| HLS / DASH 只复制清单链接 | ✅ | |
| 下载 HLS/DASH 分片并合并 | | ⏳ |
| 动态插入的 iframe 深层识别、标题命名优化 | | ⏳ |

## 2. 技术栈

- TypeScript（strict）
- Vite + `@crxjs/vite-plugin`（MV3 打包，带 HMR）
- 类型定义：`@types/chrome`
- 测试：Vitest（只覆盖纯函数，比如 URL 分类和去重）
- 不引入 UI 框架，popup 直接用原生 DOM + TS（后面需要时再换 Preact）

## 3. 目录结构

```
media-grabber/
├── PLAN.md
├── README.md
├── package.json
├── tsconfig.json
├── vite.config.ts            # 引入 crx({ manifest })
├── manifest.config.ts        # 用 defineManifest 写 manifest，带类型检查
├── public/
│   └── icons/                # 16/32/48/128 png
├── src/
│   ├── shared/
│   │   ├── types.ts          # MediaItem、MediaKind、消息类型
│   │   ├── classify.ts       # 按扩展名 / Content-Type 判断类型（纯函数）
│   │   ├── messages.ts       # 消息协议常量与类型守卫
│   │   └── format.ts         # 字节数格式化等
│   ├── background/
│   │   ├── index.ts          # service worker 入口
│   │   ├── sniffer.ts        # webRequest 监听
│   │   └── store.ts          # 按 tab 去重存储（chrome.storage.session）
│   ├── content/
│   │   └── index.ts          # 扫描 DOM + MutationObserver
│   └── popup/
│       ├── index.html
│       ├── main.ts
│       └── style.css
└── tests/
    ├── classify.test.ts
    └── store.test.ts
```

## 4. manifest 权限清单

```ts
permissions: ["webRequest", "downloads", "storage", "tabs", "clipboardWrite"],
host_permissions: ["<all_urls>"],
content_scripts: [{ matches: ["<all_urls>"], js: ["src/content/index.ts"], all_frames: true, run_at: "document_idle" }],
background: { service_worker: "src/background/index.ts", type: "module" },
action: { default_popup: "src/popup/index.html" }
```

| 权限 | 理由 |
|---|---|
| `webRequest` | 在 `onHeadersReceived` 里读取响应的 URL、`Content-Type`、`Content-Length`，用来发现媒体请求。MV3 下只做观察，不加 `webRequestBlocking`，也不修改请求。 |
| `host_permissions: <all_urls>` | webRequest 要拿到各站点的请求，content script 要注入到任意页面，两者都需要主机权限。仅自用，所以接受这个范围较大的授权。 |
| `downloads` | 用 `chrome.downloads.download()` 下载直链文件。 |
| `storage` | 用 `chrome.storage.session` 存每个 tab 的资源列表。service worker 会被回收，存储能保证数据不丢；关掉浏览器后自动清空。 |
| `tabs` | popup 要拿到当前 tab 的 id 和标题（标题用于生成文件名）；后台还要监听 `tabs.onRemoved` 和导航事件来清理数据。 |
| `clipboardWrite` | popup 里用 `navigator.clipboard.writeText` 复制链接。popup 有用户手势时通常不需要这个权限，这里声明上是为了保险，可选。 |

不申请的权限：`declarativeNetRequest`（不需要改请求）、`scripting`（用静态 content script 就够了）、`cookies`、`debugger`。

## 5. 数据模型

```ts
type MediaKind = "video" | "audio" | "hls" | "dash";
type MediaSource = "dom" | "network";

interface MediaItem {
  url: string;          // 规范化后的 URL，作为去重键
  kind: MediaKind;
  ext?: string;         // mp4 / webm / mp3 / m4a / m3u8 / mpd
  mime?: string;
  size?: number;        // 字节数，来自 Content-Length（可能拿不到）
  sources: MediaSource[];
  downloadable: boolean; // blob:/data:/hls/dash 为 false
  note?: string;        // 例如 "blob 地址，无法直接下载"
  frameUrl?: string;
  firstSeen: number;
}
// 存储结构：storage.session 中 key = `tab:${tabId}`，value = MediaItem[]
```

**判断规则（`classify.ts`）**
- 扩展名：先去掉 query/hash 再看 pathname 的后缀，取 `.mp4 .webm .mp3 .m4a .m3u8 .mpd`。
- Content-Type：`video/mp4`、`video/webm`、`audio/mpeg`、`audio/mp4`、`audio/x-m4a`、`application/vnd.apple.mpegurl`、`application/x-mpegurl`、`audio/mpegurl`、`application/dash+xml`。
- 两条命中任意一条就算媒体；扩展名和 Content-Type 冲突时以 Content-Type 为准。
- 排除：`.ts`/`.m4s` 分片、`Range` 请求得到的 206 响应只更新大小、不新增条目；状态码 ≥ 400 的忽略。

**去重**：key 是去掉 hash 后的 URL。同一个 URL 再次出现时，合并 `sources` 并补全 `size`/`mime`。单个 tab 最多存 200 条，超出时丢弃最早的。

## 6. 模块与数据流

```mermaid
flowchart LR
  subgraph Page[网页 Tab]
    DOM[video / audio / source 元素]
    CS[content script<br/>扫描 + MutationObserver]
    DOM --> CS
  end
  NET[(浏览器网络请求)] -->|onHeadersReceived| SN[sniffer.ts]
  CS -->|runtime.sendMessage<br/>MEDIA_FOUND| BG[background index.ts]
  SN --> ST[store.ts<br/>按 tab 去重]
  BG --> ST
  ST <--> SS[(chrome.storage.session)]
  P[popup] -->|GET_MEDIA tabId| BG
  BG -->|MediaItem[]| P
  P -->|DOWNLOAD url| BG
  BG --> DL[chrome.downloads]
  P -->|clipboard.writeText| CB[剪贴板]
  ST -->|更新 badge 计数| BADGE[action badge]
```

**消息协议**（`messages.ts`）
- `MEDIA_FOUND { items: Partial<MediaItem>[] }`：content → background，tabId 从 `sender.tab.id` 取
- `GET_MEDIA { tabId }` → 返回 `MediaItem[]`
- `CLEAR_MEDIA { tabId }`
- `DOWNLOAD { url, filename? }` → 返回 `{ ok, downloadId?, error? }`

**生命周期**
- `tabs.onRemoved`：删除该 tab 的数据
- `webNavigation` 不申请；改用 `tabs.onUpdated` 里 `status === "loading"` 且 URL 变化时清空（SPA 路由切换不清空）
- badge 显示该 tab 的条目数

## 7. 已知限制

1. **DRM / 加密**：带 EME 加密的内容（Netflix、付费平台等）不处理；HLS 带 `#EXT-X-KEY` 时只复制链接，不做额外提示以外的事情。
2. **blob: / MSE**：大多数现代播放器（YouTube、B 站等）用 MediaSource 播放，`<video>` 上看到的是 `blob:`，无法直接下载；真实地址往往是分片或清单，只能靠 webRequest 去碰运气。
3. **分片流**：HLS/DASH 在 MVP 里只能复制清单链接，需要用外部工具（比如 ffmpeg、yt-dlp）下载。
4. **大小未知**：分块传输、没有 `Content-Length`、或者只看到 Range 片段时，大小显示"未知"或不准。
5. **防盗链 / 鉴权**：有些链接依赖 Referer、Cookie 或会过期的签名，`chrome.downloads` 下载可能报 403，复制出去用也可能失效。
6. **Service worker 回收**：SW 被回收期间发生的请求不会丢（事件会唤醒 SW），但内存状态会丢，所以一律用 storage.session。
7. **漏检**：扩展名不规范、Content-Type 是 `application/octet-stream` 的资源会漏掉；跨域 iframe 里的 DOM 依赖 `all_frames`，部分沙箱 iframe 拿不到。
8. **Service Worker 发出的请求**（页面自己的 SW 拉取）在 webRequest 里 tabId 可能是 -1，归不到具体 tab，这种请求丢弃。
9. Edge 和 Chrome API 基本一致，Firefox 不在范围内。

## 8. 任务拆分（可独立交给 Cursor / Grok Build）

依赖关系：T1 → (T2, T3) → T4/T5 → T6 → T7；T2 完成后 T3/T4/T5 可以并行做。

### T1 工程脚手架
- 内容：初始化 `package.json`、TS strict、Vite + `@crxjs/vite-plugin`、`manifest.config.ts`（权限按第 4 节写）、占位图标、空的 background/content/popup 入口、Vitest、`npm run dev/build/test/typecheck`。
- 验收：
  - `npm run build` 生成 `dist/`，能在 `chrome://extensions` 和 `edge://extensions` 以"加载已解压"方式载入，没有报错；
  - `npm run dev` 下改 popup 文字能热更新；
  - manifest 里的权限和第 4 节完全一致，没有多余的。

### T2 共享类型与分类函数（`src/shared/*`）
- 内容：`types.ts`、`messages.ts`、`classify.ts`（`classifyByUrl`、`classifyByMime`、`classify(url, mime?)`、`normalizeUrl`）、`format.ts`（`formatBytes`）。
- 验收：
  - 单元测试覆盖：6 种扩展名、带 query/hash 的 URL、大写扩展名、第 5 节列出的各种 MIME、`.ts`/`.m4s` 被排除、`blob:`/`data:` 返回 `downloadable:false`；
  - `npm test` 全部通过，`classify.ts` 测试覆盖率 ≥ 90%。

### T3 后台存储（`background/store.ts`）
- 内容：`addItems(tabId, items)`（合并去重、200 条上限）、`getItems`、`clearTab`；读写都走 `chrome.storage.session`；更新 badge；监听 `tabs.onRemoved` / `tabs.onUpdated` 清理数据。
- 验收：
  - 用 mock 掉的 chrome.storage 写单测：同一 URL 加两次只剩一条，`sources` 合并，`size` 补全；超过 200 条会丢掉最早的；
  - 手动：在 `chrome://serviceworker-internals` 停掉 SW 后再打开 popup，数据还在；关闭 tab 后数据被清除。

### T4 网络嗅探（`background/sniffer.ts`）
- 内容：`webRequest.onHeadersReceived`（`urls: ["<all_urls>"]`，`extraInfoSpec: ["responseHeaders"]`），读取 Content-Type 和 Content-Length，调用 `classify`，忽略 `tabId < 0` 和状态码 ≥ 400 的响应，206 只更新大小。
- 验收：
  - 在测试页 A/B/C（第 9 节）播放后，popup 能显示对应的 mp4/mp3/m3u8/mpd；
  - mp4 能显示大小（服务器返回了 Content-Length 时）；
  - HLS 页面里不会出现成百上千条 `.ts` 分片。

### T5 Content Script DOM 扫描（`content/index.ts`）
- 内容：页面加载后扫描 `video, audio, video source, audio source`，读取 `currentSrc`/`src`；用 `MutationObserver` 监听新增节点和 `src` 属性变化，300ms 防抖后发 `MEDIA_FOUND`；`blob:` 地址带上 `note: "blob 地址，无法直接下载"`。
- 验收：
  - 测试页 D（`<source>` 多个子元素）里每个 source 都被识别；
  - 用控制台动态插入一个 `<video src=...>`，1 秒内 popup 能看到；
  - 在 YouTube 上能看到一条被标注了 blob 的条目，并且没有下载按钮；
  - 在普通页面上不会报 console error。

### T6 Popup UI（`popup/*`）
- 内容：打开时查询当前 tab，发 `GET_MEDIA`；列表显示类型标签（视频/音频/HLS/DASH）、大小（拿不到时显示"未知"）、截断后的 URL（hover 显示全部）；每条都有"复制"按钮，可下载的条目有"下载"按钮；顶部显示数量和"清空"按钮；空列表时给出提示。
- 验收：
  - 复制后剪贴板里是完整的 URL，按钮短暂显示"已复制"；
  - HLS/DASH/blob 条目没有下载按钮，并带有说明文字；
  - 列表有 50 条时滚动流畅，宽度固定在约 420px，没有横向滚动条。

### T7 下载功能（background `DOWNLOAD` 处理）
- 内容：`chrome.downloads.download({ url, filename, saveAs:false })`；文件名用 `tab 标题-序号.扩展名`，过滤掉非法字符，限制长度；失败时把 `error` 返回给 popup 显示。
- 验收：
  - 在测试页 A 点击下载，文件出现在下载目录，扩展名正确；
  - 标题里含 `/:*?"<>|` 时也能正常下载；
  - 对 403 的链接，popup 显示失败原因，不会卡住。

### T8 文档与打包（可选）
- 内容：README（安装、开发、已知限制），`npm run zip` 打包 dist。
- 验收：按 README 从零 clone 到加载扩展，不需要额外步骤；第 9 节的测试清单全部通过并在 README 里打勾。

## 9. 手动测试清单

准备以下几类公开测试页面（都是用于测试的公开资源，URL 可能变化，失效时换同类的即可）：

| 编号 | 类型 | 示例来源 | 预期 |
|---|---|---|---|
| A | `<video src>` 直链 mp4 | MDN `<video>` 元素文档页的示例；或者本地 `test.html` 引用 Big Buck Bunny 的公开 mp4 | DOM + 网络各识别一次但合并为一条，显示大小，能下载 |
| B | `<audio>` mp3 | MDN `<audio>` 文档示例 | 识别为音频，能下载 |
| C1 | HLS m3u8 | hls.js 官方 demo 页（`hlsjs.video-dev.org/demo`），或 Apple 的 HLS 示例流 | 出现一条 HLS 清单，只能复制；`.ts` 分片不出现 |
| C2 | DASH mpd | dash.js 参考播放器（`reference.dashif.org/dash.js`） | 出现一条 DASH，只能复制；`.m4s` 不出现 |
| D | 多个 `<source>` 子元素 | 本地 `tests/pages/sources.html`（webm + mp4 两个 source） | 两个 source 都列出来 |
| E | blob / MSE 播放 | YouTube 或 B 站任意公开视频 | DOM 条目标注 blob、不可下载；不报错 |
| F | 动态插入 | 在任意页面控制台执行 `document.body.append(Object.assign(document.createElement('video'),{src:'<mp4 URL>'}))` | 1 秒内出现 |
| G | 无媒体页面 | `example.com` | 空列表提示，badge 不显示 |
| H | 文件名边界 | 本地页面，title 里含特殊字符 | 下载文件名合法 |

通用检查项：
- [ ] Chrome 和 Edge 都能加载并正常工作
- [ ] 切换 tab 后 popup 只显示当前 tab 的资源
- [ ] 刷新页面后旧数据被清掉；SPA 路由切换不清空
- [ ] 关掉 tab 后存储里没有残留（DevTools → Application → Storage 查看）
- [ ] SW 被停止后再打开 popup，数据还在
- [ ] 扩展的 errors 页面没有报错
- [ ] 访问带 DRM 的页面时扩展不做任何绕过，只按普通资源规则列出能看到的 URL
