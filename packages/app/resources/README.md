# LittleSheep 应用图标资源

最后更新：2026-10-02

- `littlesheep-icon.png`：直接取自用户母图光照像素的 1024 × 1024 Void Ring 黑色球体图标，仅统一调整取景和尺寸，保留球面内侧反射和偏移蓝色光冠；主体直径约占画布 61%，底色为纯黑 `#000000` 圆角方形（圆角半径为边长的 20%，圆角之外透明）。`src/main/app-icon.ts` 的 `resolveAppPngIconPath` 用它渲染启动页等 renderer 表面。
- `littlesheep.ico`：从同一球体光照母版逐尺寸导出的 16、24、32、48、64、128、256 像素图标；原生窗口、托盘和 `electron-builder.yml` 的 `icon` 都优先使用它。

消费方固定为三处：`src/main/app-icon.ts`（窗口优先 `.ico`、启动页用 `.png`，并同时识别仓库与打包后的 resources 目录）、`scripts/refresh-desktop-shortcut.ps1`（按同目录路径读取 `.ico`）、`electron-builder.yml`（`buildResources` 与 `extraResources` 携带这两个文件）。这两个兼容文件名当前都已替换为 Void Ring，旧小羊图案不再用于这些产品表面。静态图标遵循纯黑圆角方形设计，圆角之外必须保持透明：直角黑块会让快捷方式在浅色桌面上重新显示成一个方块。透明外圈光晕仅用于动效素材。

这两个文件由 `packages/branding/assets/LS_VoidRing/tools/render_brand_assets.py` 的 `export_app_resources` 直接写出，不要再手工导出；重新生成后需要重跑 `pnpm run ensure:app-build`，因为 `resources/` 是应用构建指纹的输入之一。

四种可播放 Lottie 与局部亮弧的 SVG/CSS 参考见 [图标与动效实施说明](../../branding/assets/LS_VoidRing/README_implementation.md)。应用中的动效仍需接入 Renderer；当前产品资源替换更新静态图标，独立预览不证明真实 Electron 或安装包状态。
