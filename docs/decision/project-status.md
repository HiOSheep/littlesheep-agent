# LittleSheep 项目状态

本文件只记录当前实现、仍有效的限制和会影响下一步决策的验证结论。详细契约由源码、测试及对应 owner 文档维护；逐次验收过程和旧状态由 Git 历史保存。

## 当前成熟度

LittleSheep 已具备本地 Agent 的主要运行骨架：单一 Harness 主循环、统一受控工具执行、索引优先的 Memory、桌面聊天与工作区、可迁移应用数据根和可选渠道。它仍是 alpha，不能宣称发布就绪。安装、签名、升级、卸载和原生依赖分发尚未闭环；真实 Provider 覆盖和长时负载样本仍有限。

## 当前实现

- **执行与验证**：活动路由只进入常规执行主循环或 Runtime 事实回复。DECIDE、验证模型调用、恢复模型调用和 CAPTURE 不存在；旧 TaskBook 只作为历史数据读取。Runtime 根据已记录证据验证；需要人工判断的完成项标记为 unverified。
- **工具与权限**：ToolExecutionService 是 Agent 工具的校验、授权、执行、清洗、取消和记录边界。完全访问、研究、受限三种模式只改变授权。Main 在执行前重新判定路径和权限；核心源码仍是宿主级只读边界。
- **文件与数据**：覆盖既有文件需有完整读取观察，提交时按内容哈希复核；部分、截断或清洗读取不能授权覆盖。应用数据根是 LS 的逻辑容器边界，workplace 只是默认工作区；外部项目不因被选中而成为容器内资源。当前路径容器是 Main 的分类与审批闸门，不是 OS/Docker 沙箱。
- **Context 与缓存**：请求前缀按追加式账本保持；Context Engine 拥有候选、预算、淘汰和 token 账本。已发送前缀不能被预算裁剪。长任务缓存按现行规程达标；短任务的冷启动结构成本仍可能低于红线。
- **Memory**：默认从受限根索引开始，再沿分支导航；向量只在已导航分支的深搜中作候选。memory_tree 只读；durable Memory 由受控 memory_write / memory_manage 提交并需批准，压缩只产生会话摘要。相似度只能提名，不能单独决定合并或纠正。
- **桌面与启动**：Local App API 在 Runner 完全恢复前提供可用的元数据和工作区能力；Runner 依赖操作明确返回未就绪。界面、会话历史、草稿、工作区和 Runner readiness 是分阶段状态，不应互相阻塞。
- **插件与网络**：外部渠道可选且失败隔离。公开 Web 读取只通过已配置 Provider 与匿名 GET；重定向、DNS/IP、大小、超时、SSRF、引用和外部不可信内容均由 Runtime 约束。

## 当前有效的重要限制

- 同批模型输出包含 request_user_input 时，兄弟工具调用不会执行；调用会带原因记入转录，提问仍正常发布。
- 权限拒绝表示仍需用户决定；Runtime 在执行前确定性拒绝的调用和已记录失败则是已知负结果，不伪装成缺失证据。副作用未结算或运行中止时明确停止。
- 恢复由 Runtime 决定且有界；已完成步骤不重复执行。模型调用预算耗尽直接升级；结构性证据缺口最多给主循环一次闭合机会。
- 研究和受限模式下，外部或范围不明工作区未经批准不得自动扫描；完全访问须经一次危险确认。逻辑容器不提供宿主进程隔离。
- Memory 写入的 user-request 理由必须有真实用户指令来源；necessary 必须说明用途及不保存的损失。普通聊天、压缩和外部网页不能自行生成长期记忆。
- Web 与搜索结果是 external_untrusted；只有本轮 Runtime 签发的引用可以出现在最终回答中。受限、超时、截断和缓存状态不能表达为完整验证。

## 主要验证结论与边界

- 缓存长任务红线由 check:cache-acceptance 判定，当前基线在长任务、重启续接和 45 分钟空闲续接上达标。三回合短负载约 87–89% 是请求形状的冷启动上限；不通过填充、预热或排除调用追高。规程和账本分别见[缓存验收规程](../reference/cache-95-acceptance.md)与[缓存基线目录](../reference/cache-baseline/README.md)。
- 文件一致性由 verify:file-consistency-faults 和 verify:desktop-file-consistency 覆盖；它们分别验证真实文件故障与桌面批准后的读取、拒绝和读回边界。其覆盖之外的桌面回滚入口和 Windows junction / symlink 差异仍需留意。
- Memory 的确定性受控写入与迁移门已覆盖隔离数据根；真实模型下的长期质量、必要决定的按需写入及含糊指代拒绝仍未充分验证。verify:memory-v3-provider 当前要求已移除的 EVOLVE / CAPTURE 字段，修复前不能作为验收证据。
- 真实 Electron、Provider、打包与本地单元测试是不同证据层。check:repo、typecheck 或 build 通过不代表这些场景已验证；具体有效入口见各 owner 文档和 scripts/README.md。

## 未完成边界

- **Provider 与长任务**：更多实际启用 Provider 的专用 token / tool calibration、超大窗口配置下的摘要触发、真实用户长负载和 Memory 语义质量仍待补充。稳定 system 前缀中的时间段曾出现变化风险，相关段调整时需重验缓存基线。
- **恢复与副作用**：强制结束进程后的并发 checkpoint 恢复曾遇到 active resume lease 冲突；外部系统副作用对账、真实网络中断和更长期负载仍未闭环。数据根迁移进入正式用户数据前须按迁移验收并取得用户决定。
- **桌面与权限**：受限模式批准对话框尚无真实窗口证据；安装包的干净机器安装、升级和卸载尚未验证。
- **效率与生态**：coding-agent 治理成本配对试验的**正确性与安全对照已完成**——规则第 5 条收窄为"显式枚举允许值"后，E3 在三个独立样本上 6/6 通过隐藏 oracle，哨兵 5/5 完好、零提交、零标记进入候选改动。**效率门仍未证明**：逐会话 token／工具调用／墙钟读数不完整，因此不声称治理成本下降。实际客户端加载路径已验证：Codex 按 cwd 注入 `AGENTS.md`，抽样 127 个会话中隔离工作树仅 1 次注入、主检出 5 次，干净 checkout 与隔离工作树**不会**自动加载仓库规则；要自动送达需版本化一个简短的根 `AGENTS.md`（会替换本机私有同名文件，属需用户决定的有条件工作）。与成熟 Agent 可比的任务效率基线仍未建立。验证范围已区分：`verify:changed` 覆盖 checkout 中所有变更，任务内定向验收使用 `verify:task -- --files=...` 明确输入。MCP、插件 API v2 和运行时分发仍属后续方向，不代表已实现。
- **界面工作**：仍在执行的范围与未验证项见[前端简洁高效化任务书](../taskbooks/frontend-simplification-taskbook-2026-09-27.md)；本文件不重复其逐项台账。

## 后续方向

先完成正在进行的 Runtime、安全和界面验收，再依据实测决定是否调整架构或扩展能力。相关工作所有者见[Decision 索引](README.md)和[Taskbooks 索引](../taskbooks/README.md)。核心流程的精确状态和恢复规则见[Core Flow 状态契约](../reference/core-flow-state-contract.md)与[核心 Agent 流程规范](../principles/core-agent-flow-guidelines.md)。
