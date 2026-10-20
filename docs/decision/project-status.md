# LittleSheep 项目状态

本文件只记录当前实现、仍有效的限制和会影响下一步决策的验证结论。详细契约由源码、测试及对应 owner 文档维护；逐次验收过程和旧状态由 Git 历史保存。

## 当前成熟度

LittleSheep 已具备本地 Agent 的主要运行骨架：单一 Harness 主循环、统一受控工具执行、索引优先的 Memory、桌面聊天与工作区、可迁移应用数据根和可选渠道。安全段边界的同 Run 持久恢复与窄范围 Durable Task Outcome 已通过真实 Electron 验收，但两者都只覆盖各自明确的契约，不是任意崩溃点恢复或通用任务验收。它仍是 alpha，不能宣称发布就绪。安装、签名、升级、卸载和原生依赖分发尚未闭环；真实 Provider 覆盖和长时负载样本仍有限。

## 当前实现

- **执行与验证**：活动路由只进入常规执行主循环或 Runtime 事实回复。DECIDE、独立 VERIFY、验证模型调用、恢复模型调用和 CAPTURE 不存在；TaskBook 可从旧状态恢复并由 Runtime event patch 修订，但已无步骤执行器。旧 `verify` stage/checkpoint 保留历史读取与恢复兼容；`VerificationRecord`／`verificationHistory` 仍是活动运行证据契约，EXECUTE/RECOVER 会写入 `fail` 或 `unverified`。运行证据完整不代表用户目标已验收；用户要求层面的判定由独立的 Task Outcome 表达，缺失依据时保持 `unverified` 或 `unknown`.
- **持久恢复与任务成果**：自动恢复只接管具备安全执行段边界的同一 Run：Runner 先取得原 Run 独占 lease，重建持久 transcript 与执行上下文并按指纹比对，沿用原 Run/Session、原始 ingress、累计预算和 Effect 身份；未结算 Provider 请求、未知副作用、需要交互授权的恢复和无法重建的旧 checkpoint 安全阻断。Task Outcome 由 Runtime 按执行状态、逐项要求证据和整体结果三组事实确定性构造，经 `task_outcome_settled` Durable Event 落在最终回复结算之前，并由 Runner 权威回放给 Renderer；运行成功和模型完成声明都不能填成通过。当前可信检查器只识别明确、可完整识别的根目录 `.txt` 文件内容要求。
- **工具与权限**：ToolExecutionService 是 Agent 工具的校验、授权、执行、清洗、取消和记录边界。公开权限选择统一为 `read-only`、`workspace-write` 和 `full-access`；`read-only`/`workspace-write` 只自动放行经原生文件守卫的工作区读取，`workspace-write` 的工作区写入自动放行只在 Windows 生效，Shell 在两种预设下仍需逐次批准；`full-access` 以 Main 记录的明确确认为前提，放宽普通本地资源的读取与写入，但不改变 Shell 逐次批准和硬拒绝。当前会话索引只接受带 V2 版本标记的三种权限；旧 `full`、`research`、`restricted` 和无版本记录会从 `sessions.json` 索引移除，不再显示迁移提示，聊天记录文件不因此删除。Main 在执行前重新判定路径和权限；内置工具执行应用层核心源码保护检查，但宿主 Shell 及其子进程没有 OS 隔离，可能绕过该检查，不能视为宿主级只读边界。Shell 仅有 P3 ADR 明确批准的精确命令例外；Shell 实际以当前用户权限在宿主执行，没有 OS 级沙箱。
- **文件与数据**：覆盖既有文件需有完整读取观察，提交时按内容哈希复核；部分、截断或清洗读取不能授权覆盖。应用数据根是 LS 的逻辑容器边界，workplace 只是默认工作区；外部项目不因被选中而成为容器内资源。当前路径容器是 Main 的分类与审批闸门，不是 OS/Docker 沙箱。
- **Context 与缓存**：请求前缀按追加式账本保持；Context Engine 拥有候选、预算、淘汰和 token 账本。已发送前缀不能被预算裁剪。长任务缓存按现行规程达标；短任务的冷启动结构成本仍可能低于红线。
- **Memory**：默认从受限根索引开始，再沿分支导航；向量只在已导航分支的深搜中作候选。memory_tree 只读；durable Memory 由受控 memory_write / memory_manage 提交并需批准，压缩只产生会话摘要。相似度只能提名，不能单独决定合并或纠正。
- **桌面与启动**：Local App API 在 Runner 完全恢复前提供可用的元数据和工作区能力；Runner 依赖操作明确返回未就绪。界面、会话历史、草稿、工作区和 Runner readiness 是分阶段状态，不应互相阻塞。
- **插件与网络**：外部渠道可选且失败隔离。公开 Web 读取只通过已配置 Provider 与匿名 GET；重定向、DNS/IP、大小、超时、SSRF、引用和外部不可信内容均由 Runtime 约束。

## 当前有效的重要限制

- 同批模型输出包含 request_user_input 时，兄弟工具调用不会执行；调用会带原因记入转录，提问仍正常发布。
- 权限拒绝表示仍需用户决定；Runtime 在执行前确定性拒绝的调用和已记录失败则是已知负结果，不伪装成缺失证据。副作用未结算或运行中止时明确停止。
- 恢复由 Runtime 决定且有界，只接受具备安全段边界、可重建的当前 Main 权限/工作区身份且无未结算 Provider 请求或未知副作用的 checkpoint；其他窗口保持阻断。已完成步骤与已结算副作用不重复执行。模型调用预算耗尽直接升级；结构性证据缺口最多给主循环一次闭合机会。
- Task Outcome 的可信检查只覆盖明确、可完整识别的根目录 `.txt` 内容要求（最多三条），不是通用要求抽取或通用任务验收。P05 评审指出的展示层缺陷尚未修复：`unknown` 且没有成功文件写入时整卡不渲染；`is-completed`/`is-unresolved` 没有任何 CSS 规则；验证结论只在已有其它注意项或存在 `fail` 记录时才进入 `role="status"` 注意行，单独的 `unverified` 不进入该状态通道。
- V2 的一般 Shell 自动放行与 P3 生产集成保持冻结；历史 `full` 自动授权例外已退役，旧权限会话不作兼容迁移。唯一 Shell 重复执行例外是 P3 ADR 中用户主动启用的 Main 固定精确命令候选。所有 Shell 命令仍按当前用户身份在宿主运行；目录和文件检查不等于 OS 沙箱。直接授权工作区曾通过硬链接越界，快照实验也未证明运行期完整性。
- Permission V2 的 `workspace-write` 自动文件守卫当前只在 Windows 可用；macOS/Linux 的写入自动授权保持关闭。Electron 发布包已配置 Windows x64 NSIS 与 Linux x64 Debian 目标；Linux 目标尚未完成安装包构建和安装验收（见下文 Linux x64 条目）。
- Memory 写入的 user-request 理由必须有真实用户指令来源；necessary 必须说明用途及不保存的损失。普通聊天、压缩和外部网页不能自行生成长期记忆。
- Web 与搜索结果是 external_untrusted；只有本轮 Runtime 签发的引用可以出现在最终回答中。受限、超时、截断和缓存状态不能表达为完整验证。

## 主要验证结论与边界

- 缓存长任务红线由 check:cache-acceptance 判定，当前基线在长任务、重启续接和 45 分钟空闲续接上达标。三回合短负载约 87–89% 是请求形状的冷启动上限；不通过填充、预热或排除调用追高。规程和账本分别见[缓存验收规程](../reference/cache-95-acceptance.md)与[缓存基线目录](../reference/cache-baseline/README.md)。
- 文件一致性由 verify:file-consistency-faults 和 verify:desktop-file-consistency 覆盖；它们分别验证真实文件故障与桌面文件读取、拒绝和读回边界。2026-10-12 的 Electron 文件一致性实测 14 项通过；该历史结果当时使用旧 `full` 参数，不代表当前 API 合约，也不覆盖 V2 选择器、危险确认或 Renderer 审批弹窗。其覆盖之外的桌面回滚入口和 Windows junction / symlink 差异仍需留意。
- **安全段持久恢复与 Permission V2 桌面验收（S2B-G，2026-10-16）**：真实 Electron Main、Local App API、Runner、Harness 在第 2 段安全 checkpoint 写入后终止进程，重启后接管原 Run 并完成 35/35，预算、ingress、Effect 与最终结算均不重复；同一批另有真实 Electron Renderer 的 Permission V2 验收（27 条断言），覆盖预设选择、审批与拒绝、工作区写入边界、降权后恢复和 Shell 重新决策。该结果只证明安全段边界恢复和所列交互，不覆盖任意崩溃点、已发出但结果未知的 Provider 请求、跨主机接管或宿主 Shell 子进程的 exactly-once。见 [S2B-G 验收报告](../reference/rcd-s2b-g-electron-acceptance-2026-10-16.md)，前序跨进程证据见 [S2B-2 第三单元](../reference/rcd-s2b-2-third-unit-recovery-acceptance-2026-10-16.md)。
- **Durable Task Outcome（S2C-E，2026-10-17）**：真实 Electron + 本地受控 Provider 下，Runtime 固定目标文件检查器实际读取工作区文件字节；T06 的错误产物对应要求判为 `failed`、整体 `partially_completed`，T07 两个用户要求分别 `passed`/`failed`、整体 `partially_completed`，历史回放每个 Run 只显示一张结果卡片。结算顺序与六个真实子进程故障窗口见 [S2C-D](../reference/rcd-s2c-d-settlement-consistency-2026-10-17.md)：投影或 ExecutionLog 缺失时安全降级为 `unknown`，不重跑副作用。检查证据只绑定读取时点的文件版本，不代表文件之后未变化；它不是通用任务验收。最终验收见 [S2C-E](../reference/rcd-s2c-e-task-delivery-acceptance-2026-10-17.md)。
- **真实 Provider 首批试跑（S3B-R，2026-10-17）**：用户授权下，DeepSeek `deepseek-flash` 四项任务各完成 1 次有效真实 Runner/Harness 试跑，独立 Oracle 为 2 通过 / 2 失败；另有 2 次错误模型 ID 的尝试（合计 16 个失败物理请求）不计入有效结果，也不假定无费用。4 个样本不构成成功率，费用无权威账单回执（`unavailable`）。两项失败的归因是任务/Oracle 契约缺陷而非模型能力失败，历史 Oracle 结果保持不变。复盘还确认了三处评测器记账缺陷（DELIV-01 归因与同记录产物证据矛盾、`productSourceDirty` 顶层与逐记录语义冲突、报告散文与产物证据不符），其中归因缺陷已在 S3B-P 修复，历史账本与报告未改写。见 [S3B-R 报告](../reference/rcd-s3b-real-deepseek-report-2026-10-17.md) 与 [P02/P03 归因](../reference/rcd-s3b-p02-p03-failure-attribution-2026-10-17.md)。
- **真实 Provider 评测层可靠性（S3B-P，证据批次 2026-10-17）**：评测覆盖层完成内部引用→wire 模型 ID 显式映射、确定性 4xx 禁止重放、物理请求计量（失败尝试计入预算）、凭据脱敏和“归因不得与 Oracle 证据矛盾”的加固，并由独立验证以 49 组 / 83 个对抗探针复核通过。该批没有调用真实 Provider；第二轮协议（每任务 N=5）尚未执行，仍待用户明确授权。见 [S3B-P 复盘](../reference/rcd-s3b-p-reliability-report-2026-10-17.md) 与 [独立验证账本](../reference/rcd-s3b-p-verification-2026-10-17.json)。
- **Linux x64 实机验证（2026-10-13，WSL2 / Ubuntu 26.04，Electron 44.4.5）**：干净 `main` 副本的 `linux-unpacked` 包构建通过；asar 清单检查了 node-pty、onnxruntime-node、sharp、@huggingface 与 libvips 载荷。打包 Electron 进程中 Transformers 导入和 ONNX Runtime 1.30.0 加载通过；真实 node-pty shell 输入、输出、resize(101×37) 与退出通过。P4-2B3 实机记录包含四次 GUI 启动、窗口截图和 Runtime readiness；早期 SIGTRAP 本轮未复现，启动时间接近只构成相关性，原因仍未知，不再将其视为当前 GUI 启动阻断。(1) **sharp 图像操作暂不支持但不阻断当前 Linux 基础功能**：独立 Electron 子进程实际 PNG 编码仍以 SIGSEGV 退出，报告为 `known-incompatible`、`blocking:false`、`capability:unsupported`。已记录 GLib 符号冲突与上游问题；若 LS 增加 Electron 进程内图像处理，必须重新将该测试设为阻断项。(2) **Linux 正式发布尚未验收**：新增 Debian x64 目标、包主页、维护者和 PNG 图标元数据；本轮 electron-builder 的 FPM 请求中断，没有生成可安装 `.deb`，干净安装仍待验证。(3) **真实文本 Embedding 尚未验收**：清单 smoke 现在要求本地哈希校验模型并实际完成 512 维 ONNX 文本推理；本机与 WSL 的可信模型下载均因 Hugging Face 连接超时失败，因此本轮结果为 `not-attempted`，发布门正确保持失败。(4) **托盘验证部分通过**：Linux Electron 从打包资源加载 1024×1024 PNG 并创建 Tray 对象；当前 WSLg 没有 StatusNotifier 托盘宿主，图标在桌面面板中的可见性未验证。WSL 发行版缺 CJK 字体也仍是环境限制。
- Memory 的确定性受控写入与迁移门已覆盖隔离数据根；真实模型下的长期质量、必要决定的按需写入及含糊指代拒绝仍未充分验证。`verify:memory-v3-provider` 已按当前七阶段图校验真实运行 trace，并继续要求受控写入、重启持久性、重启后召回和未授权写入拒绝证据；本次确定性脚本修复没有运行真实 Provider 验收.
- 真实 Electron、Provider、打包与本地单元测试是不同证据层。check:repo、typecheck 或 build 通过不代表这些场景已验证；具体有效入口见各 owner 文档和 scripts/README.md。

## 未完成边界

- **Provider 与长任务**：真实 Provider 证据仍只有 S3B-R 的四项任务各 1 次试跑；第二轮 N=5 协议尚未获授权执行，因此没有通过率、方差或成本结论，费用也没有权威账单回执。更多实际启用 Provider 的专用 token / tool calibration、超大窗口配置下的摘要触发、真实用户长负载和 Memory 语义质量仍待补充。稳定 system 前缀中的时间段曾出现变化风险，相关段调整时需重验缓存基线。
- **恢复与副作用**：自动恢复只覆盖安全执行段边界；已发出但结果未持久化的 Provider 请求、未知副作用、需要交互授权的恢复、跨主机接管和任意崩溃点仍安全阻断。外部系统副作用对账、真实网络中断和更长期负载仍未闭环。数据根迁移进入正式用户数据前须按迁移验收并取得用户决定。
- **桌面与权限**：真实 Electron 已覆盖 Permission V2 预设选择、审批与拒绝、权限降级、checkpoint 恢复重新审批和 Shell 精确重复授权；仍缺任意崩溃点恢复、完整故障窗口、跨主机恢复以及物理输入/辅助设备的真实窗口验收。安装包的干净机器安装、升级和卸载尚未验证。
- **跨平台基础**：Linux x64 的 Electron GUI、Runtime readiness、打包原生模块加载与真实 PTY 已有 WSL2 实机证据；普通 Linux 功能门不阻断于当前未使用的 sharp 图像操作，但本地文本 Embedding 推理、`.deb` 的构建与干净安装、托盘宿主可见性仍未验收，Linux 自动工作区写入守卫也仍关闭。macOS 尚无构建、签名或实机验收证据。Windows Shell 沙箱生产集成已暂停，当前结论与解除条件见 [Shell 执行隔离技术取舍](shell-isolation-decision-2026-10-12.md)。
- **效率与生态**：coding-agent 治理成本配对试验的**正确性与安全对照已完成**——规则第 5 条收窄为"显式枚举允许值"后，E3 在三个独立样本上 6/6 通过隐藏 oracle，哨兵 5/5 完好、零提交、零标记进入候选改动。**效率门仍未证明**：逐会话 token／工具调用／墙钟读数不完整，因此不声称治理成本下降。实际客户端加载路径已验证：Codex 按 cwd 注入 `AGENTS.md`，抽样 127 个会话中隔离工作树仅 1 次注入、主检出 5 次，干净 checkout 与隔离工作树**不会**自动加载仓库规则；要自动送达需版本化一个简短的根 `AGENTS.md`（会替换本机私有同名文件，属需用户决定的有条件工作）。与成熟 Agent 可比的任务效率基线仍未建立。验证范围已区分：`verify:changed` 覆盖 checkout 中所有变更，任务内定向验收使用 `verify:task -- --files=...` 明确输入。MCP、插件 API v2 和运行时分发仍属后续方向，不代表已实现。
- **对话连续性的五项无归属项**（退役审计，来源：`2919b69c` 退役的对话任务连续性任务书）：该任务书退役时自跟踪 9 项开放项、退役提交只按 2 项收口，其余中 **§10.2 发布指标门（8 项硬计数聚合）、§11.2 只读迁移扫描、§11.3 回滚演练、§4.1/§4.3 `ambiguous` 语义、§8 阶段 0 baseline 报告**既无实现也无 owner，另有 `schema hash` 半项。它们不阻塞当前交付，但在被重新排期或明确否决前必须保持可见。
- **界面工作**：仍在执行的范围与未验证项见[前端简洁高效化任务书](../taskbooks/frontend-simplification-taskbook-2026-09-27.md)；本文件不重复其逐项台账。

## 后续方向

先完成正在进行的 Runtime、安全和界面验收，再依据实测决定是否调整架构或扩展能力。相关工作所有者见[Decision 索引](README.md)和[Taskbooks 索引](../taskbooks/README.md)。核心流程的精确状态和恢复规则见[Core Flow 状态契约](../reference/core-flow-state-contract.md)与[核心 Agent 流程规范](../principles/core-agent-flow-guidelines.md)。
