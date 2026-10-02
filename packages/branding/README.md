# @littlesheep/branding

定义 LittleSheep 的品牌配置、默认用户数据目录名称、稳定路径布局，以及可复用的品牌图形素材。

最后更新：2026-10-02

## 职责与边界

- 运行时公开入口是 `src/index.ts`；品牌配置、数据目录解析和数据根 locator 文档形状集中在此。
- `assets/LS_VoidRing/` 拥有 Void Ring 品牌图标及动效交付物；该目录是设计资源，不会被 TypeScript 构建或自动写入用户数据。
- 提供 `loadBranding`/`parseBranding`、`resolveDataDir`/`resolveDefaultDataDir`、`dataSubdirs`（sessions、memory、skills、config、quarantine、backups、experience、archive、vectors、execution-logs、channels、plugins、plugin-data、attachment-cache、workplace）和 `readDataRootLocator`/`parseDataRootLocator`。
- 只拥有命名、路径解析和 locator 文档形状：不读取会话、记忆或密钥，也不执行迁移；真正的拷贝、校验与回滚由 App Main 负责，本包只解析它写下的状态。
- 禁止放入 Electron 生命周期、文件迁移和用户数据写入逻辑。

## 依赖与数据

- 该包保持无 workspace 运行时依赖，供 App、CLI 和核心服务向下依赖。
- 它定义路径，不拥有路径指向的数据；实际数据由对应领域服务管理。

## 测试与修改定位

- 测试位于 `src/index.test.ts`。
- 修改品牌名或默认目录时，同时检查 App 启动、脚本、恢复检查和迁移兼容。
- Void Ring 的图形、尺寸、四种真实 Lottie、帧图和预览见 [实施说明](assets/LS_VoidRing/README_implementation.md) 与 [本地预览](assets/LS_VoidRing/preview.html)。循环动效让内圈反光、折射亮边和外晕共同流动，黑色实体几何固定。从 `assets/LS_VoidRing/tools/render_brand_assets.py` 重新生成时，以同一球体光照母版统一导出标准/低光 PNG、Windows ICO、透明动效层，并用真实播放器验证后输出 GIF；正式 SVG 内嵌光照纹理，纯路径矢量仅提供近似参考。`tools/export_app_motion.py` 再将已确认帧序列导出为 App 使用的无损 WebP；应用已接入启动、空白对话、任务条、历史读取与思考行。导出脚本会改写 `packages/app/resources/`，之后必须重跑 `pnpm run ensure:app-build`。仅改动效可使用实施说明中的独立导出入口。素材交付、真实 Renderer 状态接入与安装包分别验收。
