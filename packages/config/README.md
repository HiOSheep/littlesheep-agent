# @littlesheep/config

负责配置 schema、默认值、Provider/模型能力声明和配置文件加载。

## 职责与边界

- 公开入口是 `src/index.ts`；主要实现位于 `schema.ts`、`defaults.ts`、`loader.ts` 和 `model-capabilities.ts`。
- 负责验证配置形状，不负责保存明文密钥或执行 Provider 请求。
- 禁止放入 Electron UI 状态、Runner 装配和供应商网络逻辑。

## 依赖与数据

- 只依赖纯契约和 schema 库；上层 App、Runner、LLM 消费它。
- 配置文件属于用户数据，包本身不拥有密钥生命周期。

## 测试与修改定位

- schema 回归位于 `src/schema.test.ts`。
- 新增配置必须同时提供默认值、校验、兼容解析和对应消费方测试。
