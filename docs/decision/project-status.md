# LittleSheep 项目状态

本文件只记录当前实现、仍有效的限制和会影响下一步决策的验证结论。详细契约由源码、测试及对应 owner 文档维护；逐次验收过程和旧状态由 Git 历史保存。

## 当前成熟度

LittleSheep 已具备本地 Agent 的主要运行骨架：单一 Harness 主循环、统一受控工具执行、索引优先的 Memory、桌面聊天与工作区、可迁移应用数据根和可选渠道。它仍是 alpha，不能宣称发布就绪。安装、签名、升级、卸载和原生依赖分发尚未闭环；真实 Provider 覆盖和长时负载样本仍有限。

## 当前实现

- **执行与验证**：活动路由只进入常规执行主循环或 Runtime 事实回复。DECIDE、独立 VERIFY、验证模型调用、恢复模型调用和 CAPTURE 不存在；旧 TaskBook 与 verification record 只保留历史读取。EXECUTE 结算运行证据，证据完整不代表用户目标已验收；缺少任务级验收依据时保持 unverified。
- **工具与权限**：ToolExecutionService 是 Agent 工具的校验、授权、执行、清洗、取消和记录边界。公开权限选择统一为 `read-only`、`workspace-write` 和 `full-access`。当前会话索引只接受带 V2 版本标记的三种权限；旧 `full`、`research`、`restricted` 和无版本记录会从 `sessions.json` 索引移除，不再显示迁移提示，聊天记录文件不因此删除。Main 在执行前重新判定路径和权限；内置工具执行应用层核心源码保护检查，但宿主 Shell 及其子进程没有 OS 隔离，可能绕过该检查，不能视为宿主级只读边界。Shell 仅有 P3 ADR 明确批准的精确命令例外；Shell 实际以当前用户权限在宿主执行，没有 OS 级沙箱。
- **文件与数据**：覆盖既有文件需有完整读取观察，提交时按内容哈希复核；部分、截断或清洗读取不能授权覆盖。应用数据根是 LS 的逻辑容器边界，workplace 只是默认工作区；外部项目不因被选中而成为容器内资源。当前路径容器是 Main 的分类与审批闸门，不是 OS/Docker 沙箱。
- **Context 与缓存**：请求前缀按追加式账本保持；Context Engine 拥有候选、预算、淘汰和 token 账本。已发送前缀不能被预算裁剪。长任务缓存按现行规程达标；短任务的冷启动结构成本仍可能低于红线。
- **Memory**：默认从受限根索引开始，再沿分支导航；向量只在已导航分支的深搜中作候选。memory_tree 只读；durable Memory 由受控 memory_write / memory_manage 提交并需批准，压缩只产生会话摘要。相似度只能提名，不能单独决定合并或纠正。
- **桌面与启动**：Local App API 在 Runner 完全恢复前提供可用的元数据和工作区能力；Runner 依赖操作明确返回未就绪。界面、会话历史、草稿、工作区和 Runner readiness 是分阶段状态，不应互相阻塞。
- **插件与网络**：外部渠道可选且失败隔离。公开 Web 读取只通过已配置 Provider 与匿名 GET；重定向、DNS/IP、大小、超时、SSRF、引用和外部不可信内容均由 Runtime 约束。

## 当前有效的重要限制

- 同批模型输出包含 request_user_input 时，兄弟工具调用不会执行；调用会带原因记入转录，提问仍正常发布。
- 权限拒绝表示仍需用户决定；Runtime 在执行前确定性拒绝的调用和已记录失败则是已知负结果，不伪装成缺失证据。副作用未结算或运行中止时明确停止。
- 恢复由 Runtime 决定且有界；已完成步骤不重复执行。模型调用预算耗尽直接升级；结构性证据缺口最多给主循环一次闭合机会。
- V2 的一般 Shell 自动放行与 P3 生产集成保持冻结；历史 `full` 自动授权例外已退役，旧权限会话不作兼容迁移。唯一 Shell 重复执行例外是 P3 ADR 中用户主动启用的 Main 固定精确命令候选。所有 Shell 命令仍按当前用户身份在宿主运行；目录和文件检查不等于 OS 沙箱。直接授权工作区曾通过硬链接越界，快照实验也未证明运行期完整性。
- Permission V2 的 `workspace-write` 自动文件守卫当前只在 Windows 可用；macOS/Linux 的写入自动授权保持关闭。Electron 发布包已配置 Windows x64 NSIS 与 Linux x64 Debian 目标；Linux 目标尚未完成安装包构建和安装验收（见下文 Linux x64 条目）。
- Memory 写入的 user-request 理由必须有真实用户指令来源；necessary 必须说明用途及不保存的损失。普通聊天、压缩和外部网页不能自行生成长期记忆。
- Web 与搜索结果是 external_untrusted；只有本轮 Runtime 签发的引用可以出现在最终回答中。受限、超时、截断和缓存状态不能表达为完整验证。

## 主要验证结论与边界

- 缓存长任务红线由 check:cache-acceptance 判定，当前基线在长任务、重启续接和 45 分钟空闲续接上达标。三回合短负载约 87–89% 是请求形状的冷启动上限；不通过填充、预热或排除调用追高。规程和账本分别见[缓存验收规程](../reference/cache-95-acceptance.md)与[缓存基线目录](../reference/cache-baseline/README.md)。
- 文件一致性由 verify:file-consistency-faults 和 verify:desktop-file-consistency 覆盖；它们分别验证真实文件故障与桌面文件读取、拒绝和读回边界。2026-10-12 的 Electron 文件一致性实测 14 项通过；该历史结果当时使用旧 `full` 参数，不代表当前 API 合约，也不覆盖 V2 选择器、危险确认或 Renderer 审批弹窗。其覆盖之外的桌面回滚入口和 Windows junction / symlink 差异仍需留意。
- **Linux x64 实机验证（2026-10-13，WSL2 / Ubuntu 26.04，Electron 44.4.5）**：干净 `main` 副本的 `linux-unpacked` 包构建通过；asar 清单检查了 node-pty、onnxruntime-node、sharp、@huggingface 与 libvips 载荷。打包 Electron 进程中 Transformers 导入和 ONNX Runtime 1.30.0 加载通过；真实 node-pty shell 输入、输出、resize(101×37) 与退出通过。P4-2B3 实机记录包含四次 GUI 启动、窗口截图和 Runtime readiness；早期 SIGTRAP 本轮未复现，启动时间接近只构成相关性，原因仍未知，不再将其视为当前 GUI 启动阻断。(1) **sharp 图像操作暂不支持但不阻断当前 Linux 基础功能**：独立 Electron 子进程实际 PNG 编码仍以 SIGSEGV 退出，报告为 `known-incompatible`、`blocking:false`、`capability:unsupported`。已记录 GLib 符号冲突与上游问题；若 LS 增加 Electron 进程内图像处理，必须重新将该测试设为阻断项。(2) **Linux 正式发布尚未验收**：新增 Debian x64 目标、包主页、维护者和 PNG 图标元数据；本轮 electron-builder 的 FPM 请求中断，没有生成可安装 `.deb`，干净安装仍待验证。(3) **真实文本 Embedding 尚未验收**：清单 smoke 现在要求本地哈希校验模型并实际完成 512 维 ONNX 文本推理；本机与 WSL 的可信模型下载均因 Hugging Face 连接超时失败，因此本轮结果为 `not-attempted`，发布门正确保持失败。(4) **托盘验证部分通过**：Linux Electron 从打包资源加载 1024×1024 PNG 并创建 Tray 对象；当前 WSLg 没有 StatusNotifier 托盘宿主，图标在桌面面板中的可见性未验证。WSL 发行版缺 CJK 字体也仍是环境限制。
- Memory 的确定性受控写入与迁移门已覆盖隔离数据根；真实模型下的长期质量、必要决定的按需写入及含糊指代拒绝仍未充分验证。verify:memory-v3-provider 当前要求已移除的 EVOLVE / CAPTURE 字段，修复前不能作为验收证据。
- 真实 Electron、Provider、打包与本地单元测试是不同证据层。check:repo、typecheck 或 build 通过不代表这些场景已验证；具体有效入口见各 owner 文档和 scripts/README.md。

## 未完成边界

- **Provider 与长任务**：更多实际启用 Provider 的专用 token / tool calibration、超大窗口配置下的摘要触发、真实用户长负载和 Memory 语义质量仍待补充。稳定 system 前缀中的时间段曾出现变化风险，相关段调整时需重验缓存基线。
- **恢复与副作用**：强制结束进程后的并发 checkpoint 恢复曾遇到 active resume lease 冲突；外部系统副作用对账、真实网络中断和更长期负载仍未闭环。数据根迁移进入正式用户数据前须按迁移验收并取得用户决定。
- **桌面与权限**：V2 选择器、确认、权限降级、审批拒绝/中断和 checkpoint 恢复仍缺完整真实窗口验收；现有 Electron 文件一致性脚本不覆盖这些交互。安装包的干净机器安装、升级和卸载尚未验证。
- **跨平台基础**：Linux x64 的 Electron GUI、Runtime readiness、打包原生模块加载与真实 PTY 已有 WSL2 实机证据；普通 Linux 功能门不阻断于当前未使用的 sharp 图像操作，但本地模型推理、Linux 安装包安装及托盘宿主可见性仍未验收。macOS 路径、Linux 原生文件守卫与干净安装验收仍未完成。Windows Shell 沙箱生产集成已暂停，当前结论与解除条件见 [Shell 执行隔离技术取舍](shell-isolation-decision-2026-10-12.md)。
- **效率与生态**：coding-agent 治理成本配对试验的**正确性与安全对照已完成**——规则第 5 条收窄为"显式枚举允许值"后，E3 在三个独立样本上 6/6 通过隐藏 oracle，哨兵 5/5 完好、零提交、零标记进入候选改动。**效率门仍未证明**：逐会话 token／工具调用／墙钟读数不完整，因此不声称治理成本下降。实际客户端加载路径已验证：Codex 按 cwd 注入 `AGENTS.md`，抽样 127 个会话中隔离工作树仅 1 次注入、主检出 5 次，干净 checkout 与隔离工作树**不会**自动加载仓库规则；要自动送达需版本化一个简短的根 `AGENTS.md`（会替换本机私有同名文件，属需用户决定的有条件工作）。与成熟 Agent 可比的任务效率基线仍未建立。验证范围已区分：`verify:changed` 覆盖 checkout 中所有变更，任务内定向验收使用 `verify:task -- --files=...` 明确输入。MCP、插件 API v2 和运行时分发仍属后续方向，不代表已实现。
- **对话连续性的五项无归属项**（退役审计，来源：`2919b69c` 退役的对话任务连续性任务书）：该任务书退役时自跟踪 9 项开放项、退役提交只按 2 项收口，其余中 **§10.2 发布指标门（8 项硬计数聚合）、§11.2 只读迁移扫描、§11.3 回滚演练、§4.1/§4.3 `ambiguous` 语义、§8 阶段 0 baseline 报告**既无实现也无 owner，另有 `schema hash` 半项。它们不阻塞当前交付，但在被重新排期或明确否决前必须保持可见。
- **界面工作**：仍在执行的范围与未验证项见[前端简洁高效化任务书](../taskbooks/frontend-simplification-taskbook-2026-09-27.md)；本文件不重复其逐项台账。

## 后续方向

先完成正在进行的 Runtime、安全和界面验收，再依据实测决定是否调整架构或扩展能力。相关工作所有者见[Decision 索引](README.md)和[Taskbooks 索引](../taskbooks/README.md)。核心流程的精确状态和恢复规则见[Core Flow 状态契约](../reference/core-flow-state-contract.md)与[核心 Agent 流程规范](../principles/core-agent-flow-guidelines.md)。
