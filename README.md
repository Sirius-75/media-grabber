> **本项目通过 vibe coding 方式由 AI 生成实现，仅供个人自用。**

# Media Grabber

Chrome / Edge Manifest V3 扩展。共享层按扩展名和 Content-Type 判断媒体。Content script 在隔离环境里扫描本 frame 的 `<video>` / `<audio>`（含 `currentSrc` 和 `<source>`），有变化才把结果发给后台。background / popup 仍是占位，打开扩展还不会列出资源。完整设计见 [PLAN.md](./PLAN.md)。

不破解 DRM，不绕过登录或付费墙。

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

## 构建与检查

```bash
npm run build      # 产物在 dist/
npm test           # Vitest
npm run typecheck  # tsc --noEmit，strict
```

构建完成后，用上面同样的方式加载 `dist`。这次的目录不依赖开发服务器，关掉终端也能用。
