# LittleSheep 应用图标资源

最后更新：2026-10-02

- `littlesheep-icon.png`：直接取自用户母图光照像素的 1024 × 1024 Void Ring 黑色球体图标，仅统一调整取景和尺寸，保留球面内侧反射和偏移蓝色光冠；主体直径约占画布 61%，底色为纯黑 `#000000` 圆角方形（圆角半径为边长的 20%，圆角之外透明）。它保留静态应用图标兼容入口，界面表面优先使用 `void-ring/mark.png`。
- `littlesheep.ico`：从同一球体光照母版逐尺寸导出的 16、24、32、48、64、128、256 像素图标；原生窗口、托盘和 `electron-builder.yml` 的 `icon` 都优先使用它。

消费方为 `src/main/app-icon.ts`（窗口优先 `.ico`，界面表面优先透明 `.png`，兼容仓库与打包资源路径）、`scripts/refresh-desktop-shortcut.ps1`（读取 `.ico`）与 `electron-builder.yml`（携带资源）。桌面、托盘与安装器继续使用已确认的黑色圆角底板。启动页、对话、任务条和思考行直接使用黑色球体与柔和光晕，球体之外透明，不添加独立黑色底板。

这两个文件由 `packages/branding/assets/LS_VoidRing/tools/render_brand_assets.py` 的 `export_app_resources` 直接写出，不要再手工导出；重新生成后需要重跑 `pnpm run ensure:app-build`，因为 `resources/` 是应用构建指纹的输入之一。

`void-ring/` 由设计素材的 `tools/export_app_motion.py` 导出：三份 384px 无损 WebP 包含完整内圈反光、亮边与外晕，外部透明、球体不透明，分别用于待机、加载和思考；`startup.webp` 为同一呼吸素材的 128px 版本；`mark.png` 为透明静态回退与展开过渡。Renderer 通过 Vite 打包循环素材及透明静态图；Main 读取小尺寸启动素材与透明静态图，打包配置将这两份复制到 `resources/void-ring/`。增加动效后须重新构建应用。

四种可播放 Lottie、内外光晕 SVG/CSS 参考及导出方式见 [实施说明](../../branding/assets/LS_VoidRing/README_implementation.md)。真实产品接入包含启动呼吸、空白对话呼吸及一次展开、历史读取、顶部任务条与运行中的思考行。独立素材、真实 Electron 验收与安装包验证分别记录，不能互相代替。
