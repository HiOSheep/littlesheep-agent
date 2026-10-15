# Shell 执行隔离技术取舍（2026-10-12）

**状态：已决定；P3 Shell 隔离生产集成仍冻结。** P3-A 至 P3-A4 的实验与失败证据保留，但本轮不启动 P3-A5，也不进入 P3-B。S3 已退役历史 `full` 自动授权例外；按 2026-10-15 的破坏性更新决策，旧权限会话不迁移，过期/无版本的权限记录从当前会话索引清除。经单独修订，V2 只允许下述 S2 精确命令例外；其余 Shell invocation 仍须逐次请求批准。任何批准都只允许命令以当前用户身份在宿主运行，不代表命令受到工作区或 OS 沙箱约束。

## 威胁模型

近期目标是约束 Agent 生成的恶意命令，并把工作区中的恶意路径结构作为输入攻击面；Main、操作系统和可信的隔离构建器属于信任边界。当前方案**不承诺抵御拥有同一用户权限的恶意宿主进程**。这项边界不能被解释为允许忽略硬链接、重解析点、源内容授权、目录替换或外传路径。

当前 Shell 在宿主进程环境执行。V2 审批未收到批准、审批服务不可用或运行中断时，不得自动放行。2026-10-15 的 S3 决策撤销了历史 `full` 的免逐次 Shell 审批例外，并停止兼容旧权限会话；当前索引不接纳旧版本或已退役的权限值。V2 单次审批提示明确披露宿主级执行风险。

## S2 精确命令重复授权例外（2026-10-15）

批准一个有限例外，允许用户在当前对话中显式记住 Main 审查的精确命令。首版候选集仅含原文恰为 `pwd`、无参数且工作目录等于 Main 绑定工作区根的 Agent `exec` 调用；其他命令（包括 `git status --short`、构建/测试脚本、插件和外部脚本）仍按单次或 S1 批次审批处理。该候选范围是产品授权范围，不是对命令效果或宿主安全性的证明。

- 每次 Shell 调用仍先经过当前 Main 权限快照、受保护资源、硬拒绝和强制审批判断。硬拒绝始终拒绝；必须逐次确认的审批不能被重复授权覆盖。通过重复授权匹配时，Main 只签发当前 invocation 的一次性执行凭据，并在最终启动前重新核验执行事实。
- 重复授权只由用户在符合条件的 `pwd` 审批中主动选择；默认关闭。绑定当前 Session、可信 Workspace 身份、工作区根 `cwd` 身份、解释器路径/参数/身份、用户、完整权限快照、受控环境指纹和实际 timeout。命令原文严格相等，不接受别名、参数、前后缀、模式或用户自定义规则；不同 `run` 可以复用，但不同会话、工作区或以上任一执行事实变化均不能复用。
- 授权只存在于当前 Main 进程内，30 分钟或 20 次重复匹配中先到者失效；重启、Main 重建或无法证明连续性时清除。会话、工作区身份或权限事实改变时也自动失效。按用户于 2026-10-15 的明确产品决定，不提供查看、列表或手动撤销入口；该选择接受授权在达到自动失效条件前不可由用户立即撤销的限制。
- Renderer 显示完整命令、Shell、cwd、工作区、当前宿主用户、授权期限及宿主风险；明确说明无 OS 级 Shell 沙箱，命令可能访问工作区外资源、网络或子进程。不得提供整类 Shell 授权。Checkpoint 和 Agent 上下文不保存、不重建此状态。

此例外改变了 V2 的逐次交互政策，但不改变 P3 的隔离状态。用户接受的是相同精确命令再次以当前宿主用户身份运行的风险；这不表示命令被证明无副作用，也不约束它可能访问的数据。该授权不适用于 Shell 隔离能力不可用时本应拒绝的操作，并且不能覆盖当前硬拒绝、权限降级、会话切换或自动失效条件。用户已明确选择不提供授权查看和即时撤销入口；这是有意收窄管理能力，不改变 Main 在内存中进行消费与失效管理的责任。

## 证据与取舍

P3-A2 已在真实 NTFS fixture 中复现：工作区内硬链接可让 PowerShell 和 Node 读取、修改工作区外哨兵。P3-A4 证明限定 NTFS 场景下可从固定源句柄复制到不同文件对象，并拦截了特定目录替换竞态；但同用户宿主进程成功替换快照内普通文件，沙箱随后读到新内容。复制为不同文件对象不证明源数据本身获准读取，也不证明快照运行期完整性。详细逐项证据见 [Windows Shell Sandbox PoC](../reference/windows-shell-sandbox-poc.md)。

真实 LS 仓库的只读 census 记录了 118,197 个子项、33,463 个多硬链接文件路径和 1,983 个 reparse point，逻辑复制量估算为 6,007,247,318 字节；23.1 秒只代表 census，不是全量快照耗时。整树快照未执行，完整耗时、Git 仓库可用性和 Node 项目脚本兼容性均未证明。

| 路线 | 决定 | 理由 |
| --- | --- | --- |
| 直接授权真实工作区给 AppContainer Shell | 不采用 | 已复现硬链接越界读写；路径授权不能切断共享文件对象。 |
| 整树复制后在 AppContainer 中运行 | 暂不作为默认 | 复制可分离文件对象，但读取授权和运行期完整性仍未解决；项目条目、reparse point 与磁盘开销使默认体验代价明显。可保留为高隔离研究选项。 |
| 任务级精简快照和受控变更回传 | 仅保留为候选 | 可能缩小成本，但输入选择、运行时依赖、Git 状态、冲突和变更提交语义尚未验证；不把它当成已成立的安全方案。 |
| 文档化 AppContainer 启动接口加独立资源策略 | 可做小规模可行性验证，暂不接入生产 | 启动 API 的稳定性与文件对象安全是不同问题。它仍需重跑全部隔离探针、Git CWD、网络、子进程及生命周期验证。 |
| VM 或更强虚拟化 | 高风险任务的长期候选 | 隔离边界更强，但冷启动、并发、运行时供给、磁盘与变更回传成本未评估。 |

微软当前 `Experimental_CreateProcessInSandbox` 文档仍将 API 标为 experimental / subject to change，并把规范版本固定为 `0.1.0`；因此不把它选作面向普通用户发布的长期 ABI。[API 文档](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)。文档化的 AppContainer 启动和 ACL 机制可以作为独立候选继续评估，但启动接口本身不会消除硬链接别名问题。[AppContainer 启动说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)。

## 产品状态与验收顺序

### Permission V2 桌面验收

先把已有 P1/P2 安全能力变成可理解、可实测的产品交互。当前选择器统一提供三个 V2 预设（`read-only`、`workspace-write`、`full-access`）；旧权限数据不作转换，只有 V2 版本标记和当前预设都有效的会话索引项会保留。下一验收应覆盖：

1. Renderer 中的模式选择、危险确认、会话持久化、新会话默认和切换会话，不混淆历史模式与 V2 预设。
2. 只读写入升级、拒绝、审批回调缺失/中断、硬拒绝与 `unavailable` 的真实弹窗行为。
3. 当前 run 权限快照不可被后续未授权请求替换；权限降级后 continuation 与 checkpoint resume 采用当前会话权限，不能恢复已失效授权。
4. 真实文件内容验证工作区内读写、过期观察拒绝、越界路径和链接拒绝；直接工具调用与插件路径仍经 Main 统一策略。
5. `exec` 审批及 `full-access` 的启用确认清楚展示宿主级执行和无 OS 级隔离；Shell 仍逐次审批。批准不得被 UI 描述成“工作区沙箱内执行”。

2026-10-12 的 `verify:desktop-file-consistency` 历史记录在真实 Electron 窗口中有 14 项检查通过，验证了文件读取、用户保存与 stale-edit 拒绝/恢复；当时使用旧 `full` 参数，不能视为当前 API 合约或替代 V2 选择器、危险确认和 Renderer 审批验收。

### macOS / Linux 基础适配

先做平台构建与原生文件、路径和终端兼容性验证，沙箱研究不阻塞基础适配。当前 `workspace-file-guard` 只在 Windows 声明可用；macOS/Linux 上不能据此自动开放 V2 工作区写入。当前 Electron 打包配置只有 Windows x64 目标，没有 macOS/Linux 的安装包或干净机器证据。

- **macOS**：评估 App Sandbox entitlement、用户选择目录的 security-scoped URL/bookmark、签名 helper 与子进程权限；必须在实际签名构建和授权目录上验证。Apple 文档提供这些沙箱和文件授权机制，但不构成 LS 后端已通过验证的证据。[App Sandbox](https://developer.apple.com/documentation/security/app_sandbox) · [访问沙箱内文件](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)
- **Linux**：在目标发行版和内核上探测 namespace 能力及 Landlock ABI，再评估 seccomp、网络隔离和文件系统层；这些机制分工不同，任何一个都不能独自代表完整 Shell 沙箱。[Landlock](https://docs.kernel.org/userspace-api/landlock.html) · [seccomp filter](https://docs.kernel.org/userspace-api/seccomp_filter.html) · [OverlayFS](https://docs.kernel.org/filesystems/overlayfs.html)
- **共通基础门**：验证大小写与规范化、symlink/junction/reparse point/hardlink/mount、绝对路径和穿越、终端与 PTY、原生依赖重建、安装/升级/卸载。平台守卫未可用或证据不足时，文件写入保持审批/拒绝，不能宣称应用层路径分类等同 OS 隔离。

## 解除生产冻结的必要条件

重新评估 P3 生产 Shell 自动执行前，必须先选定并实现具体后端，再针对每个受支持平台证明：授权工作区和敏感宿主对象的读写边界、硬链接与所有支持的重解析对象、并发替换和运行期快照完整性、DNS/IPv4/IPv6/代理/本地网络的拒绝、PowerShell/Node/Git 及子进程约束、超时/取消/异常清理，以及初始化失败时绝不回退到宿主执行。能力证据需由 Main 为当前工作区和 run 实际产生；任何 `partial`、`unavailable` 或未测场景都不够开启 P3 隔离式自动执行。S2 的精确命令重复授权是独立、明示的宿主风险例外，不表示上述 P3 条件已满足。
