# @littlesheep/branding

定义 LittleSheep 的品牌标识、默认用户数据目录名称和稳定路径布局。

最后更新：2026-09-22 12:43:39

## 职责与边界

- 公开入口是 `src/index.ts`；品牌配置、数据目录解析和数据根 locator 文档形状集中在此。
- 提供 `loadBranding`/`parseBranding`、`resolveDataDir`/`resolveDefaultDataDir`、`dataSubdirs`（sessions、memory、skills、config、quarantine、backups、experience、archive、vectors、execution-logs、channels、plugins、plugin-data、attachment-cache、workplace）和 `readDataRootLocator`/`parseDataRootLocator`。
- 只拥有命名、路径解析和 locator 文档形状：不读取会话、记忆或密钥，也不执行迁移；真正的拷贝、校验与回滚由 App Main 负责，本包只解析它写下的状态。
- 禁止放入 Electron 生命周期、文件迁移和用户数据写入逻辑。

## 依赖与数据

- 该包保持无 workspace 运行时依赖，供 App、CLI 和核心服务向下依赖。
- 它定义路径，不拥有路径指向的数据；实际数据由对应领域服务管理。

## 测试与修改定位

- 测试位于 `src/index.test.ts`。
- 修改品牌名或默认目录时，同时检查 App 启动、脚本、恢复检查和迁移兼容。
