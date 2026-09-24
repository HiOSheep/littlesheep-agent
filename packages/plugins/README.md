# @littlesheep/plugins

实现插件 manifest、发现、信任校验、生命周期宿主和受控贡献接口。

最后更新：2026-09-25 07:12:30

## 职责与边界

- 公开入口是 `src/index.ts`；manifest 在 `manifest.ts`，宿主在 `host.ts`，本地加载在 `local-loader.ts`，渠道运行时在 `src/channel/`。
- 宿主按用户启用状态、本地代码信任开关和激活事件决定是否激活；注册每项贡献前校验 manifest 必须同时声明对应 capability、permission 与 contributes 条目，并为每个插件分配独立 `plugin-data` 命名空间，停用/失败时回收它注册的渠道类型与工具。
- `PluginHost.listChannels()` **只返回正在运行的渠道实例**：它读渠道管理器的运行表，`stop()` 把条目移出该表，启动失败的渠道只出现在 `channelFailures()` 里。因此 `/channels/status` 的 `channels` 里不会出现"已加载但已停止"的条目——这是设置页"按运行项计数、不把配置存在当健康"的前提，契约用例见 `src/channel/manager.test.ts` 的 `list` 分组。
- 当前稳定贡献为 channel、tool 和声明式 skill（skill 以 `contributes.skills` 声明的目录交给 Skills 加载器）；未定义完整宿主契约的能力不能只靠 manifest 枚举宣称支持。
- 插件工具仍由统一 Tool Execution Service 执行，插件不因此获得任何权限豁免；禁止绕过 Runner 工具执行、用户信任开关、错误隔离或 owner-scoped 清理。

## 依赖与数据

- 依赖 Runner、Session、Skills、Config 和公共契约；核心 Runner 不反向依赖具体插件实现。
- 插件目录和插件数据属于用户数据，各插件只能拥有自己的命名空间。

## 测试与修改定位

- manifest、宿主、本地加载和 channel 生命周期测试位于 `src/**/*.test.ts`。
- 升级 API 时必须定义版本兼容、安装/卸载、权限、持久化和失败恢复。
