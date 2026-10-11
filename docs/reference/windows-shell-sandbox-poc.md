# Windows Shell Sandbox PoC（P3-A）

## 结论

这是仅供实验的 Windows launcher，没有接入 `exec`、Main 权限策略、`ToolExecutionService` 或任何自动审批路径。当前 AppContainer 配置**未通过文件系统隔离门槛**。Shell 继续沿用现有审批策略。

本次使用任务开始时最新的 `main` 基线：`55d9e0a80e37542933fdee0cab88c74ceabcead7`。实测主机为 Windows 11 Home China、Build 26200、x64。最终窄授权报告生成于 `2026-10-11T17:33:28Z`，临时目录为 `%LOCALAPPDATA%\Temp\ls-windows-sandbox-poc-8b813cb181eb4fa5b3acbad29a0885d8`。首次包含卷根授权的报告仍保留在 `%LOCALAPPDATA%\Temp\ls-windows-sandbox-poc-fea0b8613f4743c0beac23ad1fec08ba`。这些都是本机实验记录，不是入库的测试产物。

报告通过 `SandboxCapabilitySnapshot` 和 `assessSandboxReadiness` 表达结果，Shell readiness 为 `ready: false`，并且 `readinessIsAuthorization` 明确为 `false`。

## Windows 技术方案比较

| 机制 | 可以提供的能力 | 单独使用的限制与本次选择 |
| --- | --- | --- |
| Windows Sandbox | 基于 Hypervisor 的一次性虚拟机，拥有隔离的内核。 | 是更强 VM 边界的候选方案，但 Microsoft 不支持 Windows Home；本机没有 `WindowsSandbox.exe`，因此无法实测。默认启用网络，映射目录也必须谨慎配置。[版本要求](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/) · [配置](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file) |
| AppContainer / `Experimental_CreateProcessInSandbox` | 创建低权限 AppContainer，可传入显式文件系统授权和网络能力。 | 由于本机 Windows 11 存在该 export，选择它进行真实进程探测。API 与 schema 仍是实验性的，需要动态查找 export，且没有公开 SDK 头文件。第一轮错误地把 `C:\` 和 `D:\` 卷根加入只读授权；Microsoft 文档说明只读路径会递归授权，因此这直接暴露了整卷内的文件。移除卷根后，本次可测的外部读取、穿越和 junction 探测均被拒绝；但 symlink 未能创建，不能把文件系统能力提升为 `verified`。[API](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox) · [AppContainer 隔离](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) |
| Restricted Token | 可禁用 SID、删除特权，并在访问检查中添加 restricting SID。 | 是有用的最小权限组成部分，但它本身不定义文件路径白名单，也不限制网络出口；仍需正确设计 ACL 和独立网络控制。本 PoC 未测试此方案。[CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken) |
| Windows ACL / DACL | 对文件、目录等对象实施逐对象允许/拒绝规则。 | 能表达资源授权，但独立 ACL 方案需安全覆盖全部运行时依赖、子进程、继承权限、reparse point 和并发路径替换。本 PoC 使用 AppContainer API 的路径授权，没有改写宿主 ACL。[访问控制列表](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-control-lists) |
| Job Object | 将一组进程作为整体管理，施加部分资源/进程限制并终止关联进程；关闭句柄时的 kill-on-close 可作为清理后备。 | 本 PoC 只用它管理进程生命周期。Job Object 不提供文件或网络隔离。[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) |

## Windows 实测结果

| 探测项 | 结果 | 证据与限制 |
| --- | --- | --- |
| 工作区读取和写入 | 通过 | PowerShell 与 Node 能读取工作区文件并在生成的工作区内创建文件。 |
| 首轮卷根只读授权 | **失败，已移除** | 首轮把运行时所在的 `C:\`、`D:\` 卷根作为 `fs_read_only` 路径；当时 AppContainer 能读取相邻目录哨兵、当前用户 `.gitconfig` 和 PowerShell 历史，也能经 `..` 与 junction 读取工作区外文件。探测仅记录读是否成功，不把文件内容复制到报告。 |
| 窄授权后的工作区外与敏感文件读取 | 本次探测拒绝 | 移除卷根授权、只保留 Node/Git/PowerShell/Windows System32 等精确运行时目录后，PowerShell 与 Node 均不能读取相邻目录哨兵、当前用户 `.gitconfig` 或 PowerShell 历史。 |
| 窄授权后的工作区外写入 | 通过 | 向配置的可写工作区外写入被拒绝。 |
| 窄授权后的路径穿越 | 本次探测拒绝 | 使用 `..` 的路径未能读取工作区外哨兵。 |
| 窄授权后的目录 junction | 本次探测拒绝 | 实际创建 junction 指向工作区外目录，但不能通过它读取目标文件。 |
| 文件符号链接 | 不可用 | 因宿主权限不足，创建 symlink fixture 失败（`mklink file symlink exit=1`），未能验证这种链接。 |
| 受保护 LS 源码写入 | 通过 | 进程无法以写入方式打开 `packages/tools/src/builtin/exec.ts`。这只覆盖本机的这个目标，不证明所有受保护根和替换手法都安全。 |
| 工作区目录替换 | 本次竞态测试通过 | helper 持有一个不共享删除权限的目录句柄时，重命名/替换被阻止。这只证明该技术在测试时段的效果，不涵盖所有 reparse point 或命名空间竞态。 |
| 网络：loopback | 对本次目标通过 | 宿主 loopback listener 的控制探测成功；沙箱内 PowerShell 与 Node 的 TCP 连接被拒绝。 |
| 网络：外网 | 无法判定 | 沙箱 PowerShell 和 Node 连接 `1.1.1.1:443` 失败，但宿主对同一地址的基线也超时。宿主没能证明目标可达，因此不能据此确认外网出口被隔离。 |
| PowerShell → Node 子进程 | 部分通过 | PowerShell 成功启动 Node；窄授权下 Node 与 PowerShell 对工作区外读取、写入、穿越和 loopback 的探测结果一致。整体能力仍为 `partial`，因为 Git 基础仓库命令失败。 |
| Git | **部分兼容** | `git --version` 成功。窄授权下，分别把 Git 安装根目录和工作区设为当前目录执行 `git init` / `git status`，都以 128 退出，并报告 `unable to get current working directory: Permission denied`。首轮卷根授权时这两个命令通过，但该授权范围不安全，不能作为可接受兼容性方案。 |
| 超时和宿主取消 | 本次进程树测试通过 | 两种场景都先启动了 Node 后代进程。Job Object 超时处理和 worker 取消均已完成；之后再次检查记录的子进程 PID，均已不存在。此结果不证明断电、内核故障、恶意逃离机制或所有外部 Job 嵌套场景的清理。 |
| 无效沙箱规范 | fail-closed 测试通过 | 无效规范以退出码 70 拒绝执行，payload 未启动，且记录 `noHostFallback`。这只是 PoC 测试，不能代替生产回退路径审计。 |

报告不包含敏感宿主文件内容。完整本机 JSON 报告保留在上面的临时 fixture 目录。

## 能力快照

| 能力 | 状态 | 原因 |
| --- | --- | --- |
| `native-file-read-confinement` | `unavailable` | 本 PoC 测试 Shell 进程，不测试原生 LS 文件工具。 |
| `native-file-write-confinement` | `unavailable` | 本 PoC 测试 Shell 进程，不测试原生 LS 文件工具。 |
| `process-filesystem-confinement` | `partial` | 窄授权下本次工作区外读取、写入、路径穿越、junction、敏感文件和受保护源码写入探测均符合预期；symlink 无法创建，未测试，因此整体仍是 `partial`。首轮卷根授权泄漏已从实现中移除。 |
| `process-network-confinement` | `partial` | loopback 被拦截，但宿主外网正向基线不可用。 |
| `child-process-containment` | `partial` | Node 继承了本次验证的 AppContainer 文件和网络限制，但 Git 仓库命令因当前工作目录访问错误未通过。 |
| `process-tree-termination` | `verified`（仅本次超时/取消用例） | 两个测试用例中的跟踪子进程清理后均不存在。结论只适用于本次主机、系统版本和测试场景。 |

Shell readiness 因文件系统隔离、网络隔离和子进程约束未验证而返回 `capability_unverified`。readiness 结果不是权限，也不会授予自动执行。

## PowerShell、Node、Git 兼容性与部署代价

- 本机版本：Windows PowerShell `5.1.26100.9444`、Node.js `v26.4.0`、Git `2.50.1.windows.1`。
- 禁用 `disallow_win32k_system_calls` 后，PowerShell 和 Node payload 能启动。启用该缓解选项曾阻断 CLI 初始化；因此 PoC 保持禁用。该结果是兼容性观察，不是安全建议。
- `git --version` 成功，但在不授予卷根读取权限时，`git init` / `git status` 均因无法解析当前工作目录而失败。给卷根授权虽可让命令通过，却会递归放开不应访问的目录，不能采用。其他 Git 工作流、hooks、credential helper、submodule、LFS、远程网络和任意仓库内容也未验证。
- launcher helper 是 C# P/Invoke 源码，由 Windows PowerShell `Add-Type` 在运行时编译；PoC 没有加入预编译原生可执行文件。正式部署前需定义稳定且受支持的 launcher 协议、CPU 架构和系统版本范围。如果采用编译 helper，还需要签名、分发和更新策略，并覆盖实际支持的 PowerShell/.NET 与 Node/Git 发行版。
- spec builder 为编码文档化的 `SBOX` FlatBuffer schema 子集而新增 `flatbuffers` 开发依赖。Windows API 需要动态查找实验性的 `processmodel.dll` export；Microsoft 文档说明 schema 当前为 `0.1.0`、API 仍是实验性且没有公开头文件，因此不能假设它是稳定的生产 ABI。
- 运行时根目录、环境变量、用户 profile、模块、Git 配置、可执行文件搜索路径和临时目录仍需逐项完成最小权限设计。PoC 的环境变量整理只是兼容性 fixture，不能修复已经观察到的文件读取泄漏。

## P3-B 正式集成前置条件

在下列条件都获得宿主侧证据之前，不要连接生产 `exec` 路径。每个受支持的 Windows 版本和系统构建都需单独验证：

1. 保持精确运行时目录授权，不能再把卷根加入白名单；确认窄授权方案可覆盖必要的合法运行时读取。重新测试相邻路径、用户 profile 敏感文件、凭据、注册表数据和所有受保护根，并拒绝 traversal、junction、symlink 及其他 reparse point。
2. 在实际执行约束内测试路径替换与 reparse point 竞态，而非只做 helper 预检。验证别名、硬链接、替代路径和进程替换不能修改受保护文件。
3. 通过具备宿主正向连通基线的测试，证明 PowerShell 及其后代无法访问外网与本地网络；覆盖后端相关的 DNS、IPv4/IPv6、重定向/代理和其他网络通道。
4. 验证后代不能逃离进程约束，并证明超时、用户取消、worker 崩溃、API 错误、Job 嵌套和宿主异常关机时都能清理。保留当前 durable 副作用结算及取消语义。
5. 使用实际打包的运行时和代表性子进程测试 PowerShell、Node、Git。解决 Git 在窄授权下读取当前目录失败的问题时不得扩大到卷根授权。任何不支持的命令或缺失能力都必须拒绝执行，不能回退到宿主 Shell。
6. 由 Main 后端产生绑定规范工作区和 run 的新鲜证据。保持 readiness 与 Permission V2 决策分离；Renderer、模型、插件和工具参数均不能提交能力声明。
7. 完成安全评审、原生 helper 的签名/分发计划、Windows 版本支持决策及可重复的 Windows CI 或硬件测试覆盖。

完成这些门槛前，P3-A 只能作为实验诊断工具：Shell 保持逐次审批；`workspace-write` 不代表 Shell 可自动执行；P2 文件守卫不能替代操作系统进程隔离。
