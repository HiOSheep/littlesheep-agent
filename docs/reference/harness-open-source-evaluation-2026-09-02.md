# Harness 开源底座评估记录

评估日期：2026-09-02
最后更新：2026-09-02 22:18:00
评估结论：不引入第三方 Harness 依赖；保留 LittleSheep 自有 Runtime/kernel，吸收已核验的事件、session 和 stream 设计。

这份记录只描述固定版本的公开证据和 LS 的适配边界。它不是对第三方项目当前 HEAD、未授权安全接口或未来版本的承诺。用户会话、粘贴文本、密钥和 `.littlesheep` 数据没有复制到仓库。

## 结论摘要

| 候选 | 固定版本 | 许可证 | 可借鉴点 | 淘汰/不直接引入理由 |
| --- | --- | --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | commit `49a606bc5b5934603f22a26957a07dc799ab0291` | MIT | append-only `SessionEvent`、durable session log、agent inbox、session projection、stream/tool lifecycle | README 将 `0.1.2-alpha.5` 标为 developer preview；API 兼容性风险、Cordis 源码 vendoring 和依赖面较大；权限、Memory v3 和 LS 数据根边界需要自有 Runtime 掌握 |
| [Pi](https://github.com/earendil-works/pi) | commit `e266507b606b9552fa277252644054afd4384b11` | MIT | `Agent`/`AgentSession`、stream/tool loop、abort、steering/follow-up queue、JSONL/tree session、compaction/fork/reload | coding-agent 入口包含 CLI/TUI/RPC、原生模块和较重依赖；README 明确没有 filesystem/process/network/credential permission system，不能满足 LS 的硬权限边界 |
| [nanoDeepSeekHarness](https://github.com/GitHubxsy/nanodeepseekharness) | commit `44e740718ea36e5801b0f9291bbbb688c62a199d` | MIT | 教学型最小 TypeScript agent loop，可作为对照夹具 | README 明确没有 sandbox、permission approval、persistence、concurrency scheduling；`read_file` 直接读取模型给出的路径，不满足生产安全契约 |

最终方案是：吸收 DeepSeek 的 durable event/session projection 思路，吸收 Pi 的 Agent/session/stream adapter 形态；event log、inbox、effect intent/settlement、权限、安全、Memory 和最终结算仍由 LS 自己实现。

## DeepSeek Harness

固定证据：仓库 README、`package.json`、`packages/*` 中的 session/event/inbox/projection 和 stream/tool 生命周期代码均在上述 commit 检查。README 的版本说明为 `0.1.2-alpha.5`，并明确标注 developer preview。公开结构能证明其设计包含 append-only session event、持久 session log、agent inbox、agent/session event 以及 projection，但不能由文档推断生产稳定性或 LS 语义兼容性。

许可证与供应链：仓库声明 MIT；Cordis 基础库以源码方式随仓库 vendoring，不能仅按 npm 运行时依赖清单估算再分发义务。正式引入前仍需保存完整 transitive license/NOTICE、安装脚本和依赖锁定审查。

安全状态：本次使用 GitHub 公开 API/raw 文件读取固定 commit。GitHub Dependabot API 在当前访问上下文未授权，因此没有漏洞快照；不能写成“无漏洞”。

LS adapter 边界：只允许其作为无副作用的 session/stream 参考或受控 adapter。LS Main 仍拥有 command validation、三档权限、容器路径判定、Tool Execution Service、Memory Write Gate、SSRF、取消和最终 settlement；第三方代码不能读取 LS 凭证、绕过工具注册表或直接写用户数据根。

## Pi

固定证据：仓库 README、`packages/agent-core` 的 manifest 和 Agent/session 实现均来自 commit `e266507b606b9552fa277252644054afd4384b11`；`@earendil-works/pi-agent-core` 版本为 `0.84.4`。核心提供真实 Agent、session state、streaming、tool loop、abort 和 steering/follow-up queue。session manager 使用 append-only JSONL/tree entries，并实现 compaction、fork 和 reload。

边界证据：README 明确说明核心没有内置 filesystem/process/network/credential permission system。coding-agent 包还带 CLI、TUI、RPC、原生模块和较重依赖，直接放入 Electron/渠道会扩大适配和供应链责任。

许可证与供应链：仓库声明 MIT。像 DeepSeek 一样，生产引入前需要固定 lockfile、NOTICE/transitive license、安装脚本、原生模块和网络/遥测审查；本阶段没有添加依赖。

LS adapter 边界：可以借鉴 `Agent + AgentSession` 生命周期和 stream/tool adapter，但所有 tool call 必须经过 LS Runtime 的 intent/settlement 和权限校验；Pi 的 session 文件不能成为 LS 会话或 Memory 的权威来源。

## nanoDeepSeekHarness

固定证据：README、`package.json` 和 TypeScript 源码来自 commit `44e740718ea36e5801b0f9291bbbb688c62a199d`。它是 MIT 教学型实现，适合做最小 API/流式行为的对照夹具。

淘汰证据：README 明确列出没有 sandbox、permission approval、persistence 和 concurrency scheduling；示例 `read_file` 直接读取模型提供的路径。它不能成为生产依赖，也不能作为 LS 安全边界的实现。

## 采用门与本阶段结果

任务书的采用门要求固定版本的许可证/NOTICE/依赖/漏洞证据、隔离数据根和禁止外网下的最小运行路径、明确的权限和 Memory 所有权，以及没有未登记的遥测、凭证读取或权限旁路。三个候选都没有在本阶段同时满足这些条件：DeepSeek 缺少稳定性和供应链完整证据，Pi 缺少 LS 所需权限系统，nanoDeepSeekHarness 缺少持久化和安全能力。

因此阶段 1 的决策是“保持自有 kernel，只吸收可验证设计”，不是把任一项目的示例 Harness 类复制进 LS。后续若重新考虑依赖，必须针对新固定 commit 重做这份审查，并先通过隔离运行、供应链和权限回归门。
