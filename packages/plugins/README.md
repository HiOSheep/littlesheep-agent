# @littlesheep/plugins

实现插件 manifest、发现、信任校验、生命周期宿主和受控贡献接口。

## 职责与边界

- 公开入口是 `src/index.ts`；manifest 在 `manifest.ts`，宿主在 `host.ts`，本地加载在 `local-loader.ts`。
- 当前稳定贡献为 channel、tool 和声明式 skill；未定义完整宿主契约的能力不能只靠 manifest 枚举宣称支持。
- 禁止插件绕过 Runner 工具执行、用户信任开关、错误隔离或 owner-scoped 清理。

## 依赖与数据

- 依赖 Runner、Session、Skills、Config 和公共契约；核心 Runner 不反向依赖具体插件实现。
- 插件目录和插件数据属于用户数据，各插件只能拥有自己的命名空间。

## 测试与修改定位

- manifest、宿主、本地加载和 channel 生命周期测试位于 `src/**/*.test.ts`。
- 升级 API 时必须定义版本兼容、安装/卸载、权限、持久化和失败恢复。
