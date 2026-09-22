# LittleSheep 应用图标资源

最后更新：2026-09-22 12:57:18

- `littlesheep-icon.png`：去除背景后的透明源图；`src/main/app-icon.ts` 的 `resolveAppPngIconPath` 用它渲染启动页等 renderer 表面。
- `littlesheep.ico`：包含多个 Windows 尺寸的透明图标；原生窗口、托盘和 `electron-builder.yml` 的 `icon` 都优先使用它。

消费方固定为三处：`src/main/app-icon.ts`（窗口优先 `.ico`、启动页用 `.png`，并同时识别仓库与打包后的 resources 目录）、`scripts/refresh-desktop-shortcut.ps1`（按同目录路径读取 `.ico`）、`electron-builder.yml`（`buildResources` 与 `extraResources` 携带这两个文件）。替换图标时应同时更新这两个文件，并保持透明背景。
