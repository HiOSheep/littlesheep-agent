# Reference 文档

## 代码与边界

- [仓库指南](repository-guide.md)：源码定位、package 职责和最少仓库规则。
- [CI 门禁](ci-gates.md)：GitHub Actions 快速／完整两层门禁、Windows 主机与工具链、合成数据根引导、CI 配置正负路径校验及明确未覆盖能力。
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

- [RCD R4-C 交付一致性审计与 DELIV-02 复现](rcd-r4c-delivery-consistency-audit-2026-10-22.md)：Runner→Task Outcome→Main API/SSE→Renderer→历史回放审计、真实 Electron 复现证据、展示契约与修复边界。
- [RCD R4-C 交付一致性最终报告](rcd-r4c-delivery-consistency-report-2026-10-22.md)：展示契约实现、实际修改范围、DELIV-02 正负对照与刷新/重启/会话切换证据、回归结果与未覆盖项。
- [RCD R4-D0 真实模型试验协议](rcd-r4d0-trial-protocol-2026-10-22.md)：S3B-R/R4-B/R4-C 契约分离、4×5 试验矩阵、trial 隔离、Provider 预检、预算/停止条件、指标与真实试验授权清单。
- [RCD R4-D0 冻结预检工件](rcd-r4d0-preflight-2026-10-22.json)：协议版本、产品/评测器/任务/Oracle 指纹、20 项离线 Provider 预检与授权状态。
- [RCD R4-D0 离线端到端演练](rcd-r4d0-offline-rehearsal-2026-10-22.md)：4 任务 × Trial 1–5 的本地 scripted Provider 演练、三维度分母、trial 隔离、失败分类、重复运行拒绝与预算停止证据。
- [RCD R4-D0 Go/No-Go 与授权清单](rcd-r4d0-gonogo-2026-10-22.md)：D0 技术准备与付费试验的分开结论、回归结果、真实授权清单与阻塞项；当前付费试验为 No-Go。
- [LittleSheep 仓库持续优化报告](rcd-optimization-report-2026-10-23.md)：13 个本地提交的文档清理、死代码/重复设计移除、接口标准化、内聚改造、验证证据与残余风险。
- [LittleSheep 架构优化报告](architecture-optimization-2026-10-23.md)：全仓架构审计后的 10 个增量批次（控制流/恢复/缓存/渠道权限/API 契约），删除与替换依据、验证证据和残余风险。
- [RCD R4-B 评测契约 V2 设计](rcd-r4b-v2-contract-design-2026-10-21.md)：Goal / Contract / Mechanism 三维度结算、版本与指纹、四项独立任务、Trial 1–5 身份隔离、预算与报告口径；离线设计报告，未执行真实 Provider。
- [RCD R4-B 评测契约 V2 Schema](rcd-r4b-v2-contract-schema-2026-10-21.json)：V2 记录/账本的 JSON Schema、状态枚举与运行时不变式清单。
- [RCD R4-B 评测契约 V2 任务集](rcd-r4b-v2-task-suite-2026-10-21.json)：FILE-02-G/S 与 DELIV-01-G/R 四项独立任务、冻结 ancestry、可见契约文本与确定性 Oracle 约定。
- [RCD R4-B V2 受控运行报告](rcd-r4b-v2-report-2026-10-21.md)：20 条 Trial 1–5 记录的三维度结果、有效样本/分母、历史结果只读展示与明确未运行项。
- [RCD R4-B V2 机器账本](rcd-r4b-v2-ledger-2026-10-21.json)：不可变记录的批次汇总、指标分母与 legacy 展示分区；单次记录位于 `rcd-r4b-v2-records/`。
- [RCD R4-B V2 最终验收记录](rcd-r4b-v2-verification-2026-10-22.md)：test:v2、RCD 六项核心、恢复回归、typecheck、check:repo 与 verify:full 的实际结果、冻结核查与未运行项。
- [RCD S3A 真实任务评测协议](rcd-s3a-evaluation-protocol-2026-10-17.md)：A/B/C 证据分层、可复现要求、指标口径与失败分类。
- [RCD S3A 首批 12 项任务](rcd-s3a-task-suite-2026-10-17.json)：固定原始输入、种子状态、权限、外部 Oracle 和清理契约。
- [RCD S3A 评测指标 Schema](rcd-s3a-metrics-schema-2026-10-17.json)：机器账本字段、不可用用量和失败分类结构。
- [RCD S3A 24 项场景审计](rcd-s3a-scenario-audit-2026-10-17.json)：场景适配层级、Oracle 范围及未验证项清单。
- [RCD S3A 干净提交六项核心复跑](rcd-s3a-clean-core-baseline-2026-10-17.json)：在无未提交改动的 `d5015136` worktree 上执行的 C02、C08、R01、R02、L01、X01 账本。
- [RCD S3A 受控试跑基线](rcd-s3a-baseline-2026-10-17.md)：冻结源码版本、四项受控 Runner/Harness 任务试跑、结果与边界。
- [RCD S3A 受控试跑机器账本](rcd-s3a-baseline-2026-10-17.json)：四项新增任务运行记录及独立 Oracle 结果。
- [RCD S0 基线报告](rcd-s0-baseline-2026-10-16.md)：24 个场景目录、证据盘点与离线契约基线。
- [RCD S0B 可执行基线](rcd-s0b-executable-baseline-2026-10-16.json)：六个代表场景的运行账本和未运行场景清单；入口见前述基线报告。
- [RCD S0-F 核心基线](rcd-s0f-core-baseline-2026-10-16.json)：C02、C08、R01、R02、L01、X01 六项核心机制的冻结运行账本；完整 24 场景基线未完成。
- [RCD S2B 核心回归账本](rcd-s2b-core-regression-2026-10-16.json)：当前工作树下 S0-F 六项核心场景的逐项运行、Oracle、清理及指纹记录。
- [RCD S2B-2 第三单元跨进程故障恢复验收](rcd-s2b-2-third-unit-recovery-acceptance-2026-10-16.md)：T04-B～E、T05-R、T08-R、T03-R 的进程级验收、阻断结果、Usage 一致性及 S2B 尚未关闭的权限与 Provider 上下文缺口。
- [RCD S2B-2 第三单元机器账本](rcd-s2b-2-third-unit-recovery-acceptance-2026-10-16.json)：进程故障窗口、核心回归和基础设施验证的逐项结果与证据层级。
- [RCD S2B-G Electron 验收与阶段收口](rcd-s2b-g-electron-acceptance-2026-10-16.md)：真实 Electron Main/Runner 同 Run 恢复、Permission V2 桌面验收、核心回归与冻结的恢复支持范围。
- [RCD S2B-G 机器可读验收账本](rcd-s2b-g-electron-acceptance-2026-10-16.json)：Electron 环境、跨进程恢复证据、权限负向覆盖、RCD 核心结果、测试与发布限制。
- [RCD S2B-G 六项核心回归账本](rcd-s2b-g-core-regression-2026-10-16.json)：C02、C08、R01、R02、L01、X01 的逐场景执行、独立 Oracle、清理与指纹记录。
- [RCD S2C-A 主线集成与 Task Outcome 契约设计](rcd-s2c-a-outcome-contract-2026-10-16.md)：S2B 与 VRS main 集成关系、主线验证结果、现有证据来源审计及 S2C-B/C 最小接口设计。
- [RCD S2C-B Task Outcome 可信证据与持久化](rcd-s2c-b-task-outcome-2026-10-17.md)：窄范围文件内容要求的真实检查、逐项证据关联、Durable Outcome 结算和兼容回归结果。
- [RCD S2C-B 机器可读验收账本](rcd-s2c-b-task-outcome-2026-10-17.json)：S2C-B 用例结果、RCD 六项核心回归、验证命令与保留限制。
- [RCD S2C-D Task Outcome 结算一致性](rcd-s2c-d-settlement-consistency-2026-10-17.md)：真实子进程故障矩阵、多存储结算顺序、恢复幂等与文件检查时点语义。
- [RCD S2C-D 机器可读验收账本](rcd-s2c-d-settlement-consistency-2026-10-17.json)：故障窗口、恢复预期、证据层级、测试结果和安全降级范围。
- [RCD S2C-E 任务成果最终验收](rcd-s2c-e-task-delivery-acceptance-2026-10-17.md)：真实 Electron 下 T06/T07、逐项文件检查、历史回放、RCD 核心与 Runner/VRS/权限回归结果。
- [RCD S2C-E 机器可读验收账本](rcd-s2c-e-task-delivery-acceptance-2026-10-17.json)：最终桌面场景、各层测试结果、RCD 六项核心状态与适用边界。
- [RCD S1A 核心回归](rcd-s1a-core-regression-2026-10-16.json)：参数纠错修复后的六项核心回归账本；C02 已从 failed 变为 passed。
- [CMv2-P0A 上下文链路审计](cmv2-p0a-context-audit-2026-10-13.md)：请求组装、圆环口径、隔离 Token 基线、Context Trace 与 P0B 最小方案。
- [CMv2-P0B Context Inspector 实施](cmv2-p0b-context-inspector-2026-10-13.md)：只读页面、脱敏内存接口、导航状态保留与真实 Electron 截图／验收。
- [CMv2-P1A 记忆权限与作用域基础](cmv2-p1a-memory-access-2026-10-14.md)：访问边界审计、独立读写策略、项目身份与迁移方案、权限测试矩阵及 P1B/P1C 接入清单。
- [CMv2-P1B-1 可信记忆授权传递](cmv2-p1b-1-memory-authority-2026-10-14.md)：Host 身份、一次性授权句柄、Runner/MemoryService 上下文、受限兼容及后续读取接入清单。
- [CMv2-P1B-2A Atom 检索授权](cmv2-p1b-2a-atom-retrieval-2026-10-14.md)：测试专用 enforced 模式、可信实体绑定、v2/v3 候选过滤、版本失效及剩余旁路。
- [缓存验收规程](cache-95-acceptance.md)：现行口径和正式验收命令。
- [缓存基线目录](cache-baseline/README.md)：冻结账本及批次索引。
- [桌面冷启动基线](cold-start-baseline/README.md)：冷启动、就绪态与窗口行为的原始验收输入。
- [RCD S3A 真实任务评测基线](rcd-s3a-baseline-2026-10-17.md)：冻结产品版本、24 项 RCD 审计、12 项任务集、受控试跑、真实 Electron 复核及指标边界。
- [RCD S3A 机器可读试跑账本](rcd-s3a-baseline-2026-10-17.json)：四项受控 Runner/Harness 任务的执行、Oracle、资源使用与清理记录。
- [RCD S3A RCD 场景审计](rcd-s3a-scenario-audit-2026-10-17.json)：逐项记录 24 个场景的执行层级、Oracle、模拟 Provider 与未验证状态。
- [RCD S3A 干净提交核心复跑](rcd-s3a-clean-core-baseline-2026-10-17.json)：冻结提交 d5015136 上六项核心结果。
- [RCD S3A Electron 桌面复核](rcd-s3a-desktop-acceptance-2026-10-17.json)：Electron 44.4.5 下 S2C-E 检查和历史回放证据。
- [RCD S3A 12 项任务集](rcd-s3a-task-suite-2026-10-17.json)：首批任务输入、初始状态、授权、Oracle、安全和清理约定。
- [RCD S3A 指标 Schema](rcd-s3a-metrics-schema-2026-10-17.json)：任务结果、执行、用量、干预、安全和失败分类结构。
- [RCD S3A 评测协议](rcd-s3a-evaluation-protocol-2026-10-17.md)：A/B/C 证据层级、冻结与复现、测量口径和安全边界。
- [RCD S3B 真实 Provider 评测协议](rcd-s3b-provider-evaluation-2026-10-17.md)：真实 Provider 的授权闸门、计量入口、四项 live 资格与受控任务层级。
- [RCD S3B 任务适配器扩展](rcd-s3b-adapter-extension-2026-10-17.json)：保留 12 项 S3A 任务定义并将可执行受控适配器扩展到八项。
- [RCD S3B 受控任务账本](rcd-s3b-controlled-baseline-2026-10-17.json)：八项受控 Runner/Harness 运行与独立 Oracle 结果。
- [RCD S3B 初始真实 Provider 预检账本](rcd-s3b-real-baseline-2026-10-17.json)：授权前预检快照，保留当时的 `real_provider_pending` 状态。
- [RCD S3B 评测报告](rcd-s3b-evaluation-report-2026-10-17.md)：提交、受控结果、失败归因和未完成的真实模型验收。
- [RCD S3B-R DeepSeek 真实模型报告](rcd-s3b-real-deepseek-report-2026-10-17.md)：冻结产品基线下四项真实模型任务的独立 Oracle 结果、资源计量和适用限制。
- [RCD S3B-R DeepSeek 批次机器账本](rcd-s3b-real-deepseek-batch-2026-10-17.json)：逐次 Runner/Harness 运行、评测器指纹、Provider Usage、Oracle 及清理记录。
- [RCD S3B-P01 实际轨迹审计](rcd-s3b-p01-trajectory-audit-2026-10-17.md)：首批四项真实任务的逐字段轨迹复核、证据充分性分级、证据缺口与已确认的字段级缺陷；未修改历史证据。
- [RCD S3B-P01 审计机器账本](rcd-s3b-p01-audit-ledger-2026-10-17.json)：9 条尝试（有效 4 / 错误模型 ID 2 / 分派诊断 2 / 受控 1）的请求、工具、Effect、Usage、Oracle 与证据分级。
- [RCD S3B-P02/P03 失败归因复盘](rcd-s3b-p02-p03-failure-attribution-2026-10-17.md)：FILE-02 字段契约五问与 DELIV-01 双维度复盘、证据等级、未来独立改进版本与 S1A 专项场景设计。
- [RCD S3B-P02/P03 归因机器账本](rcd-s3b-p02-p03-attribution-ledger-2026-10-17.json)：逐任务归因、契约缺陷与改进建议；历史 Oracle 结果保持不变。
- [RCD S3B-P04 真实 Provider 评测器防护强化](rcd-s3b-p04-provider-guard-hardening-2026-10-17.md)：模型映射、预检与任务入口一致性、确定性配置错误停止、不可重放状态、请求预算、Usage 与凭据脱敏的离线正负向测试。
- [RCD S3B-P05 DELIV-02 产品缺陷评审](rcd-s3b-p05-deliv-02-product-review-2026-10-17.md)：完成声明与可信验收的界面区分评审、缺陷分级与最小修复建议；未修改生产代码。
- [RCD S3B-P06 第二轮真实模型试验协议](rcd-s3b-p06-round2-protocol-2026-10-17.md)：重复试验、独立 workspace、机制与目标分离、预算、模型版本、Oracle 独立验收与授权闸门；未执行任何真实请求。
- [RCD S3B-P 独立验证账本](rcd-s3b-p-verification-2026-10-17.json)：P04 的对抗性检查、回归门退出码、范围合规与验证发现（含发现与复核后的处置状态）。
- [RCD S3B-P 复盘与可靠性收口报告](rcd-s3b-p-reliability-report-2026-10-17.md)：首批真实模型评测的可信结论与负面事实、归因与证据等级、评测层修复、下一轮阻塞项与优先级建议。
