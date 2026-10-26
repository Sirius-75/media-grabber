> **本项目由 AI 通过 vibe coding 完成。** 仅供个人自用。

# Media Grabber

这是一个装进 Chrome 或 Edge 的小工具。打开带视频或音频的网页，点一下工具栏图标，就能看到页面里的音视频地址，复制链接，或者把能直接保存的文件下载下来。

它不处理加密视频，也不帮你绕过付费或登录。

## 能做什么

- 找出当前标签页里的视频、音频，以及 HLS / DASH 清单地址。
- 列表里显示类型、大小（没有大小就显示「未知」）和地址。
- 每条都可以复制完整链接。
- mp4、webm、mp3、m4a 这类直链可以下载到系统的下载文件夹。
- 下载开始后，条目上显示「已开始下载」，下完显示「已完成」。失败会写出原因，关掉弹窗再打开还能看到最近一次。

## 不做什么

- **不处理 DRM。** Netflix 这类用 Widevine 加密的视频，扩展不会去破解。
- **不绕过付费或登录。** 不会伪造 Referer 或其他请求头，也不会改你的网络请求。
- **不会把 HLS / DASH 分片下载再合并。** 这一版只能复制清单链接。下载合并留到以后的版本（v2）。
- **不支持 Safari。** 目前只做 Chrome 和 Edge。

## 你需要先准备

- 一台能装 Chrome 或 Edge 的电脑。
- Node.js：**20.19.0 或更新的 20.x**，或者 **22.12.0 及以上**（Node 24 可以用）。不要用 Node 21，它不在这个范围里。

查看版本：在终端里输入 `node -v`。如果版本不对，去 [nodejs.org](https://nodejs.org/) 安装一个符合要求的版本，装完重新打开终端再查一次。

版本太旧时，后面的构建会报找不到 `rolldown-binding`。那是打包器自带的文件，不是你少下了别的东西，把 Node 换成上面的版本即可。

## 在 Windows PowerShell 里安装和构建

1. 安装好 Node.js（见上一节）。
2. 打开项目文件夹。可以在资源管理器地址栏输入 `powershell` 后回车，这样终端已经位于项目目录。
3. 确认版本，然后安装依赖并构建：

```powershell
node -v
npm install
npm run build
```

构建成功后，项目里会出现 `dist` 文件夹。下一步要加载的就是它。

如果 PowerShell 弹出下面这种提示，是 Windows 的执行策略拦住了 `npm.ps1`，不是项目坏了：

```text
无法加载文件 C:\Program Files\nodejs\npm.ps1，因为在此系统上禁止运行脚本。
```

任选一种处理：

- 只给当前用户放开本地脚本（推荐）。执行下面这一行，关掉 PowerShell 再打开，然后重新 `npm install`：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

- 不想改策略的话，改用 cmd 版的 npm，后面的命令也写成 `npm.cmd`：

```powershell
npm.cmd install
npm.cmd run build
```

macOS 和 Linux 没有这条执行策略。打开「终端」，`cd` 到项目目录，同样执行 `npm install` 和 `npm run build`。

## 加载到浏览器

Chrome 和 Edge 都不能直接双击 zip 安装。要加载的是一个文件夹。

1. 地址栏输入 `chrome://extensions` 后回车。Edge 则输入 `edge://extensions`。
2. 打开右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」。
4. 选中项目里的 **`dist`** 文件夹。不要选仓库最外层的文件夹。
5. 列表里出现 **Media Grabber**（版本 0.1.0）。如果工具栏没看到图标，点拼图图标，把它固定出来。

想发给自己另一台电脑时，可以先打包：

```powershell
npm run package
```

它会先构建，再在 `release` 里生成 `media-grabber-0.1.0.zip`。zip 的根目录就是 `manifest.json`。把 zip 解压，然后对解压出来的文件夹再做一次「加载已解压的扩展程序」。`release` 不会提交到 git。

## 怎么用

1. 打开一个有视频或音频的网页，让它播放一下。
2. 点工具栏上的 Media Grabber。
3. 弹窗里列出找到的资源。地址太长会被截断，鼠标停在上面能看全文。
4. 点「复制」，完整链接会进剪贴板，按钮会短暂显示「已复制」。
5. 普通直链旁边有「下载」。文件名来自页面标题；标题不能用时，用链接里的文件名。系统里已有同名文件时，浏览器会自动改名，不会覆盖。
6. 点「清空」只清掉**当前标签页**的记录。换一个标签页，列表也换成那一页的。

HLS、DASH，以及 `blob:` / `data:` 地址，没有下载按钮，旁边会写原因。YouTube、B 站很多播放器看到的是 blob，真实文件是分片，这一版下不下来。

## 已知限制

- **HLS / DASH 只能复制清单链接。** 分片不会列出来，也不会下载合并。那是 v2 才做的事。需要的话，把链接交给 ffmpeg 或 yt-dlp。
- **有些网站的直链会 403。** 链接可能要登录、带 Cookie，或者过一会儿就失效。扩展不会伪造请求头去绕过。失败时弹窗写「服务器拒绝访问（403）」或「网络连接失败」，不会一直转圈。
- **Safari 暂不支持。** Firefox 也不在范围内。请用 Chrome 或 Edge。
- 关掉浏览器后，列表会被清掉。这是故意的：记录只放在这一次浏览器会话里。
- 刷新页面会清掉旧记录。网页自己换路由（地址变了但没有整页刷新）则保留。
- 大小有时是「未知」，因为服务器没告诉浏览器文件有多大。

## 项目结构

```text
media-grabber/
├── manifest.config.ts    扩展的名字、版本、权限和入口
├── package.json          依赖和命令
├── README.md             本说明
├── PLAN.md               设计说明
├── scripts/package.mjs   把 dist 打成 zip
├── public/icons/         图标
├── src/
│   ├── background/       后台：发现网络里的媒体、保存列表、下载
│   ├── content/          在网页里查找 video / audio
│   ├── popup/            点图标后弹出的窗口
│   └── shared/           大家共用的类型和判断
├── tests/                自动测试
├── dist/                 npm run build 之后出现，加载这个文件夹
└── release/              npm run package 之后出现，里面是 zip
```

## 开发命令

在项目目录执行。开发时让 `npm run dev` 一直开着，浏览器里加载的仍然是 `dist`。

| 命令 | 做什么 |
|---|---|
| `npm install` | 第一次下载依赖 |
| `npm run dev` | 开发模式。改完弹窗文案，已打开的弹窗会自己更新 |
| `npm run build` | 做出可以离线加载的 `dist`。关掉终端也能用 |
| `npm run package` | 先构建，再打出 `release/media-grabber-<版本>.zip` |
| `npm test` | 跑自动测试 |
| `npm run typecheck` | 检查 TypeScript 类型 |

想看后台有没有发现媒体：打开 `chrome://extensions`，在 Media Grabber 卡片上点「Service Worker」。播放一个带普通 mp4 的页面后，控制台里会出现 `[media-grabber] 发现媒体`。`.ts` / `.m4s` 分片不会被当成一条新记录。

更细的设计见 [PLAN.md](./PLAN.md)。
