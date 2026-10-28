# media-grabber 方案（MVP）

Chrome / Edge Manifest V3 扩展，**仅自用**。作用是识别当前页面里的音视频资源，列出来供复制或下载。

> 不做的事：不破解 DRM（Widevine、PlayReady、FairPlay 等），不绕过付费墙、登录或会员限制。HLS 标准 AES-128（密钥是普通的 http 或 https 文件，16 字节）可以在内存里解密。SAMPLE-AES 和任何 DRM 仍然拒绝。除第 12 节的 B 站分轨下载外，不修改请求头。

## 1. MVP 范围

| 能力 | MVP | 第二版 |
|---|---|---|
| 识别 `<video>`/`<audio>` 的 `src` 以及 `<source>` 子元素 | ✅ | |
| `blob:` / `data:` 地址标注为"无法直接下载" | ✅ | |
| 通过 webRequest 监听 mp4/webm/mp3/m4a/m3u8/mpd | ✅ | |
| 按 tab 去重存储 | ✅ | |
| popup 列表：类型 / 大小 / URL，复制链接 | ✅ | |
| 直链用 `chrome.downloads` 下载 | ✅ | |
| HLS / DASH 只复制清单链接 | ✅ | 点播下载见第 10 节 |
| 下载未加密 HLS 点播并按顺序拼接 | | ✅ V2-1 |
| TS 转封装成 mp4 | | ✅ V2-2 |
| 下载未加密 DASH 点播（音视频分文件保存） | | ✅ V2-3 |
| 下载标准 AES-128 的 HLS 点播 | | ✅ V3-1，见第 11 节 |
| 下载 B 站当前页能播的分轨 fMP4（视频、音频分开存） | | ✅ V3-2，见第 12 节 |
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
permissions: ["webRequest", "downloads", "storage", "tabs", "clipboardWrite", "offscreen", "declarativeNetRequestWithHostAccess"],
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
| `offscreen` | v2 才加。HLS / DASH 分片要在扩展页面里拼成 Blob。这个长任务不能放在会被回收的 service worker 里，所以用 `chrome.offscreen` 开一个不显示的文档。这个文档只能使用 `chrome.runtime`，会话存储和 `chrome.downloads` 仍由 service worker 调用。理由见第 10 节。 |
| `declarativeNetRequestWithHostAccess` | 只用于 B 站分轨下载。service worker 用 session 规则，在下载开始前给「正在下载的那一个媒体主机」补上页面的 Referer。它比 `declarativeNetRequest` 窄：改请求头还依赖已经声明的 `<all_urls>` 主机权限。不用于 HLS（含 AES-128 取密钥）、DASH 和普通直链。边界见第 12 节。 |

不申请的权限：`declarativeNetRequest`（主机权限已经是 `<all_urls>`，session 规则的 `modifyHeaders` 用更窄的 `declarativeNetRequestWithHostAccess`）、`scripting`（用静态 content script 就够了）、`cookies`、`debugger`。

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

1. **DRM / 加密**：带 EME 加密的内容（Netflix、付费平台等）不处理。HLS 的标准 AES-128（`METHOD=AES-128`，密钥格式是 identity 或缺省，密钥地址是 http 或 https）可以下载，见第 11 节。`METHOD=NONE` 不算加密。SAMPLE-AES、`KEYFORMAT` 不是 identity、清单里出现 FairPlay / Widevine / PlayReady 的迹象，都会用中文拒绝。密钥要能用普通请求拿到；401、403 或网络失败就停，不伪造请求头。
2. **blob: / MSE**：大多数现代播放器（YouTube 等）用 MediaSource 播放，`<video>` 上看到的是 `blob:`，无法直接下载；真实地址往往是分片或清单，只能靠 webRequest 去碰运气。B 站视频页没有 `.mpd`，分轨地址从页面脚本或 `*.bilivideo.com` 上的单个 `.m4s` 读取，见第 12 节。
3. **分片流**：未加密的 HLS 点播、标准 AES-128 的 HLS 点播，以及未加密的 DASH 静态点播可以下载，见第 10、11 节。DASH 的视频和音频通常是两条 fMP4，扩展会存成两个文件，不会合成一个。直播、SAMPLE-AES、DRM、多 Period、SegmentBase 不下载。AES-128 解密后的 MPEG-TS 会转封装成 fMP4；转失败或文件太大时仍保存 `.ts`。带 `#EXT-X-MAP` 的 fMP4 只做顺序拼接，这种清单如果同时还是 AES-128，会拒绝。B 站分轨见第 12 节，和 HLS 解密不是一条路径。
4. **大小未知**：分块传输、没有 `Content-Length`、或者只看到 Range 片段时，大小显示"未知"或不准。
5. **防盗链 / 鉴权**：有些链接依赖 Referer、Cookie 或会过期的签名，`chrome.downloads` 下载可能报 403，复制出去用也可能失效。普通直链、HLS 和 DASH 仍然不改请求头。只有 B 站分轨下载会给扩展自己的请求补上页面 Referer，而且只下页面现在就能播的内容。链接过期后要先刷新页面再下载。
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
  - 当时 HLS/DASH/blob 条目没有下载按钮，并带有说明文字。v2 起，http(s) 的 m3u8 / mpd 有自己的下载按钮，见第 10 节；blob 仍然没有。
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
| C1 | HLS m3u8 | hls.js 官方 demo 页（`hlsjs.video-dev.org/demo`），或 Apple 的 HLS 示例流 | 出现一条 HLS 清单，`.ts` 分片不出现在列表里。未加密点播可以下载；主清单要先选清晰度。直播、SAMPLE-AES、DRM 不能下 |
| C3 | AES-128 HLS | 自己用 ffmpeg 生成，见下面的步骤。这里不写死公开地址，避免链接失效后变成错的 | 清单标成可下载，备注里有「含 AES-128 加密」。下完是 `.mp4`（转失败则是 `.ts`）。把密钥地址改成 403 时，中文提示获取密钥失败，不会改请求头 |
| C2 | DASH mpd | dash.js 参考播放器（`reference.dashif.org/dash.js`） | 出现一条 DASH，`.m4s` 不出现。未加密静态点播可以下载；多种清晰度先选，默认最高视频。音视频分开时默认合并成一个 `.mp4`。合并失败、合计超过 1GB，或勾选「分开保存视频和音频」时存两个文件，并写明原因。直播、加密、SegmentBase 会用中文拒绝 |
| D | 多个 `<source>` 子元素 | 本地 `tests/pages/sources.html`（webm + mp4 两个 source） | 两个 source 都列出来 |
| E | blob / MSE 播放 | YouTube 任意公开视频 | DOM 条目标注 blob、不可下载；不报错 |
| I | B 站普通视频 | 自己账号能直接播放、不是会员专享的视频页 | 列出「B站视频 …」和「B站音频 …」。视频行的「下载视频」带上码率最高的音频，默认合并成一个 `.mp4`；视频行的「下载音频」存码率最高的 `.m4a`，音频行的「下载音频」存被点的这一条。页面没有音频时，「下载视频」只下视频，说明里写明没找到音频、视频没有声音。勾选「分开保存视频和音频」、合并失败或合计超过 1GB 时仍分成 `.mp4` 和 `.m4a`，并写明原因。403 用中文失败。链接过期就先刷新再下。切换分 P 后若页面脚本没更新，嗅探最多一条「B站 m4s 分轨文件」，并写明类型未知 |
| F | 动态插入 | 在任意页面控制台执行 `document.body.append(Object.assign(document.createElement('video'),{src:'<mp4 URL>'}))` | 1 秒内出现 |
| G | 无媒体页面 | `example.com` | 空列表提示，badge 不显示 |
| H | 文件名边界 | 本地页面，title 里含特殊字符 | 下载文件名合法 |

通用检查项：
- [ ] Chrome 和 Edge 都能加载并正常工作
- [ ] 切换 tab 后 popup 只显示当前 tab 的资源
- [ ] 刷新页面后旧数据被清掉；SPA 路由切换不清空
- [ ] 关掉 tab 后存储里没有残留（DevTools → Application → Storage 查看）
- [ ] SW 被停止后再打开 popup，数据还在
- [ ] 弹窗里能下载的条目在前面，blob、data 和没有下载按钮的在后面。同一组里原来的先后不变。下载进行中，列表不因为状态变化而跳动
- [ ] 扩展的 errors 页面没有报错
- [ ] 访问带 DRM 的页面时扩展不做任何绕过，只按普通资源规则列出能看到的 URL
- [ ] 未加密 HLS 点播：主清单能选清晰度（默认最高），进度条会走，取消有效，关掉 popup 再打开还能看到进度
- [ ] 直播 m3u8、SAMPLE-AES、非 identity 的 KEYFORMAT、带 Widevine / PlayReady / FairPlay 迹象的清单会用中文拒绝，不会开始下分片
- [ ] 标准 AES-128 点播可以下载。条目备注写「含 AES-128 加密」。密钥返回 401、403 或不是 16 字节时，用中文停下来，不伪造 Referer 或其他请求头
- [ ] 未加密的 DASH 点播：多清晰度能选（默认最高视频），进度条会走，取消有效。视频和音频分开时默认合并成一个 `.mp4`，合并中显示「正在合并…」，关掉弹窗再打开还能看到。合并失败、合计超过 1GB，或勾选「分开保存视频和音频」时保存两个文件，并写明原因。直播、ContentProtection、多个 Period、SegmentBase 会用中文拒绝
- [ ] 下载出来的文件：普通 TS 转封装成功时是 `.mp4`（fMP4，没有重编码，文件头时长是实际总时长）；转封装失败时是 `.ts`，条目上写明可用 VLC 播放。带 EXT-X-MAP 的 fMP4 仍是顺序拼接的 `.mp4`。AES-128 解密成功但转封装失败时，保存的 `.ts` 是明文，不是密文
- [ ] B 站（第 12 节）：只下当前页能播的内容，不处理会员专享。下载进行时，在 service worker 控制台执行 `chrome.declarativeNetRequest.getSessionRules()`，应看到 id 在 910001–910032 的规则：`tabIds` 为 `[-1]`，`requestDomains` 只有正在下载的媒体主机，请求头只有 Referer，值是视频页的 origin 加 `/`。成功、失败、取消或关掉后台页之后，这些规则消失。用户正常浏览不受影响。HLS（含取 AES-128 密钥）、DASH 和普通直链下载不会多出这类规则

自己做一条 AES-128 测试流（在空目录里执行；需要 ffmpeg）。没有写死公开测试地址。

```bash
openssl rand 16 > enc.key
ffmpeg -f lavfi -i testsrc=size=320x180:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 6 -c:v libx264 -pix_fmt yuv420p -c:a aac -hls_time 2 -hls_playlist_type vod -hls_enc 1 -hls_enc_key enc.key -hls_enc_key_url enc.key -hls_segment_filename "seg%03d.ts" index.m3u8
python -m http.server 8080
```

再写一个本地页面，里面放 `<video src="http://127.0.0.1:8080/index.m3u8" controls></video>`，用浏览器打开。Chrome 不一定能直接播 m3u8，但扩展会认出这个地址。弹窗里点下载。密钥地址是相对的 `enc.key`，会解析成 `http://127.0.0.1:8080/enc.key`。

## 10. v2

MVP（T1–T8）只把 m3u8 / mpd 列出来供复制。v2 分成三步。V2-1、V2-2、V2-3 都已做。

### V2-1 HLS 下载（本次）

未加密的点播 m3u8 可以在 popup 里下载。这一步还没有做 mpd 下载，见 V2-3。

1. **解析**（`src/shared/hls.ts`，纯函数）
   - 主清单读出各条 `#EXT-X-STREAM-INF` 的 `BANDWIDTH` / `RESOLUTION`。按带宽从高到低排，默认选最高。
   - 媒体清单读出分片。相对地址用标准 URL 规则拼到清单上（不把清单 query 里的 token 抄到分片上）。
   - `#EXT-X-MAP` 是 fMP4 初始化段，拼在分片前面。有它就存 `.mp4`。没有的话先按 TS 下载，再由 V2-2 转封装。
   - `#EXT-X-DISCONTINUITY` 允许，分片仍按出现顺序接成一个文件。
2. **明确拒绝，并给中文原因**
   - 没有 `#EXT-X-ENDLIST` 的直播。
   - 任何 `#EXT-X-KEY`（`METHOD=NONE` 除外）和 `#EXT-X-SESSION-KEY`。AES-128、SAMPLE-AES 都不做。项目当时约定不处理加密或 DRM。标准 AES-128 后来在 V3-1 做了，见第 11 节。
   - `#EXT-X-BYTERANGE`、`#EXT-X-GAP`、`#EXT-X-SKIP`、关键帧预览、图片清单、中途更换初始化段、看起来像 fMP4 但没有 MAP。广告打点标签忽略。
3. **下载引擎**
   - 长任务放在 `chrome.offscreen` 的文档里（`src/offscreen/`），不放在 service worker。因此 manifest 增加 `offscreen` 权限。
   - offscreen 文档只能使用 `chrome.runtime`。它只负责拉分片和拼接。进度通过消息发给 service worker，由 service worker 串行写入 `chrome.storage.session`。旧任务晚到的进度不能盖住后开始的那一次。
   - 同时拉 4 片。每一片失败后再试 2 次。可以取消。进度是已下载片数 / 总片数，popup 关掉再打开还在。
   - `fetch` 不设置 `headers`，不伪造 Referer，不用 `declarativeNetRequest`。`credentials: 'include'` 只带浏览器里已经有的 Cookie。
4. **输出和内存**
   - 按顺序拼成一个 Blob，再 `URL.createObjectURL`。offscreen 把这个地址和文件名发给 service worker，由 service worker 调用 `chrome.downloads.download`（只传 `url` / `filename` / `saveAs` / `conflictAction`，不加请求头）。收到回复后再过约 60 秒撤销这个地址。文件名用现有的 `buildDownloadFilename`。
   - 用带宽 × 时长估算体积。预计或实际超过 2GB 就拒绝，中文说明是为了避免占满内存，并且不保存半成品。
   - 预计达到 512MB，或分片达到 300 个，先给中文警告，仍允许下载。
   - 主清单里某条清晰度带了 `AUDIO` 组时，警告声音可能在另一条清单里。本次不合并音轨。
5. **Popup**
   - m3u8 上「复制」还在，旁边多一颗「下载」。当时 mpd 仍然只有复制。
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

- 每一片单独转。下一片的时间轴接在上一片结束之后，所以 `EXT-X-DISCONTINUITY` 里时间戳归零也不会叠到同一段。分片里的 `tfdt`（`baseMediaDecodeTime`）保持 mux.js 写出的值，不改。
- 转封装进行时，popup 显示「正在转成 mp4…」，可以取消。
- 转不出（例如 H.265、AC-3，或 mux.js 抛错）时，整次下载不算失败：保存原来的 `.ts`，条目写「转封装失败，已保存为 .ts，可用 VLC 播放」。
- 已下载字节超过 1GB 时不再转。转完的 mp4 若超过 2GB 也不采用。两种情况都改存 `.ts`，并说明是为了避免占满内存。
- 声音在另一条音轨清单里时，仍然只下这一路，不合并。
- mux.js 把初始化段里 `mvhd` 和每个 `tkhd` 的 duration 写成 `0xFFFFFFFF`（未知）。`mvhd` 的 timescale 是 90000，只读文件头的播放器会把时长显示成约 13 小时（4294967295 / 90000）。全部转完、已经知道最后一片的 `nextBaseMediaDecodeTime`（90kHz）之后，把这个总时长写回初始化段的一份拷贝：`mvhd.duration` 和每个 `tkhd.duration` 用 movie timescale，每个 `mdhd.duration` 用该轨自己的 timescale（总秒数 × 该轨 timescale）。box 对不上、找不到这些字段，或 version 0 装不下这个 32 位时长时，保持原来的初始化段，下载仍然成功。DASH 的 mp4 仍是源文件原样保存，不走这次修补。

输出是 fragmented MP4。Chrome、Edge、VLC 通常能播。初始化段里的时长是实际总时长，Windows 文件属性或播放器应显示真实时长（Big Buck Bunny HD 约 10 分 34 秒），而不是约 13 小时。系统自带播放器能不能解码这种 fMP4，仍要在真实环境里看文件。

### V2-3 DASH（mpd）下载（已完成）

**结论：未加密的静态点播，用 SegmentTemplate 或 SegmentList 寻址时，可以下载。这一步当时把视频和音频各存一份。两路 fMP4 的合并后来在第 13 节做了，不经过 mux.js。**

#### 解析

`src/shared/dash.ts` 用 DOMParser 读一份 MPD。只接受 `type="static"`（缺省也当作 static）且只有一个 Period。

- AdaptationSet / Representation：只收下 `video/mp4` 和 `audio/mp4`、`audio/m4a`。字幕、图片、WebM 跳过。多条视频按带宽（再按分辨率）从高到低排，默认最高。多条音轨时，优先 `Role` 为 main 的里带宽最高的一条，否则选带宽最高的。
- SegmentTemplate：继承 Period → AdaptationSet → Representation。支持 `$RepresentationID$`、`$Bandwidth$`、`$Number$`、`$Number%0Nd$`、`$Time$` 和 `$$`。不认识的占位直接拒绝。`SegmentTimeline` 的 `t` / `d` / `r`（含 `r="-1"`，用 Period 时长收口）会展开。没有时间轴时用 `duration` + `timescale` + 时长，或 `endNumber`。`startNumber` 默认 1。
- SegmentList：按列出的 Initialization 和 SegmentURL 下载，相对地址用 `new URL` 拼到清单上。
- BaseURL 从 MPD、Period、AdaptationSet、Representation 串起来。只取每一层的第一个 BaseURL。清单 query 里的 token 不会抄到相对分片上。
- 初始化段是必须的。媒体段接在它后面，和 HLS 的 fMP4 一样按顺序拼成一个文件。
- 分片上限 20000。体积估算复用 HLS 的 2GB 拒绝和 512MB / 300 片警告。

#### 音视频分轨

常见清单是一个视频 AdaptationSet 加一个音频 AdaptationSet。扩展会把两路都下完。

mux.js 的 Transmuxer 只吃 MPEG-TS（以及 AAC），不能把两路已经是 fMP4 的轨合成一个可播文件。自己拼 `moov` / `moof` 对不齐时间轴，系统播放器也经常打不开，所以不做这种半成品合并。HLS 里 `EXT-X-MEDIA` 分开的音轨仍是同一类问题，这一步也不合并。

产品方案（V2-3 当时）：视频存 `.mp4`，音频存 `.m4a`，文件名仍用页面标题和列表序号，靠扩展名区分。条目上写「视频和音频是分开的，将保存成两个文件。扩展不能把两路 fMP4 合成一个文件」。只有一路时存一个文件，完成文案仍是「已完成」。视频保存成功、音频保存失败时，写「视频已保存，音频保存失败」。第 13 节改为默认合并，失败或用户选择分开时才回到这两个文件。

#### 明确不做

- 直播 MPD（`type="dynamic"`）。
- 任何 `ContentProtection`（Widevine、PlayReady、CENC 等）。出现就整份拒绝。
- 多个 Period 的复杂时间线。
- 字幕轨下载或合并。
- SegmentBase。它要靠 `Range` 请求头按字节截取，而扩展不设置任何自定义请求头，也不伪造 Referer。
- WebM（`video/webm` / `audio/webm`）。
- 伪造 Referer 或任何自定义请求头。`fetch` 仍是不带 `headers`、`credentials: 'include'`。

#### 和 HLS 的复用

- 下载跑在同一个 offscreen 文档里（`src/offscreen/dash-task.ts`），不进 service worker。解析器不打进后台包。没有新权限。offscreen 只拉取和拼接；进度写入和 `chrome.downloads` 与 HLS 一样交给 service worker。视频和音频两个文件都这样保存。
- 进度、取消、并发 4、失败后再试 2 次，都走原来的 `downloadSegmentsInOrder`。
- 任务记录形状和 HLS 相同，单独放在 `chrome.storage.session` 的 `dash-jobs`。offscreen 把记录发给 service worker 再写入。关掉 popup 再打开还能看到。同一时间只允许一个 HLS、DASH 或 B 站下载。
- 文件名用 `buildDownloadFilename`。直接把 `.mpd` 交给 `chrome.downloads` 会被拒绝，并提示用列表里的下载。

### 这一步故意不做

- v2 不解密。标准 AES-128 见第 11 节。SAMPLE-AES 和 DRM 仍然不做。HLS 和 DASH 不伪造 Referer 或任何请求头。B 站分轨是第 12 节的例外。
- 不下载直播。
- 不重新编码。mux.js 不认识的编码保留 `.ts`。
- v2 不把分开的音视频合成一个文件。两路 fMP4 的合并在第 13 节，用纯 TypeScript 改 box，不用 mux.js，也不重编码。
- 不在 service worker 里跑分片循环或转封装。

## 11. V3-1 HLS 标准 AES-128

V3-1 没有新权限。版本号在 V3-2 升到 0.2.1，见第 12 节。

只解密点播清单里的 `METHOD=AES-128`。

1. **解析**（`src/shared/hls.ts`）
   - `KEYFORMAT` 缺省或 `identity` 才接受。密钥 `URI` 必须是 http 或 https，相对地址按清单解析，不把清单 query 里的 token 抄过去。
   - 有 `IV` 就用那 16 字节（`0x` 开头的十六进制，左边补零）。没有就用该片的 media sequence，按大端放进 16 字节。`EXT-X-MEDIA-SEQUENCE` 缺省是 0，每片加 1。
   - 新的 `EXT-X-KEY` 只影响它后面的分片。`METHOD=NONE` 之后的分片不再加密。
   - `EXT-X-SESSION-KEY` 不拿来解密。它若是 AES-128 identity，忽略；若是 SAMPLE-AES 或 DRM，整份清单拒绝。
2. **仍然拒绝，并给中文原因**
   - `METHOD=SAMPLE-AES`（含 SAMPLE-AES-CTR）。
   - `KEYFORMAT` 不是 identity。
   - 起始清单里有 DRM 迹象：`com.apple.streamingkeydelivery`、`skd://`、Widevine URN `edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`、PlayReady URN `9a04f079-9840-4286-ab92-e65be0885f95`，以及 `com.widevine`、`com.microsoft.playready`。
   - 密钥不是 16 字节，或加密分片长度不是 16 的整数倍。
   - 带 `EXT-X-MAP` 的 AES-128。解密后要走 TS 转封装，fMP4 初始化段这条路径不做。
   - 直播和 `EXT-X-BYTERANGE` 跟以前一样拒绝。
3. **取密钥和解密**（`src/shared/hls-aes.ts`，在 offscreen 页面里调用）
   - 和分片一样用普通 `fetch`：不设置 `headers`，不伪造 Referer、Cookie 或 UA，不用 `declarativeNetRequest`。`credentials: 'include'` 只带浏览器里已经有的 Cookie。
   - 401、403、404、网络失败或密钥长度不对，就停，中文说明是获取密钥失败。不去绕。
   - 同一个密钥地址只请求一次。密钥中途换地址时再取新的。
   - `crypto.subtle` 做 AES-CBC。浏览器会去掉 PKCS7 填充。不引入新的依赖。
   - 明文第一个字节必须是 TS 同步字节 `0x47`，否则报「解密失败（密钥或 IV 不对）」。
   - 密钥字节和明文不进 `chrome.storage`，不进日志，不显示在弹窗里。界面上只写「含 AES-128 加密」。
4. **之后的路径**
   - 明文分片交给现有的 TS→mp4 转封装。转失败或太大时，仍保存 `.ts`，保存的是解密后的 TS，不是密文。
   - offscreen 页面仍然只用 `chrome.runtime`。进度和 `chrome.downloads` 交给 service worker。解密只用 `crypto.subtle` 和普通 `fetch`。

## 12. V3-2 B 站分轨

B 站网页播放器没有 `.mpd`。视频和音频是两个独立的 fMP4（`.m4s`），播放器用 Range 请求拉下来交给 MSE。`<video>` 上通常是 `blob:`，所以旧版弹窗里没有可下载项。CDN（`*.bilivideo.com` / `*.bilivideo.cn`）没有 Referer 会回 403。

### 识别

- 内容脚本在隔离世界里读不到 `window.__playinfo__`。它只读取页面上 `<script>` 的文本，截取 `window.__playinfo__ =` 后面的 JSON，用 `JSON.parse` 解析，不用 eval。解析失败就忽略这一段，不报错。
- 从 `data.dash.video[]` 和 `data.dash.audio[]` 取 `baseUrl` 或 `base_url`、画质 id、宽高、codecs、bandwidth。有 `accept_description` / `accept_quality` 时，把画质 id 转成「1080P」这类文字。弹窗标签类似「B站视频 1080P · AVC」「B站音频 192kbps」。不列出 `backupUrl` / `backup_url`。
- 老式 `durl` 只收扩展名是 mp4 的直链，同样走下面的 Referer 规则。flv 忽略。
- 单页切换分 P 或下一个视频时，`__playinfo__` 可能不更新。嗅探只认 B 站 CDN 上的 `.m4s`，用去掉字节范围参数后的地址去重，避免同一个文件的多次 Range 请求列成一堆。其它站点的 `.m4s` 分片仍然不进列表。嗅探分不清音视频时，标签是「B站 m4s 分轨文件」，说明里写明类型未知。下载后用响应的 Content-Type，或 moov 里 handler（`vide` / `soun`）决定 `.mp4` 还是 `.m4a`。判断不了就存 `.mp4`，并写明没能判断。

### 下载

0.2.1 当时的弹窗是「下载视频」「下载音频」；列表里同时有音频时，视频行还有「下载视频+音频」，会带上带宽最高的那条音频。一起下载时各存 `.mp4` 和 `.m4a`。0.2.2 起，带上音频的那一次默认合并成一个 `.mp4`，见第 13 节。分开保存时仍靠扩展名区分。

0.2.3 起，视频行是两颗按钮。「下载视频」就是原来的「下载视频+音频」：带上页面里带宽最高的音频，默认合并成一个 `.mp4`；勾选「分开保存视频和音频」、合并失败或合计超过 1GB 时仍分成 `.mp4` 和 `.m4a`。视频行的「下载音频」保存带宽最高的那条，扩展名 `.m4a`；音频行的「下载音频」保存被点的这一条。找不到音频轨时用中文说明，不静默失败。页面里没有可配对的音频时，不再另做一颗无声按钮：「下载视频」只下这一路视频，条目说明写「没找到音频，下载的视频没有声音」。进度、取消、失败提示和 2GB 内存上限仍复用现有任务。文件名仍用页面标题。「分开保存视频和音频」只对带音频的「下载视频」有意义。没有新权限。

弹窗展示时把能下载的条目放在前面。直链、HLS、DASH 和 B 站分轨都算有下载按钮。blob、data，以及没有下载按钮的条目放在后面。每一组保持嗅探时的先后。排序不改已经存下的列表，也不看下载进行到哪一步，所以点开始或进度变化时列表不跳动。

长下载在 offscreen 页里做。这个页面只用 `chrome.runtime` 和普通 Web API。进度和 `chrome.downloads` 仍发给 service worker。offscreen 里的 `fetch` 不设置 `headers`。它和 HLS、DASH 共用同一个下载槽，同一时间只能有一个。

### Referer 规则边界

1. 只用 `chrome.declarativeNetRequest.updateSessionRules`。这个 API 在 offscreen 页里不能用，只能由 service worker 调用。下载开始前先加规则，再通知 offscreen。成功、失败、取消、offscreen 不再跑这条任务，都会删规则。service worker 启动时清掉本扩展残留的规则。规则 id 固定在 910001–910032，只删除这个区间。
2. 每条规则的 `requestDomains` 只有正在下载的那一个媒体主机（不填父域 `bilivideo.com`，因为 Chrome 还会匹配子域）。`tabIds` 只有 `-1`，也就是只匹配不从标签页发出的请求，不影响正常浏览。`resourceTypes` 只有 `xmlhttprequest`：offscreen 里的 `fetch()` 在 Chromium 里按 RequestDestination 为空的子资源处理，declarativeNetRequest 把它记成 `xmlhttprequest`，不是 `media`（那是 video/audio 元素自己拉的）。
3. `action` 是 `modifyHeaders`，只设置一个请求头：Referer，`operation` 为 `set`。值是触发下载的标签页 URL 的 origin 再加 `/`，例如 `https://www.bilibili.com/`。只接受 http / https 页面。不改 Cookie、User-Agent、Origin 或任何其它头。
4. 不处理登录权限，不绕过会员或付费限制，不处理 DRM，不碰 Widevine。401 / 403 直接用中文报错，不重试、不换地址。这套规则不用于 HLS（包括取 AES-128 密钥）、DASH 和普通直链。

当前版本是 0.2.3。0.2.2 是第 13 节的合并。0.2.1 用来和 0.2.0 的构建区分。

## 13. V3-3 两路 fMP4 合并成一个 mp4

版本 0.2.2。没有新权限，也不改 Referer 规则的边界。合并发生在本机内存里，不发请求。不处理 DRM，也不处理会员专享。

### 合并器

`src/shared/fmp4-merge.ts` 的 `mergeFmp4(video, audio)` 是纯函数，可以单测。不重新编码，不引入 ffmpeg.wasm 或别的运行时依赖。mux.js 只能把 MPEG-TS 转成 fMP4，合并不了两路已经是 fMP4 的轨，所以这里不调用它。

输入是两条单轨 fMP4：`ftyp`、`moov`，可以有 `sidx` / `styp`，然后若干 `moof`+`mdat`。DASH 把初始化段和媒体段按顺序接在一起，也是这种文件。

输出是 `ftyp` + 一份新的 `moov` + 按时间交错的 `moof`+`mdat`。

- 视频 `trak` 的 `track_ID` 写成 1，音频写成 2。`tkhd`、`mvex`/`trex`、每个 `moof` 里的 `tfhd` 都用这个新编号。`mvhd.next_track_ID` 写成 3。
- 两轨 timescale 可以不同。交错时把 `tfdt` 换成秒再比（整数交叉相乘，避免直接比原始刻度）。时间相同先放视频。
- `mvhd.duration` 取两轨里较长的一条，换算到视频那份 `mvhd` 的 timescale。四舍五入和 `src/shared/hls-remux-duration.ts` 一样：`(ticks * 目标 timescale + 源 timescale / 2) / 源 timescale`。各轨自己的 `tkhd` / `mdhd` 用该轨的时长，不用较长的那条去盖住较短的音轨。`empty_moov` 把这些时长写成 0 时，从分片的 `tfdt` 和样本时长加出来。
- `sidx`、`styp`、`mfra` 丢掉。丢掉之后按新文件里的位置重写 `trun` 的 `data_offset`，并给 `tfhd` 加上 `default-base-is-moof`。原来如果有 `base-data-offset`，先按它找到紧随的 `mdat` 里的样本，再改成相对 `moof` 的偏移。样本不在这个 `mdat` 里就拒绝，避免留下失效的绝对偏移。
- 只读输入，不改传入的数组。box 的 size 越界、对不齐，都拒绝。

### 不支持时的回退

多轨、加密（`encv` / `enca` / `sinf` / `senc`）、找不到 `moov`、盒子越界、不是 fMP4，都返回中文原因。下载不因此失败：仍按原来的方式保存两个文件，条目上写「无法合并（原因），已分开保存视频和音频」。

两路合计超过 1GB 时不调用合并器，避免内存里再放一份同样大的结果，同样分开保存，并说明是为了避免占满内存。

弹窗标题下面有「分开保存视频和音频」，默认不勾。勾上之后，B 站的「下载视频」（带上音频的那一次）和 DASH 点播都不合并，完成文案是「已按选择分开保存视频和音频」。只下一路时这个勾选不起作用。「下载音频」和找不到音频时的「下载视频」都不看这个勾选。

合并进行时条目写「正在合并…」，阶段是 `merging`，可以取消。取消后不保存合并结果。这个阶段记在 `chrome.storage.session` 里，关掉弹窗再打开还能看到；后台页如果中途没了，会和其他进行中的任务一样标成中断。

文件名仍用 `buildDownloadFilename`。合并后的扩展名是 `.mp4`。分开保存时视频 `.mp4`、音频 `.m4a`，和以前一样靠扩展名区分。
