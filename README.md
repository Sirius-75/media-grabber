> **本项目通过 vibe coding 方式由 AI 生成实现，仅供个人自用。**

# Media Grabber

Chrome / Edge Manifest V3 扩展。当前是 T1 工程脚手架：能构建、能以开发者模式加载，background / content / popup 只有占位入口，还不会识别或下载媒体。完整设计见 [PLAN.md](./PLAN.md)。

不破解 DRM，不绕过登录或付费墙。

## 环境

- Node.js 22+
- Chrome 或 Edge

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
