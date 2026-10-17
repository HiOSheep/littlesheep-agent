# Reference 文档

## 代码与边界

- [仓库指南](repository-guide.md)：源码定位、package 职责和最少仓库规则。
- [模块拆分地图](module-split-map.md)：当前 300/600 行文件登记及受控超限项，供 check:repo 校验。
- [Core Flow 状态契约](core-flow-state-contract.md)：唯一状态转移 manifest、RunContext 所有权与生命周期。
- [LCDA-01 全仓历史兼容与遗留代码审计](lcda-01-legacy-compatibility-audit-2026-10-16.md)：本地 main 的遗留执行路径、持久化兼容、无效配置、清理分类与 LCDA-02 分批方案。
- [LCDA-02B 存量兼容证据盘点与退役决策](lcda-02b-persisted-compatibility-inventory-2026-10-16.md)：持久化结构、受限只读盘点器、真实数据未检查声明与退役决策矩阵。
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

- [VRS VERIFY 去留与最终集成报告](vrs-final-integration-report-2026-10-16.md)：VERIFY Stage 移除、证据结算迁移、旧 checkpoint 兼容、main 集成提交与 VRS-F 回归结果。
- [RCD S0 基线报告](rcd-s0-baseline-2026-10-16.md)：24 个场景目录、证据盘点与离线契约基线。
- [RCD S0B 可执行基线](rcd-s0b-executable-baseline-2026-10-16.json)：六个代表场景的运行账本和未运行场景清单；入口见前述基线报告。
- [RCD S0-F 核心基线](rcd-s0f-core-baseline-2026-10-16.json)：C02、C08、R01、R02、L01、X01 六项核心机制的冻结运行账本；完整 24 场景基线未完成。
- [RCD S1B Shell 重执行与恢复复核](rcd-s1b-shell-replay-2026-10-16.md)：Shell 新调用与 Runner 恢复重放的 B01–B05 实测、策略限制和回归结果。
- [RCD S1B Shell 复核机器账本](rcd-s1b-shell-replay-2026-10-16.json)：B01–B05 的执行基础设施状态、结果和证据摘要。
- [RCD S1B 六项核心回归](rcd-s1b-core-regression-2026-10-16.json)：S1B 前后 S0-F 核心集合的回归账本。
- [RCD S1B-F 受控 Shell 合法重执行](rcd-s1b-f-shell-reexecution-2026-10-16.md)：Main 新调用授权身份、精确有界重复授权及 unknown / Runner 恢复保护的受控验收。
- [RCD S1B-F Shell 重执行机器账本](rcd-s1b-f-shell-reexecution-2026-10-16.json)：F01–F06、B01–B05 和副作用账本测试的本批运行结果。
- [RCD S1B-F S0-F 核心回归](rcd-s1b-f-core-regression-2026-10-16.json)：实现后的 C02、C08、R01、R02、L01、X01 回归运行账本。
- [RCD S1C 动态 Web 准入报告](rcd-s1c-dynamic-web-admission-2026-10-16.md)：同一 Run 内的动态公开检索准入、网络禁令、数据外传限制与未完成验收边界。
- [RCD S1C 核心回归账本](rcd-s1c-core-regression-2026-10-16.json)：S1C 实现后的六项核心场景执行结果。
- [RCD S1C 机器可读总结](rcd-s1c-dynamic-web-admission-2026-10-16.json)：审计结论、R01/R02 对照、负向测试、环境限制和剩余风险。
- [RCD S2A 持续执行与任务交付契约设计](rcd-s2a-continuous-execution-design-2026-10-16.md)：当前 Run/预算/checkpoint 生命周期审计、L01 30/35 失败证据、跨段续接契约、T01–T08 测试方案及 S2B/S2C 拆分。
- [RCD S2B 持续执行实施进度](rcd-s2b-progress-2026-10-16.md)：同一 Run 内有界分段、T01/T02/T05 与核心回归证据；明确同 Run 重启恢复尚未实现，S2B 未完成。
- [RCD S2B 机器可读进度账本](rcd-s2b-progress-2026-10-16.json)：执行层级、预算、场景状态、验证结果和 S2B 阻塞项。
- [RCD S2B 核心回归账本](rcd-s2b-core-regression-2026-10-16.json)：当前工作树下 S0-F 六项核心场景的逐项运行、Oracle、清理及指纹记录。
- [RCD S2B-2 同一 Run 持久恢复最小实现](rcd-s2b-2-recovery-design-2026-10-16.md)：T04-A 真实进程 SIGKILL 后 35/35 恢复、lease 所有权、上下文重建、负向资格判定及仍待第三单元覆盖的故障窗口。
- [RCD S2B-2 第三单元跨进程故障恢复验收](rcd-s2b-2-third-unit-recovery-acceptance-2026-10-16.md)：T04-B～E、T05-R、T08-R、T03-R 的进程级验收、阻断结果、Usage 一致性及 S2B 尚未关闭的权限与 Provider 上下文缺口。
- [RCD S2B-2 第三单元机器账本](rcd-s2b-2-third-unit-recovery-acceptance-2026-10-16.json)：进程故障窗口、核心回归和基础设施验证的逐项结果与证据层级。
- [RCD S2B-F 持久恢复权限集成验收](rcd-s2b-f-permission-recovery-acceptance-2026-10-16.md)：Main-owned Permission V2 恢复路径、受控无进展进程验收、恢复支持范围，以及真实 Electron 尚未通过的阶段结论。
- [RCD S2B-F 机器可读验收账本](rcd-s2b-f-permission-recovery-acceptance-2026-10-16.json)：Main 权限、恢复边界、RCD 六项核心场景、测试状态和 Electron 阻塞记录。
- [RCD S2B-G Electron 验收与阶段收口](rcd-s2b-g-electron-acceptance-2026-10-16.md)：真实 Electron Main/Runner 同 Run 恢复、Permission V2 桌面验收、核心回归与冻结的恢复支持范围。
- [RCD S2B-G 机器可读验收账本](rcd-s2b-g-electron-acceptance-2026-10-16.json)：Electron 环境、跨进程恢复证据、权限负向覆盖、RCD 核心结果、测试与发布限制。
- [RCD S2B-G 六项核心回归账本](rcd-s2b-g-core-regression-2026-10-16.json)：C02、C08、R01、R02、L01、X01 的逐场景执行、独立 Oracle、清理与指纹记录。
- [RCD S2C-A 主线集成与 Task Outcome 契约设计](rcd-s2c-a-outcome-contract-2026-10-16.md)：S2B 与 VRS main 集成关系、主线验证结果、现有证据来源审计及 S2C-B/C 最小接口设计。
- [RCD S2C-B Task Outcome 可信证据与持久化](rcd-s2c-b-task-outcome-2026-10-17.md)：窄范围文件内容要求的真实检查、逐项证据关联、Durable Outcome 结算和兼容回归结果。
- [RCD S2C-B 机器可读验收账本](rcd-s2c-b-task-outcome-2026-10-17.json)：S2C-B 用例结果、RCD 六项核心回归、验证命令与保留限制。
- [RCD S2C-C Task Outcome 可信成果展示与交付](rcd-s2c-c-task-outcome-renderer-2026-10-17.md)：Renderer 对 Durable Task Outcome 的直播与历史消费、真实 Electron 验收、核心回归及 UI/Provider 限制。
- [RCD S2C-C 机器可读验收账本](rcd-s2c-c-task-outcome-renderer-2026-10-17.json)：三类文件验收展示、RCD 六项核心回归、构建、测试和执行层级记录。
- [RCD S1A 核心回归](rcd-s1a-core-regression-2026-10-16.json)：参数纠错修复后的六项核心回归账本；C02 已从 failed 变为 passed。
- [CMv2-P0A 上下文链路审计](cmv2-p0a-context-audit-2026-10-13.md)：请求组装、圆环口径、隔离 Token 基线、Context Trace 与 P0B 最小方案。
- [CMv2-P0B Context Inspector 实施](cmv2-p0b-context-inspector-2026-10-13.md)：只读页面、脱敏内存接口、导航状态保留与真实 Electron 截图／验收。
- [CMv2-P1A 记忆权限与作用域基础](cmv2-p1a-memory-access-2026-10-14.md)：访问边界审计、独立读写策略、项目身份与迁移方案、权限测试矩阵及 P1B/P1C 接入清单。
- [CMv2-P1B-1 可信记忆授权传递](cmv2-p1b-1-memory-authority-2026-10-14.md)：Host 身份、一次性授权句柄、Runner/MemoryService 上下文、受限兼容及后续读取接入清单。
- [CMv2-P1B-2A Atom 检索授权](cmv2-p1b-2a-atom-retrieval-2026-10-14.md)：测试专用 enforced 模式、可信实体绑定、v2/v3 候选过滤、版本失效及剩余旁路。
- [缓存验收规程](cache-95-acceptance.md)：现行口径和正式验收命令。
- [缓存基线目录](cache-baseline/README.md)：冻结账本及批次索引。
- [桌面冷启动基线](cold-start-baseline/README.md)：冷启动、就绪态与窗口行为的原始验收输入。
