# 脚本与验证入口

`package.json` 是可运行命令的唯一清单。本页说明入口如何选择，以及少数不能从命令名看出的验证边界。

## 常用入口

- `pnpm check:repo`：仓库卫生、文档导航、生成物、依赖方向与 TypeScript 项目引用检查。
- `pnpm verify:task -- --files=<path>`：按改动路径选择局部测试与类型检查。
- `pnpm verify:changed`、`pnpm verify:core`、`pnpm verify:full`：本地变更、核心和全量验证编排；各自覆盖面以 `package.json` 和执行摘要为准。
- `pnpm run ensure:app-build` / `pnpm run assert:app-build`：分别准备或只检查 Electron 构建新鲜度。真实窗口门通常先准备构建；基线检查工具通常要求构建已新鲜。
- `pnpm run check:cache-acceptance`：执行当前缓存验收规则。
- `pnpm run package:win` / `pnpm run package:win-installer`：生成 Windows 发布产物。

Provider、Memory、文件一致性、Electron、桌面启动和工作区专项均由 `package.json` 中对应的 `verify:*` / `measure:*` 命令提供。验证选择应跟随受影响的契约和失败后果；构建、源码检查与真实窗口、真实 Provider、发布包证据不是同一层。

## Electron 验收约定

产品窗口验收应使用隔离数据根、确定性夹具，并将日志、截图和临时报告写到系统临时产物目录；不得读取用户会话或密钥。报告只证明其实际执行的断言。

涉及窗口顶栏、拖动区域或顶栏控件时，使用 `pnpm run verify:window-layout` 的原生命中检查。DOM 命中和 CDP 合成点击不能证明 Windows 原生鼠标按下会送到页面。共享探针在 `scripts/lib/native-hit-test.mjs`；自检入口为 `node scripts/probe-native-hit-test.mjs`，只验证探针能区分 `HTCLIENT` 与 `HTCAPTION`，不替代产品门。

原生命中检查要求窗口保持可见并由系统合成；停放到屏幕外或隐藏窗口会使拖动区结果失真。其他 UI 验收是否需要显示窗口，以相应门的断言为准。

## 脚本所有权

- `check-repository-hygiene.mjs` 与相邻测试拥有仓库导航和结构门禁。
- `verify-*.mjs` / `measure-*.mjs` 拥有各自行为与测量的断言；实际输出记录在测试报告，不复制进本索引。
- `scripts/lib/` 放多个门共享的隔离 Electron、Provider、产物路径和原生命中探针。
- 自治实验脚本只服务对应活动任务书，不是产品发布门；预算、样本与结果保存在仓库外。

机器检查 `docs/README.md` 的四类入口及分层导航。package README 由各 package 自己维护；普通私有源码、测试、样式和时间戳变化不触发 README 更新。
