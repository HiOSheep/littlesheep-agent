# Reference 文档

## 代码与边界

- [仓库指南](repository-guide.md)：源码定位、package 职责和最少仓库规则。
- [模块拆分地图](module-split-map.md)：当前 300/600 行文件登记及受控超限项，供 check:repo 校验。
- [Core Flow 状态契约](core-flow-state-contract.md)：唯一状态转移 manifest、RunContext 所有权与生命周期。
- [插件开发说明](plugin-development.md)：插件贡献、权限与生命周期。
- [自定义模型供应商](custom-model-providers.md)：Provider 配置和能力语义。
- [即时性提示契约](transient-notice-contract.md)：确认自动消失、失败永不自动消失的口径、时间规则与真实窗口验收。
- [跨平台沙箱能力契约](cross-platform-sandbox-contract.md)：P3-0 能力证据、边界所有权和失败行为。
- [Windows Shell Sandbox PoC](windows-shell-sandbox-poc.md)：P3-A 至 P3-A4 实验、Windows 实机证据、失败边界和未完成的隔离要求；P3 生产集成与 Permission V2 Shell 自动放行已冻结，技术取舍见 [Decision](../decision/shell-isolation-decision-2026-10-12.md)。

## 安全与发布

- [网络检索安全契约](web-retrieval-security-contract.md)：匿名公共读取与威胁边界。
- [网络检索安全验收](web-retrieval-security-acceptance-2026-08-29.md)：发布阻断项和供应链限制。
- [生产依赖安全记录](production-dependency-security.md)：仍有效的依赖 override 与许可证事项。

## 专项验收基线

- [RCD S0 基线报告](rcd-s0-baseline-2026-10-16.md)：24 个场景目录、证据盘点与离线契约基线。
- [RCD S0B 可执行基线](rcd-s0b-executable-baseline-2026-10-16.json)：六个代表场景的运行账本和未运行场景清单；入口见前述基线报告。
- [RCD S0-F 核心基线](rcd-s0f-core-baseline-2026-10-16.json)：C02、C08、R01、R02、L01、X01 六项核心机制的冻结运行账本；完整 24 场景基线未完成。
- [RCD S1A 核心回归](rcd-s1a-core-regression-2026-10-16.json)：参数纠错修复后的六项核心回归账本；C02 已从 failed 变为 passed。
- [CMv2-P0A 上下文链路审计](cmv2-p0a-context-audit-2026-10-13.md)：请求组装、圆环口径、隔离 Token 基线、Context Trace 与 P0B 最小方案。
- [CMv2-P0B Context Inspector 实施](cmv2-p0b-context-inspector-2026-10-13.md)：只读页面、脱敏内存接口、导航状态保留与真实 Electron 截图／验收。
- [CMv2-P1A 记忆权限与作用域基础](cmv2-p1a-memory-access-2026-10-14.md)：访问边界审计、独立读写策略、项目身份与迁移方案、权限测试矩阵及 P1B/P1C 接入清单。
- [CMv2-P1B-1 可信记忆授权传递](cmv2-p1b-1-memory-authority-2026-10-14.md)：Host 身份、一次性授权句柄、Runner/MemoryService 上下文、受限兼容及后续读取接入清单。
- [CMv2-P1B-2A Atom 检索授权](cmv2-p1b-2a-atom-retrieval-2026-10-14.md)：测试专用 enforced 模式、可信实体绑定、v2/v3 候选过滤、版本失效及剩余旁路。
- [缓存验收规程](cache-95-acceptance.md)：现行口径和正式验收命令。
- [缓存基线目录](cache-baseline/README.md)：冻结账本及批次索引。
- [桌面冷启动基线](cold-start-baseline/README.md)：冷启动、就绪态与窗口行为的原始验收输入。
- [VERIFY 去留审计 V0/V1](vrs-verify-rationalization-audit-2026-10-16.md)：调用链、判定规则、兼容性决策与 V2 实施范围；仅审计，未改生产行为。
