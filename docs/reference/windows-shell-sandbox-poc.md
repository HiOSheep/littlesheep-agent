# Windows Shell Sandbox PoC（P3-A / P3-A2 / P3-A3 / P3-A4）

## 结论

这是仅供实验的 Windows launcher，没有接入 `exec`、Main 权限策略、`ToolExecutionService` 或自动审批路径。P3-A2/P3-A3 在真实 NTFS 硬链接上复现了工作区外修改；P3-A4 又证明了句柄相对遍历和从固定文件句柄物化硬链接内容的可行性，也发现运行期同用户进程仍能改写快照文件。Windows Shell 隔离未通过安全验收，不进入 P3-B。

实验基于 `main` 的 P3-0 提交 `55d9e0a80e37542933fdee0cab88c74ceabcead7`。最终 P3-A2 实测主机为 Windows 11 Home China、Build 26200、x64；PowerShell `5.1.26100.9444`、Node.js `v26.4.0`、Git `2.50.1.windows.1`。报告生成于 `2026-10-12T03:05:33Z`，runId 为 `5989b2e9886649c099d8bdba1542500b`，本机完整报告保留在 `%LOCALAPPDATA%\Temp\ls-windows-sandbox-poc-3ae33f971b0d4d2faee5ea8407ead84f`。这是本机实验记录，不是入库测试产物。

报告通过 `SandboxCapabilitySnapshot` 和 `assessSandboxReadiness` 表达结果。Shell readiness 为 `ready: false`，原因是文件系统、网络和子进程能力未验证；`readinessIsAuthorization` 为 `false`。没有用放宽 readiness 门槛来把实验结果转成执行授权。

## P3-A 首轮记录（保留）

P3-A 的首轮卷根授权报告保留在 `%LOCALAPPDATA%\Temp\ls-windows-sandbox-poc-fea0b8613f4743c0beac23ad1fec08ba`；移除卷根后的报告保留在 `%LOCALAPPDATA%\Temp\ls-windows-sandbox-poc-8b813cb181eb4fa5b3acbad29a0885d8`。首轮把 `C:\` 和 `D:\` 加入只读授权后，沙箱能读取相邻目录哨兵、当前用户 `.gitconfig` 和 PowerShell 历史，也能经 `..` 与 junction 读取工作区外文件。该授权随后已从 PoC 中移除，不能作为候选配置。

P3-A 窄授权轮次中，PowerShell/Node 对已测的外部路径、穿越、junction 和受保护源码写入表现符合预期，但文件 symlink 因当时的宿主创建方式失败，未获得测试证据。其外网测试使用 `1.1.1.1:443`，宿主同样无法建立连接，所以外网隔离当时不可判定。P3-A 还记录 `disallow_win32k_system_calls` 会阻断 CLI 初始化，因此 PoC 未启用该缓解选项；这只是兼容性观察，不是安全建议。P3-A2 的后续源码审计发现，它的 `CreateSymbolicLinkW` P/Invoke 把 Win32 `BOOLEAN` 返回值按 4 字节 `BOOL` 解读，且未确认链接路径存在，因此旧报告中的文件 symlink 拒绝结果撤回。P3-A4 修正返回类型后，本机文件 symlink 创建仍以错误 1314 失败，无法补做该负向沙箱测试。

## P3-A2 实测发现

| 探测项 | 结果 | 证据与限制 |
| --- | --- | --- |
| 工作区普通读取和写入 | 通过 | PowerShell 和 Node 均能在授权工作区读取及创建文件。 |
| 越界读取/写入、`..` 穿越 | 本次拒绝 | PowerShell 和 Node 对工作区外哨兵的读取、写入与路径穿越均被拒绝。 |
| 静态 junction | 本次拒绝 | junction 实际创建成功，PowerShell 和 Node 通过 junction 读取外部哨兵均被拒绝。 |
| 文件 symlink | **未验证；旧结果撤回** | 旧 P3-A2 测试对 `CreateSymbolicLinkW` 的 `BOOLEAN` 返回值使用了 4 字节 `BOOL` 封送，且没有确认链接路径存在。修正为 1 字节 `BOOLEAN` 并检查路径后，P3-A4 在本机得到 Win32 错误 1314，未创建 symlink；因此不能声称 AppContainer 拒绝了该 symlink 目标。 |
| 硬链接 | **隔离失败，已复现越界读写** | 宿主在授权工作区内为工作区外哨兵创建同卷硬链接。AppContainer 下 PowerShell 和 Node 都能通过该别名读取并覆盖外部文件；报告中 `hardLinkReadDenied=false`、`hardLinkWriteDenied=false`、`hardLinkTargetUnchanged=false`。测试确认外部哨兵实际被改写。这是阻断 Shell 隔离验收的真实安全风险。 |
| 工作区子目录替换竞态 | 本次目标未越界 | 沙箱 reader 启动后，宿主将其工作区内目标目录移走并放入指向外部目录的 junction。替换成功，但 reader 未读到外部哨兵，外部目标未变化。该单一竞态用例不能覆盖所有 reparse point、文件系统或时序。 |
| 工作区根目录替换 | 本次被阻止 | launcher 固定工作区目录句柄后，宿主无法重命名该根目录。它与“子目录被替换后仍拒绝访问”的测试是不同场景。 |
| 受保护 LS 源码 | 本次写打开被拒绝 | 只覆盖本机 `packages/tools/src/builtin/exec.ts` 目标，不证明全部受保护根和文件替换方式。 |
| 网络：宿主正向基线 | DNS、域名 IPv4、loopback、系统代理均可达 | 宿主可以解析并直连 `www.microsoft.com:443` 和所解析的 IPv4；PowerShell 与 Node 也都能通过当前系统代理完成 HTTPS HEAD。代理地址不写入报告。 |
| 网络：沙箱负向结果 | IPv4、DNS、loopback、系统代理连接被拒 | PowerShell 与 Node 的域名/IPv4 直连、DNS、loopback 和已配置系统代理 HTTPS 均失败，失败类型为访问拒绝或解析失败。它们是本机和本次路由上的证据。 |
| 网络：IPv6 | **不可判定** | 宿主直连固定 IPv6 目标 `[2606:4700:4700::1111]:443` 返回 `NetworkUnreachable`，没有宿主正向基线。沙箱 PowerShell 和 Node 都返回网络不可达类结果；这不能证明是隔离策略拒绝，任意 IPv6 出口仍未验证。 |
| PowerShell → Node 子进程 | 部分通过 | PowerShell 成功启动 Node；在已测的网络与常规路径探针上，Node 表现为继承同类约束。但硬链接测试失败，且 Git 仓库命令失败，不能得出通用子进程约束已验证。 |
| Git 窄授权兼容 | **未通过** | `git --version` 成功，宿主预置的有效仓库 fixture 也存在。AppContainer 下 `git init` 和 `git status` 仍以 128 退出。Git Trace2 记录 `unable to get current working directory: Permission denied`、`Unable to read current working directory: Permission denied`；其他 CWD 组合还出现目标目录 `mkdir` 被拒。仅向只含 workspace 的 `workspace-scope` 父目录增加只读授权，未修复问题。 |
| Git CWD 诊断 | 有线索，根因未完全证明 | 独立 Node 探针的 `process.cwd()` 能返回授权 workspace；但 `realpathSync` 在 workspace 和已授权父目录也返回 `EPERM`，更上层目录的元数据/枚举被拒。Git 上游源码中的 `strbuf_getcwd` 调用 `getcwd`，与本机 Trace2 错误相符；这只是源码路径说明，不是对本机 Git 2.50.1 的内核调用追踪。[Git `strbuf_getcwd`](https://github.com/git/git/blob/master/strbuf.c) 没有 Procmon/内核访问跟踪，不能断言某一个具体拒绝的系统调用就是唯一根因。没有授权 `%TEMP%`、用户目录或卷根来追求 Git 通过。 |
| 超时和宿主取消 | 本次进程树用例通过 | 两种测试均观察到 Node 后代启动；超时终止和强制终止 launcher worker 后，记录的进程树已清理。快照保留 `process-tree-termination: verified`，但证据仅覆盖本机这两个具体场景，不代表崩溃、断电、Job 嵌套或所有逃逸方式。 |
| 初始化失败 | fail-closed 用例通过 | 无效沙箱规范被拒，payload 未启动；没有静默回退到宿主 PowerShell。这是 PoC 局部行为，不替代生产路径审计。 |

本轮曾因独立 CWD 探针脚本未运行而拿到无效诊断，也发现目录竞态脚本的生成文本可能失效。现在两个探针在启动前做语法校验；以上结论来自之后生成的真实 Windows 报告。

## 能力快照

| 能力 | 状态 | 本轮理由 |
| --- | --- | --- |
| `native-file-read-confinement` | `unavailable` | 本 PoC 测试进程 Shell，不测试 LS 原生文件工具。 |
| `native-file-write-confinement` | `unavailable` | 本 PoC 测试进程 Shell，不测试 LS 原生文件工具。 |
| `process-filesystem-confinement` | `partial` | 普通路径、静态链接和本次目录替换探针表现符合预期，但硬链接可越界读写。 |
| `process-network-confinement` | `partial` | 已有 IPv4/DNS/loopback/代理正反向证据；缺少宿主可达的 IPv6 正向基线。 |
| `child-process-containment` | `partial` | Node 在受测条件下继承约束；Git 的 CWD 和仓库命令仍失败，且文件系统约束本身存在硬链接越界。 |
| `process-tree-termination` | `verified`（限具体测试场景） | 仅本机本轮超时和 launcher worker 强制终止测试中的已跟踪 Node 后代。 |

能力快照只总结本机实验探针。它不是权限来源，也不启用 Shell 自动审批。

## P3-A3 临时快照实验

本轮从本地 `main` 的 P3-A2 基线 `5cffabe4` 开始。实验脚本：`scripts/windows-sandbox-poc/Invoke-WindowsSnapshotSandboxPoc.ps1`。结果报告生成于 `2026-10-12T03:46:23Z`，runId 为 `9275fd2fb79e4fb7a8a45d10de91b59b`，本机完整报告保留在 `%LOCALAPPDATA%\Temp\ls-windows-snapshot-poc-55730a183b844bb8b0edb210b2638eb8`。该证据由 Windows 11 Home China Build 26200、PowerShell `5.1.26100.9444`、Node.js `v26.4.0`、Git `2.50.1.windows.1` 生成；仅用于 PoC，没有进入 `exec` 或 Main 权限策略。

| 探测项 | 结果 | 证据与限制 |
| --- | --- | --- |
| 直接授权目录内的硬链接 | **越界修改复现** | 在临时 fixture 中，工作区别名与外部哨兵具有相同卷序列号/文件 ID，链接数为 2。现有实验 launcher 下 PowerShell 通过别名把哨兵改为 `modified-through-direct-workspace-hardlink`。这重现了 P3-A2 的对象别名问题。 |
| 快照硬链接预检 | 本次拒绝 | `GetFileInformationByHandle` 返回链接数大于 1 时，在创建快照目标之前拒绝整棵源树；测试未复制别名内容，目标路径未创建。预检与复制之间仍有竞态，不能作为生产安全保证。 |
| 快照 reparse point 预检 | 本次拒绝 | 真实创建 junction 后，快照构建器识别 `FILE_ATTRIBUTE_REPARSE_POINT` 并拒绝，未创建目标目录。只覆盖这一个静态 junction fixture；并未覆盖所有 reparse tag 和并发替换。 |
| 普通文件对象复制 | 本次分离 | SHA-256 内容匹配；复制后源文件与快照文件的卷/文件 ID 不同，二者链接数均为 1。暂存目录通过同父目录改名提升为快照。PowerShell 沙箱进程与其 Node `-e` 子进程能修改副本；测试源文件和外部哨兵内容保持不变。未验证掉电持久性或完整回滚语义。 |
| Node 文件入口 | 失败 | `node <snapshot>\write-child.mjs` 在 Node 解析入口路径时，对 `C:\` 的 `lstat` 返回 `EPERM`。Node `-e` 可以运行并写入快照。当前窄权限因此只证明了 `-e` 形态，不能宣称 Node 项目脚本兼容。 |
| Git `init` | 失败 | Git Trace2 记录 `unable to get current working directory: Permission denied`，退出码 128，未创建仓库。失败发生在目标目录写入前。 |
| Git 文件访问追踪 | 不可用 | 主机没有 Procmon。系统内置 WPR 能列出 `FileIO` profile，但当前非提升会话启动 `wpr -start FileIO -filemode` 返回 `0x80070005 ACCESS_DENIED`。没有内核文件访问事件证据，不能把 Trace2 错误等同于具体被拒的 Win32/NT 调用。 |
| IPv6 网络 | 不可判定 | 本机没有 IPv6 默认路由，固定 IPv6 目标没有宿主正向可达基线；本轮未测试沙箱 IPv6 egress。 |
| 并发修改快照、进程生命周期 | 未测试 | 本轮未覆盖宿主在沙箱运行中替换快照子目录、进程异常退出、逃逸或完整进程树清理。 |

实验的 `SandboxCapabilitySnapshot` 使用 P3-0 的结构，并通过现有 `assessSandboxReadiness()` 评估：文件系统 `partial`、网络 `unavailable`、子进程 `partial`、进程树终止 `unavailable`；Shell readiness 为 `false`，没有任何能力被标记为 `verified`。Ready 结果不作为授权输入。

### 文件对象隔离路线判断

NTFS 硬链接是同一文件对象的多个目录项；微软 API 返回的 `BY_HANDLE_FILE_INFORMATION.nNumberOfLinks` 和文件 ID 可用于本机预检，但路径检查本身不是完整隔离。直接授权工作区中的文件对象后，硬链接别名仍指向该对象。更换进程启动 API 不会自动创建新文件对象，因此 `CreateProcessW + STARTUPINFOEX + SECURITY_CAPABILITIES` 的稳定性优势不能解决这个文件系统边界问题。[硬链接与 junction 语义](https://learn.microsoft.com/en-us/windows/win32/fileio/file-and-directory-linking) · [`BY_HANDLE_FILE_INFORMATION`](https://learn.microsoft.com/en-us/windows/desktop/api/fileapi/ns-fileapi-by_handle_file_information)。

文档化 AppContainer 启动路线仍是长期 API 候选：使用 `InitializeProcThreadAttributeList` / `UpdateProcThreadAttribute` 配置 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`，再调用 `CreateProcessW`。它比 `Experimental_CreateProcessInSandbox` 的 ABI 稳定，但授权的目录/文件仍需 DACL 配置，且更换 launcher 不会修复共享文件对象别名、Git 的 CWD 解析或本轮 Node 入口失败。[Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) · [`UpdateProcThreadAttribute`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。本轮没有重写 launcher，因为先要解决快照输入边界。

P3-A3 只对普通文件做路径预检后复制；P3-A4 在受限 NTFS fixture 上补测了句柄相对遍历、固定源文件句柄、命名流拒绝、目录替换和快照期间宿主改动。这些仍是实验工具：没有可抵御同用户宿主进程的快照完整性、硬链接读取授权规则、真实全项目快照、Git/Node 脚本兼容或完整变更回放。

## P3-A4 句柄固定快照实验

实验入口：`pnpm run poc:windows-snapshot-a4`，实现位于 `scripts/windows-sandbox-poc/Invoke-WindowsSnapshotHandlePoc.ps1` 与 `SnapshotHandleNative.cs`。本机报告生成于 `2026-10-12T05:00:09Z`，runId 为 `bce3de2221be4ba9842fa902ab2ea6c4`，证据目录为 `%LOCALAPPDATA%\Temp\ls-windows-handle-snapshot-poc-82c4cdfbd8094c51aeba62ffa0c90632`。运行环境是 Windows 11 Home China Build 26200、Windows PowerShell `5.1.26100.9444`、Node.js `v26.4.0`、Git `2.50.1.windows.1`。该轮没有改动正式 `exec`、Runner、Harness 或 `ToolExecutionService`。

威胁模型以恶意 Agent 命令为对象，并信任 Main、操作系统和快照构建器。另用独立同用户进程探测快照竞争；结果不支持把同用户宿主进程纳入隔离保证。

构建器只接受固定本地 NTFS 卷。它从卷根目录句柄逐级打开源路径，使用文档化的用户态 `NtCreateFile` `RootDirectory` 相对打开单个子项，并以 `FILE_OPEN_REPARSE_POINT` 检查而不跟随叶 reparse point；目录和流信息通过现有文件句柄查询。每个目录枚举项携带 FileId，打开名称后会与同一父句柄枚举到的 ID 比对；替换成不同对象时停止并清理暂存目录。文件数据从保留的源句柄读取，在新建目标文件对象时直接散列，复制后重新计算 SHA-256，并验证源与目标文件 ID 不同、目标链接数为 1。所有文件先写入同父暂存目录，最后通过同卷目录改名提升。句柄相对打开和返回数据结构依据 [NtCreateFile 的 Win32 用户态文档](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex) 与 [FILE_STREAM_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_stream_info)。本轮仅在一台 Windows 11 主机验证，没有覆盖 Windows 版本兼容矩阵。

| 探测项 | 结果 | 证据与限制 |
| --- | --- | --- |
| pnpm 形态 hardlink 物化 | 本次通过 | 临时项目含 `.git`、`node_modules/.pnpm` 和指向项目外 content-store 文件的硬链接。5 个文件、173 字节在 102 ms 内复制到新文件对象；源链接计数为 2，目标 ID 不同且链接数为 1。修改快照副本后 store 文件内容保持不变。该 fixture 是手工构造的布局，不是运行 `pnpm install` 生成的项目。 |
| 枚举后替换普通文件 | 本次拒绝替换对象 | 独立宿主进程在目录枚举后、相对打开前把文件名换成指向外部哨兵的硬链接。构建器比对目录项 FileId 与打开句柄 FileId，检测到不一致后拒绝提升，清理暂存目录；外部哨兵未变化，也没有被复制。 |
| 检查后替换源子目录 | 本次通过 | 独立宿主进程在构建器已打开 `nested` 目录句柄后，把路径改名并放入指向外部哨兵目录的 junction。构建器仍通过原目录句柄复制原文件；输出中没有外部哨兵。只覆盖此 NTFS/时序用例。 |
| 运行期间替换快照根 | 本次被阻止 | launcher 固定根目录句柄后，同用户宿主进程的根目录改名失败。 |
| 运行期间替换快照子目录 | 沙箱外目标拒绝；快照完整性未保护 | 独立宿主进程成功移走快照子目录并放入外部 junction。被测 AppContainer PowerShell 对 junction 外哨兵的读取和写入均得到 `UnauthorizedAccessException`，哨兵内容未变。但宿主也成功原子替换快照根下的普通文件，payload 随后读取到了宿主写入的新内容。快照 DACL 不是抵御同用户进程的安全边界。 |
| NTFS 替代数据流 | 本次拒绝 | 通过文件句柄查询发现新增命名流；严格复制拒绝提升快照。 |
| junction / reparse point | junction 本次拒绝 | 创建出的 junction 标签为 `0xA0000003`，构建器没有跟随它，拒绝提升快照。未知 reparse tag 没有逐类创建；实现对所有带 `FILE_ATTRIBUTE_REPARSE_POINT` 的条目默认拒绝。 |
| 文件 symlink | 未验证 | 修正 `CreateSymbolicLinkW` 返回类型后，真实 Windows PowerShell 5.1 探针得到错误 1314，文件链接未创建；因此没有针对这个 fixture 的 symlink 隔离结论。当前仓库 census 另发现 20 个 `IO_REPARSE_TAG_SYMLINK`，并确认句柄 census 能识别其 tag，但没有对每个目标运行 shell 访问探针。微软文档规定该 API 返回 1 字节 `BOOLEAN`，且未提升进程使用 unprivileged flag 需要 Developer Mode。[CreateSymbolicLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw) |
| 真实 LS 项目兼容性 | 有明显代价 | 对当前仓库及实际 `node_modules` 做 23.1 秒句柄 census：118,197 个子项、92,051 个文件、24,163 个目录；33,463 个文件路径的链接数大于 1，1,983 个 reparse point，未发现命名流。其中 1,963 个是 `IO_REPARSE_TAG_MOUNT_POINT`（junction），20 个是 `IO_REPARSE_TAG_SYMLINK`。pnpm 文档说明 `node_modules` 文件会从内容寻址 store 建立硬链接。[pnpm 的 store 与硬链接](https://pnpm.io/motivation) |
| 全项目快照 | 未执行 | 估算需要复制 6,007,247,318 字节逻辑数据；源文件分配量合计 6,153,011,104 字节。由于需要复制约 5.6 GiB 且项目含大量 reparse point，没有对 6 GB 项目执行整树复制。全树复制耗时未测。 |

硬链接物化只证明目标文件对象独立，**不证明读取授权正确**：若工作区内 hardlink 指向 workspace 外的秘密文件，构建器仍会从该链接句柄读出内容并复制到快照；PnPM store 文件也是 workspace 外对象。P3-A4 没有制定“依赖内容可读”与“任意外部硬链接目标不可读”之间的产品授权规则，也没有枚举每个对象的全部外部别名。因此，不能据此允许含任意 hardlink 的用户项目自动进入 Shell。

兼容性和安全证据仍不足以进入 P3-B：现有仓库有大量 pnpm junction，当前策略会拒绝这些条目；若复制并物化 hardlink，还需确定其源内容授权和链接关系变化语义。即便 shell payload 在单次外部 junction 测试中被拒绝，同用户宿主仍可改写快照输入。Git 仓库命令、Node 文件入口、网络隔离、变更回传、崩溃清理和跨版本行为也未验证。P3-A4 的能力快照保持文件系统 `partial`、子进程 `partial`、网络与进程树终止 `unavailable`，Shell readiness 为 `false`，没有能力被标为 `verified`。

## Windows 后端路线比较

| 路线 | 支持与可行性 | 主要代价和未解决项 |
| --- | --- | --- |
| AppContainer + `CreateProcessW` / `STARTUPINFOEX` | 微软文档化的 Win32 启动路径：建立 AppContainer profile 与 `SECURITY_CAPABILITIES`，将其通过 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 交给 `CreateProcessW`。该属性文档标为 Windows 8 / Server 2012 起支持，属于比当前实验 export 更稳定的 API 候选。[启动 AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) · [`UpdateProcThreadAttribute`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) · [`CreateProcessW`](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-createprocessw) · [AppContainer 文件和网络边界](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) | 仍需实现能力 SID、profile 清理、最小 DACL、运行时读取、启动属性列表和 Job Object 生命周期，并在目标 Windows 版本实测。稳定的启动 API 不会自动解决硬链接别名、Git 祖先路径解析、reparse point 或网络正向验收；不得把它视作已验证替代品。 |
| 当前 `Experimental_CreateProcessInSandbox` | P3-A 的最小实验入口，在本机能启动 PowerShell 和 Node；Windows 文档将 API 标记为 experimental、subject to change，并规定当前 schema 版本 `0.1.0`。[API 与 schema](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox) | 依赖动态 export 和实验性 ABI；不能作为普通用户长期分发的默认基础。当前实测已经发现硬链接越界，Git 也未在窄授权下兼容。 |
| Windows Sandbox | Hypervisor 提供独立内核，是更强 VM 边界候选；可在 `.wsb` 配置中关闭网络并映射只读目录。[概览](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/) · [配置](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file) | 当前实测主机为 Windows Home，不支持该功能；每台机器同一时间只能运行一个实例。网络默认开启；可写映射的更改会留在宿主。若用于产品还需验证冷启动、并发/排队、运行时供给、RPC/结果回传与 workspace 挂载边界。 |
| Windows Container + Hyper-V isolation | Windows 11 Pro/Enterprise 可用，需启用 Hyper-V 角色。[系统要求](https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/system-requirements) | 当前 Windows Home 主机不能实测。需要维护容器镜像和运行时。官方网络文档说明容器默认出站允许，即使 Hyper-V isolation 也不能假设默认阻网，仍要制定和测试网络规则。[网络隔离与安全](https://learn.microsoft.com/en-us/virtualization/windowscontainers/container-networking/network-isolation-security) |
| Restricted Token、ACL、Job Object | 可作为纵深防御组件。Job Object 可约束并结束进程组；ACL/DACL 可限制具体对象访问。[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) · [ACL](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-control-lists) | 单独不构成完整文件系统与网络隔离，也不自动处理 workspace 绑定、链接别名、网络 egress 和父子进程生命周期。P3-A2 未实测 Restricted Token 替代后端。 |

下一轮优先完成工作区快照边界验证：固定并遍历源目录句柄、消除检查后重开路径的竞态、拒绝硬链接/reparse/special stream，并测试运行中同用户进程替换快照。只有文件对象隔离方案先通过哨兵测试后，才值得做文档化 AppContainer API 的最小 launcher 实验。Git CWD 仍需在可提升的 Windows 环境中通过 WPR/Procmon 追踪具体访问失败；IPv6 需要宿主可达的测试网络。路线比较再纳入 Windows Sandbox/Hyper-V isolation 的版本、并发、冷启动、磁盘开销和回传成本。

## P3-B 前置门槛

1. 解决硬链接别名读取和写入越界，并用真实外部文件哨兵证明所有支持的工作区存储布局都无法越界；不允许靠卷根或用户临时目录授权掩盖问题。
2. 明确 hardlink 的读取授权：证明允许 pnpm store 等 workspace 外依赖内容进入沙箱，同时阻止任意 workspace hardlink 把外部秘密复制进快照；仅检查目标 FileId 与复制后对象分离不足以通过。
3. 以最小、可审计的目录遍历权限修复 Git 的 `getcwd` / CWD 解析，并证明不会暴露父目录同级内容；若无法做到，明确拒绝该类工作流，不扩大授权。
4. 在宿主可达的受控 IPv4 和 IPv6 目标上分别验证宿主成功、PowerShell/Node 及其子进程被阻断；覆盖 DNS、系统代理和本地网络路径。
5. 在候选的正式 API 后端本身重跑绝对/相对路径、symlink、junction、其他 reparse point、硬链接、目录替换、进程逃逸及超时/取消测试，并覆盖具体支持 Windows 构建。
6. 明确 PowerShell、Node、Git 的支持版本、运行时读取范围、容器或 helper 的部署与更新策略；故障时只能拒绝执行，不能退回宿主 Shell。
7. 明确同用户恶意宿主进程是否在防御范围内；若在范围内，当前用户可修改的快照不足以形成隔离边界，须使用独立安全主体或 VM 并重新实测。
8. 所有成功证据由可信 Main/宿主后端针对本次工作区和 run 生成。权限审批、能力证据和隔离实施继续分离；不能改变 Runner durable 恢复或副作用结算。

完成以上门槛之前，Shell 保持逐次审批；`workspace-write` 不代表 Shell 可以自动执行。P2 文件工具约束也不替代操作系统进程隔离。
