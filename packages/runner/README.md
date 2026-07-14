# @littlesheep/runner

作为核心应用服务装配 Harness、Context、Memory、Tools、Session、Skills 和执行日志，并提供单次 run 接口。

## 职责与边界

- 公开入口是 `src/index.ts`；`runner.ts` 负责运行，`run-config.ts` 冻结决议，`execution-log.ts` 持久化证据。
- 负责依赖注入和运行生命周期，不吸收各领域内部算法或 Electron UI 逻辑。
- 禁止让渠道、插件私有实现或 renderer 状态成为核心 run 的必要依赖。

## 依赖与数据

- Runner 可以组合基础设施，但跨领域只使用公开入口。
- 拥有 execution log 的写入协调；会话、记忆和配置仍由各自服务拥有。

## 测试与修改定位

- 运行行为在 `src/runner.test.ts`，决议在 `src/run-config.test.ts`，日志在 `src/execution-log.test.ts`。
- 新 run 输入或事件必须同步公共契约、历史恢复和 Local App API 消费方。
