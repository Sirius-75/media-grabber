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
| HLS / DASH 只复制清单链接 | ✅ | DASH 仍只复制；HLS 见第 10 节 |
| 下载未加密 HLS 点播并按顺序拼接 | | ✅ V2-1 |
| TS 转封装成 mp4 | | ✅ V2-2 |
| DASH 下载，以及音视频分轨合并 | | ⏳ V2-3 |
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
permissions: ["webRequest", "downloads", "storage", "tabs", "clipboardWrite", "offscreen"],
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
| `offscreen` | v2 才加。HLS 分片要在扩展页面里拼成 Blob。这个长任务不能放在会被回收的 service worker 里，所以用 `chrome.offscreen` 开一个不显示的文档。理由见第 10 节。 |

不申请的权限：`declarativeNetRequest`（不改请求，也不伪造 Referer 或其他请求头）、`scripting`（用静态 content script 就够了）、`cookies`、`debugger`。

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

1. **DRM / 加密**：带 EME 加密的内容（Netflix、付费平台等）不处理。HLS 只要出现 `#EXT-X-KEY`（AES-128、SAMPLE-AES 等）或 `#EXT-X-SESSION-KEY`，下载会停下来，并用中文说明不支持加密或 DRM。`METHOD=NONE` 不算加密。
2. **blob: / MSE**：大多数现代播放器（YouTube、B 站等）用 MediaSource 播放，`<video>` 上看到的是 `blob:`，无法直接下载；真实地址往往是分片或清单，只能靠 webRequest 去碰运气。
3. **分片流**：DASH（mpd）仍然只能复制清单链接。未加密的 HLS 点播可以下载，见第 10 节。直播（没有 `#EXT-X-ENDLIST`）不下载。MPEG-TS 会转封装成 fMP4；转失败或文件太大时仍保存 `.ts`。带 `#EXT-X-MAP` 的 fMP4 只做顺序拼接。
4. **大小未知**：分块传输、没有 `Content-Length`、或者只看到 Range 片段时，大小显示"未知"或不准。
5. **防盗链 / 鉴权**：有些链接依赖 Referer、Cookie 或会过期的签名，`chrome.downloads` 下载可能报 403，复制出去用也可能失效。
6. **Service worker 回收**：SW 被回收期间发生的请求不会丢（事件会唤醒 SW），但内存状态会丢，所以一律用 storage.session。
7. **漏检**：扩展名不规范、Content-Type 是 `application/octet-stream` 的资源会漏掉；跨域 iframe 里的 DOM 依赖 `all_frames`，部分沙箱 iframe 拿不到。
8. **Service Worker 发出的请求**（页面自己的 SW 拉取）在 webRequest 里 tabId 可能是 -1，归不到具体 tab，这种请求丢弃。
9. Edge 和 Chrome API 基本一致，Firefox 不在范围内。

## 8. 任务拆分（可独立交给 Cursor / Grok Build）

依赖关系：T1 → (T2, T3) → T4/T5 → T6 → T7 → T8；T2 完成后 T3/T4/T5 可以并行做。

| 任务 | 状态 |
|---|---|
| T1 工程脚手架 | 已完成 |
| T2 共享类型与分类 | 已完成 |
| T3 后台存储 | 已完成 |
| T4 网络嗅探 | 已完成 |
| T5 Content Script | 已完成 |
| T6 Popup | 已完成 |
| T7 下载 | 已完成 |
| T8 文档与打包 | 已完成 |

### T1 工程脚手架（已完成）
- 内容：初始化 `package.json`、TS strict、Vite + `@crxjs/vite-plugin`、`manifest.config.ts`（权限按第 4 节写）、占位图标、空的 background/content/popup 入口、Vitest、`npm run dev/build/test/typecheck`。
- 验收：
  - `npm run build` 生成 `dist/`，能在 `chrome://extensions` 和 `edge://extensions` 以"加载已解压"方式载入，没有报错；
  - `npm run dev` 下改 popup 文字能热更新；
  - manifest 里的权限和第 4 节完全一致，没有多余的。

### T2 共享类型与分类函数（`src/shared/*`）（已完成）
- 内容：`types.ts`、`messages.ts`、`classify.ts`（`classifyByUrl`、`classifyByMime`、`classify(url, mime?)`、`normalizeUrl`）、`format.ts`（`formatBytes`）。
- 验收：
  - 单元测试覆盖：6 种扩展名、带 query/hash 的 URL、大写扩展名、第 5 节列出的各种 MIME、`.ts`/`.m4s` 被排除、`blob:`/`data:` 返回 `downloadable:false`；
  - `npm test` 全部通过，`classify.ts` 测试覆盖率 ≥ 90%。

### T3 后台存储（`background/store.ts`）（已完成）
- 内容：`addItems(tabId, items)`（合并去重、200 条上限）、`getItems`、`clearTab`；读写都走 `chrome.storage.session`；更新 badge；监听 `tabs.onRemoved` / `tabs.onUpdated` 清理数据。
- 验收：
  - 用 mock 掉的 chrome.storage 写单测：同一 URL 加两次只剩一条，`sources` 合并，`size` 补全；超过 200 条会丢掉最早的；
  - 手动：在 `chrome://serviceworker-internals` 停掉 SW 后再打开 popup，数据还在；关闭 tab 后数据被清除。

### T4 网络嗅探（`background/sniffer.ts`）（已完成）
- 内容：`webRequest.onHeadersReceived`（`urls: ["<all_urls>"]`，`extraInfoSpec: ["responseHeaders"]`），读取 Content-Type 和 Content-Length，调用 `classify`，忽略 `tabId < 0` 和状态码 ≥ 400 的响应，206 只更新大小。
- 验收：
  - 在测试页 A/B/C（第 9 节）播放后，popup 能显示对应的 mp4/mp3/m3u8/mpd；
  - mp4 能显示大小（服务器返回了 Content-Length 时）；
  - HLS 页面里不会出现成百上千条 `.ts` 分片。

### T5 Content Script DOM 扫描（`content/index.ts`）（已完成）
- 内容：页面加载后扫描 `video, audio, video source, audio source`，读取 `currentSrc`/`src`；用 `MutationObserver` 监听新增节点和 `src` 属性变化，300ms 防抖后发 `MEDIA_FOUND`；`blob:` 地址带上 `note: "blob 地址，无法直接下载"`。
- 验收：
  - 测试页 D（`<source>` 多个子元素）里每个 source 都被识别；
  - 用控制台动态插入一个 `<video src=...>`，1 秒内 popup 能看到；
  - 在 YouTube 上能看到一条被标注了 blob 的条目，并且没有下载按钮；
  - 在普通页面上不会报 console error。

### T6 Popup UI（`popup/*`）（已完成）
- 内容：打开时查询当前 tab，发 `GET_MEDIA`；列表显示类型标签（视频/音频/HLS/DASH）、大小（拿不到时显示"未知"）、截断后的 URL（hover 显示全部）；每条都有"复制"按钮，可下载的条目有"下载"按钮；顶部显示数量和"清空"按钮；空列表时给出提示。
- 验收：
  - 复制后剪贴板里是完整的 URL，按钮短暂显示"已复制"；
  - HLS/DASH/blob 条目没有下载按钮，并带有说明文字；
  - 列表有 50 条时滚动流畅，宽度固定在约 420px，没有横向滚动条。

### T7 下载功能（background `DOWNLOAD` 处理）（已完成）
- 内容：`chrome.downloads.download({ url, filename, saveAs:false })`；文件名用 `tab 标题-序号.扩展名`，过滤掉非法字符，限制长度；失败时把 `error` 返回给 popup 显示。
- 验收：
  - 在测试页 A 点击下载，文件出现在下载目录，扩展名正确；
  - 标题里含 `/:*?"<>|` 时也能正常下载；
  - 对 403 的链接，popup 显示失败原因，不会卡住。

### T8 文档与打包（已完成）
- 内容：README（安装、开发、已知限制），`npm run package` 先构建，再把 dist 打成 `release/media-grabber-<version>.zip`（zip 根目录是 `manifest.json`）。
- 验收：按 README 从零 clone 到加载扩展，不需要额外步骤；`npm run typecheck`、`npm test`、`npm run build`、`npm run package` 都通过。第 9 节仍是手动清单，需要在 Chrome / Edge 里逐条点过再打勾。

## 9. 手动测试清单

准备以下几类公开测试页面（都是用于测试的公开资源，URL 可能变化，失效时换同类的即可）：

| 编号 | 类型 | 示例来源 | 预期 |
|---|---|---|---|
| A | `<video src>` 直链 mp4 | MDN `<video>` 元素文档页的示例；或者本地 `test.html` 引用 Big Buck Bunny 的公开 mp4 | DOM + 网络各识别一次但合并为一条，显示大小，能下载 |
| B | `<audio>` mp3 | MDN `<audio>` 文档示例 | 识别为音频，能下载 |
| C1 | HLS m3u8 | hls.js 官方 demo 页（`hlsjs.video-dev.org/demo`），或 Apple 的 HLS 示例流 | 出现一条 HLS 清单，`.ts` 分片不出现在列表里。未加密点播可以下载；主清单要先选清晰度。直播、带 KEY 的清单、mpd 仍然不能下 |
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
- [ ] 未加密 HLS 点播：主清单能选清晰度（默认最高），进度条会走，取消有效，关掉 popup 再打开还能看到进度
- [ ] 直播 m3u8、带 EXT-X-KEY 的 m3u8 会用中文拒绝，不会开始下分片
- [ ] DASH 仍然只有复制，没有下载按钮
- [ ] 下载出来的文件：普通 TS 转封装成功时是 `.mp4`（fMP4，没有重编码）；转封装失败时是 `.ts`，条目上写明可用 VLC 播放。带 EXT-X-MAP 的 fMP4 仍是顺序拼接的 `.mp4`

## 10. v2

MVP（T1–T8）只把 m3u8 / mpd 列出来供复制。v2 分成三步。V2-1 和 V2-2 已做。**V2-3 还没做。**

### V2-1 HLS 下载（本次）

未加密的点播 m3u8 可以在 popup 里下载。DASH 不动。

1. **解析**（`src/shared/hls.ts`，纯函数）
   - 主清单读出各条 `#EXT-X-STREAM-INF` 的 `BANDWIDTH` / `RESOLUTION`。按带宽从高到低排，默认选最高。
   - 媒体清单读出分片。相对地址用标准 URL 规则拼到清单上（不把清单 query 里的 token 抄到分片上）。
   - `#EXT-X-MAP` 是 fMP4 初始化段，拼在分片前面。有它就存 `.mp4`。没有的话先按 TS 下载，再由 V2-2 转封装。
   - `#EXT-X-DISCONTINUITY` 允许，分片仍按出现顺序接成一个文件。
2. **明确拒绝，并给中文原因**
   - 没有 `#EXT-X-ENDLIST` 的直播。
   - 任何 `#EXT-X-KEY`（`METHOD=NONE` 除外）和 `#EXT-X-SESSION-KEY`。AES-128、SAMPLE-AES 都不做。项目约定不处理加密或 DRM。
   - `#EXT-X-BYTERANGE`、`#EXT-X-GAP`、`#EXT-X-SKIP`、关键帧预览、图片清单、中途更换初始化段、看起来像 fMP4 但没有 MAP。广告打点标签忽略。
3. **下载引擎**
   - 长任务放在 `chrome.offscreen` 的文档里（`src/offscreen/`），不放在 service worker。因此 manifest 增加 `offscreen` 权限。
   - 同时拉 4 片。每一片失败后再试 2 次。可以取消。进度是已下载片数 / 总片数，写在 `chrome.storage.session`，popup 关掉再打开还在。
   - `fetch` 不设置 `headers`，不伪造 Referer，不用 `declarativeNetRequest`。`credentials: 'include'` 只带浏览器里已经有的 Cookie。
4. **输出和内存**
   - 按顺序拼成一个 Blob，再交给 `chrome.downloads`。文件名用现有的 `buildDownloadFilename`。
   - 用带宽 × 时长估算体积。预计或实际超过 2GB 就拒绝，中文说明是为了避免占满内存，并且不保存半成品。
   - 预计达到 512MB，或分片达到 300 个，先给中文警告，仍允许下载。
   - 主清单里某条清晰度带了 `AUDIO` 组时，警告声音可能在另一条清单里。本次不合并音轨。
5. **Popup**
   - m3u8 上「复制」还在，旁边多一颗「下载」。mpd 仍然只有复制。
   - 主清单先出清晰度选择，默认最高，再点「开始下载」。
   - 下载中显示进度条和「取消」。失败显示可读的中文，例如 403、第几片缺失。

解析和调度都不依赖 chrome，单测覆盖相对路径、主清单 / 媒体清单、加密拒绝、直播拒绝、重试、取消和体积上限。

### V2-2 TS 转封装成 mp4（已完成）

MPEG-TS 分片下完后，在 offscreen 文档里转封装成 `.mp4`，不重新编码。带 `EXT-X-MAP` 的 fMP4 仍按 V2-1 顺序拼接，不再转一次。

选用 [mux.js](https://github.com/videojs/mux.js) 6.3（Apache-2.0）。它能在扩展页面里把 H.264 + AAC 的 TS 转成 fMP4（`ftyp` + `moov` + 若干 `moof`/`mdat`）。没有加新权限。

没有选用的方案：

- mediabunny 能写出更传统的 mp4，但协议是 MPL-2.0，包也更大。这次不引入。
- mp4box.js 不解析 MPEG-TS。
- ffmpeg.wasm 体积大，而且会滑向重编码。扩展里不跑。

行为：

- 每一片单独转。下一片的时间轴接在上一片结束之后，所以 `EXT-X-DISCONTINUITY` 里时间戳归零也不会叠到同一段。
- 转封装进行时，popup 显示「正在转成 mp4…」，可以取消。
- 转不出（例如 H.265、AC-3，或 mux.js 抛错）时，整次下载不算失败：保存原来的 `.ts`，条目写「转封装失败，已保存为 .ts，可用 VLC 播放」。
- 已下载字节超过 1GB 时不再转。转完的 mp4 若超过 2GB 也不采用。两种情况都改存 `.ts`，并说明是为了避免占满内存。
- 声音在另一条音轨清单里时，仍然只下这一路，不合并。

输出是 fragmented MP4。Chrome、Edge、VLC 通常能播。系统自带播放器能不能播，要在真实 Chrome 里看文件，这一步没有代为验证。

### V2-3 DASH（mpd）与音视频合并的可行性（未做）

mpd 继续只复制链接。下一步只做评估，不承诺能下：

- mpd 里视频、音频常常是两条 Representation，各自有初始化段和一串 `.m4s`。
- 要合成一个文件，需要解析 mp4 box、对齐时间轴，候选库是 mp4box.js 或 mux.js。分开的 HLS 音轨（`EXT-X-MEDIA`）是同一类问题。
- 加密的 DASH（Widevine / PlayReady / CENC）不做。
- 评估结论要写明：只拼接、能转封装，还是做不到。做不到就保持「仅复制」。

### 这一步故意不做

- 不解密，不绕 DRM，不伪造 Referer 或任何请求头。
- 不下载直播。
- 不重新编码。mux.js 不认识的编码保留 `.ts`。
- 不下载 mpd，也不把分开的音轨合并进视频（V2-3）。
- 不在 service worker 里跑分片循环或转封装。
