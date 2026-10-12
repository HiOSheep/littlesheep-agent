# Windows Shell 沙箱 PoC

此目录包含仅用于实验的 launcher，调用 Microsoft 实验性 `Experimental_CreateProcessInSandbox` API。它没有接入 `exec`、`ToolExecutionService`、Main 权限策略、Runner 生命周期或任何生产自动审批路径。

## 在 Windows 上运行

从仓库根目录运行：

```powershell
pnpm run poc:windows-sandbox
```

测试会在当前用户 `%TEMP%` 下创建临时 fixture，只通过 `processmodel.dll` 启动 payload，在该目录写入 JSON 报告，并清理测试用 AppContainer profile。如果 API、规范、工作区 pin、Job Object 分配或沙箱启动失败，runner 会拒绝执行，不会回退到宿主 Shell。

主机需要 Windows PowerShell 5.1、Node.js、Git 和仓库已安装的 Node 依赖。只读根包括发现的 PowerShell、Node、Git、Windows runtime、可选共享 PowerShell module，以及只包含本次工作区的专用父目录。只有生成的工作区配置为可读写；构建器拒绝卷根授权。网络探针先记录宿主 DNS、域名、IPv4、IPv6、loopback 和系统代理的正向基线，再判断沙箱结果。

## 探针与当前结果

探针覆盖工作区读写、越界读取与写入、路径穿越、junction、文件 symlink、硬链接读写、运行中替换工作区子目录、LS 受保护源码写入、PowerShell 到 Node 的限制继承、Git `version/init/status`、当前目录元数据与规范化、PowerShell 和 Node 的网络访问、Job Object 超时/取消清理、工作区根替换，以及无效规范的 fail-closed 行为。生成的 PowerShell 探针会在启动前做语法校验。

最新 Windows 实测报告见[结果与限制](../../docs/reference/windows-shell-sandbox-poc.md)。PowerShell 和 Node 能通过硬链接读取并覆盖工作区外目标，所以文件系统隔离为 `partial`。窄授权下 Git 仓库命令失败；宿主 IPv6 不可达，IPv6 隔离没有验证。Shell readiness 保持 `false`。

## P3-A3 临时快照实验

在 Windows PowerShell 5.1 上运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-sandbox-poc/Invoke-WindowsSnapshotSandboxPoc.ps1
```

该实验只在当前用户 `%TEMP%` 下创建哨兵、硬链接、junction 和短期工作区副本。它会复现直接授权时的硬链接越界，拒绝含多链接文件或 reparse point 的快照输入，将无链接的普通文件复制成新文件对象，再通过现有实验性 launcher 运行 PowerShell、Node `-e` 与 Git 探针。报告附带 `SandboxCapabilitySnapshot` 和 `assessSandboxReadiness()` 结果；不连接生产执行路径，也不产生自动 Shell 授权。

本实验的快照构建只用于验证文件对象分离。路径预检与复制之间仍有竞态，未覆盖 NTFS 命名流、稀疏/EFS 文件、全量目录替换或同用户其他进程改写快照；不能作为生产快照器或隔离证明。

能力评估的回归测试：

```powershell
pnpm exec vitest run scripts/windows-sandbox-poc/build-sandbox-spec.test.mjs scripts/windows-sandbox-poc/evaluate-report.test.mjs
```

## 实现说明

- `SandboxProcessApi.cs` 从 System32 动态查找 OS export，整理子进程环境，固定工作区目录句柄（不共享删除权限），先挂起创建进程，将其分配到启用 kill-on-close 的 Job Object，再恢复执行。
- `BaseContainerSpecification.fbs` 记录 FlatBuffers builder 编码的字段顺序子集，绑定当前公开的实验 schema `0.1.0`，不是稳定 Windows SDK header。
- `flatbuffers` 是只用于编码文档化 `SBOX` buffer 的开发依赖。
- 文档化的 `CreateProcessW` + `STARTUPINFOEX` AppContainer 启动方式仍只是调研候选。本 PoC 没有实现该路线，也没有证据证明它能修复硬链接越界或 Git 兼容问题。
