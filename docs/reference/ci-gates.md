# GitHub Actions CI 门禁

本页是 `.github/workflows/` 的唯一契约说明：两层门禁各跑什么、为什么只跑 Windows、干净 runner 如何准备数据根、哪些能力明确不在 CI 覆盖范围内，以及如何本地复现。

策略不是只写在文档里：`pnpm run verify:ci-config` 会解析工作流并逐条校验，快速门禁自己就运行这条命令，所以削弱门禁的改动会在同一次 CI 中失败。

## 两层门禁

| 文件 | 触发 | 执行的硬门 | 超时 |
|---|---|---|---|
| `ci-fast.yml` | `pull_request`；push 到 `main` | `pnpm install --frozen-lockfile`、`verify:ci-config`、`typecheck`、`check:repo`、`test:core-eval` | 30 分钟 |
| `ci-full.yml` | push 到 `main`；`workflow_dispatch` | `verify:ci-config`、合成数据根引导（先于安装）、`pnpm install --frozen-lockfile`、`verify:app-recovery`、`test:ci-recovery`、`verify:full`、`assert:app-build`，最后上传运行产物 | 90 分钟 |

两层都在 `windows-latest` 上运行，都使用 `permissions: contents: read`、显式 `concurrency`、`defaults.run.shell: pwsh` 和作业级 `timeout-minutes`。完整门禁上传整个 `LITTLESHEEP_RUN_ARTIFACTS_DIR`：`ci-run-metadata.json`（运行与工具链元数据）、`logs/`（完整门禁日志）、`verification-reports/`（结构化阶段报告）；上传使用 `if: always()`、保留 14 天、`if-no-files-found: error`，因此产物缺失本身也会让运行失败。

`verify:full` 的实际阶段依次是 `check:repo` → 全量 `vitest run` → `typecheck` → `pnpm run build:app` → `pnpm run verify:app-recovery`，与 `scripts/run-verification-gate.mjs` 一致。`test:ci-recovery` 是在全量测试之外显式列出的 Runner/VRS/S2B/S2C 恢复回归，防止未来裁剪测试包含范围时静默失去这部分覆盖；它与全量测试的重复成本及其保留理由见“失败诊断与产物”。

## 主机与工具链

**只使用 `windows-latest`。** 项目是 Windows-first，且当前可实际验证命令的主机只有 Windows。Linux/macOS CI 是明确的后续工作：需要先在对应主机实测 Electron 构建、路径语义和恢复验收，再新增作业；在完成实测前不添加未经验证的 ubuntu/macOS 作业，也不以“跳过”掩盖缺失。新增主机需要同时更新本文件和 `scripts/lib/ci-workflow-policy.mjs`。

**Node.js 固定为 `26.4.0`。** 这是本仓库本地实际验证过的工具链版本。`package.json` 的 `engines.node` 为 `>=22.13.0`：产品代码直接导入免实验开关的 `node:sqlite`，该模块自 Node v22.13.0/v23.4.0 起才无需 `--experimental-sqlite`，因此 Node 20 与 22.0–22.12 不在可运行范围内；Electron 44.4.5 内置的 Node 24.21 也满足该下限。CI 只验证 26.4.0 这一个版本，其它大版本没有本地实测证据。

**pnpm 固定为 `11.9.0`。** 与 `package.json` 的 `packageManager: "pnpm@11.9.0"` 完全一致；`verify:ci-config` 强制两者相等，并强制 `pnpm/action-setup` 的 `run_install: false`，保证唯一的安装入口是冻结锁文件那一步。

依赖缓存只缓存 pnpm store（`actions/setup-node` 的 `cache: pnpm`，以 `pnpm-lock.yaml` 为 key）和 Electron 下载缓存（`~\AppData\Local\electron\Cache`）。Electron 缓存的命中文件会由 `@electron/get` 按 Electron 包内 `checksums.json` 校验，不匹配时重新下载；pnpm store 由锁文件 integrity 约束。缓存不作为正确性证据：命中与否都执行同样的安装与门禁。

## 干净 runner 的合成数据根

`verify:full` 包含 `verify:app-recovery`，而 `scripts/verify-app-recovery-sources.mjs` 在数据根不存在时会失败。干净的 GitHub runner 没有 LittleSheep 用户数据根，所以完整门禁在 `actions/setup-node` 之后、依赖安装之前先执行：

```pwsh
node scripts/ci/prepare-ci-data-root.mjs --github-env $env:GITHUB_ENV
```

脚本在 runner 临时区创建一个隔离的合成数据根（默认 `$RUNNER_TEMP/littlesheep-ci-data-root`），写入最小但合法的结构：`data/config.json`（`agents.defaults.workspace` 指向已创建的工作区）、`data/projects/index.json`、`data/sessions.json`、空的 `sessions/`、`execution-logs/`、`run-checkpoints/`、`run-checkpoint-dispositions/`、`workspace/` 索引，以及 locator；同时创建 `run-artifacts/logs/` 并写入 `run-artifacts/ci-run-metadata.json`（运行、仓库、SHA、attempt、runner OS、Node/pnpm 版本、锁文件解析出的 Electron 版本、路径与起始磁盘余量）。随后通过 `GITHUB_ENV` 导出：

- `LITTLESHEEP_DATA_DIR`：合成数据根
- `LITTLESHEEP_DATA_LOCATOR`：指向合成数据根的 locator
- `LITTLESHEEP_RUN_ARTIFACTS_DIR`：runner 临时区中的产物根目录（元数据、日志、报告），供 artifact 上传

**为什么先于安装：** 环境变量与 `logs/` 目录必须先存在，安装步骤和后续长门禁才能用 `Tee-Object` 把完整日志写入上传目录；即使后续步骤在第一个门禁前失败，artifact 仍至少包含 `ci-run-metadata.json`。

**磁盘余量：** 引导在任何创建或删除之前检查产物所在卷的空闲空间，低于 2048 MiB 时以明确原因失败。R4-A 的全量门禁阻塞来自外部磁盘耗尽（表现为 git “unable to write loose object file” 与 import-repo ENOSPC）；把同类问题提前成一条清晰错误，而不是后续一连串无关失败。

安全约束：脚本拒绝在仓库工作树内创建目录，拒绝覆盖没有自身标记文件的既有目录，也拒绝指向真实数据根（`~/.littlesheep` 或 locator）。因此误配 `LITTLESHEEP_CI_DATA_ROOT` 会明确报错，而不是删除用户数据。

**这条路径证明什么：** 恢复源审计可以在一份干净、结构合法的合成数据根上通过。**它不是真实用户数据恢复证据，也不是 Electron 恢复验收的替代品。** 真实恢复证据来自专项 Electron／故障注入验收，CI 不声称覆盖。

## 恢复回归套件

`pnpm run test:ci-recovery` 用 `vitest run` 显式列出 47 个测试文件，覆盖：

- `packages/runner/src/durable-*.test.ts`：事件存储、inbox、effect/run lease、崩溃 worker、进程级恢复、分段恢复、最终结算与 no-progress 恢复。
- `packages/runner/src/run-checkpoint*.test.ts`：checkpoint 存储、disposition、controller 与主流程。
- `packages/runner/src/task-outcome*.test.ts`：task outcome 请求、结算与持久化。
- `packages/runner/src/session-restart-continuity.test.ts` 与 `vrs-verify-checkpoint-compat.test.ts`：会话重启连续性与 VRS/checkpoint 兼容。
- `packages/app/src/main/run-checkpoint-api.test.ts`、`run-recovery-authorization.test.ts` 以及 `packages/app/src/renderer/runtime-recovery/*.test.ts`：桌面 Main/Renderer 的 checkpoint 与恢复授权。

该列表同时登记在 `scripts/lib/ci-workflow-policy.mjs`；从 npm script 中删除任一必需文件都会让 `verify:ci-config` 失败。套件本地运行 47 个文件、207 个用例（41 个文件实际执行，6 个 crash-worker 文件是供父进程启动的子进程夹具，独立运行时跳过），耗时 179–216 秒。它与全量 vitest 中同一批文件重复；保留理由与成本见“失败诊断与产物”。

## CI 配置正负路径校验

`pnpm run verify:ci-config`（即 `node scripts/verify-ci-workflows.mjs`）用 `yaml` 解析两份工作流，并结合 `package.json`、本文件与数据根引导脚本执行策略检查。它既验证“当前提交的工作流合格”，也通过 `scripts/verify-ci-workflows.test.mjs` 在临时仓库副本中逐项注入违规，证明每条规则确实会拒绝：

- 缺少 `--frozen-lockfile`、出现其它形式的 `pnpm install`。
- 任何 `continue-on-error`、任何门禁步骤／作业上的 `if:`（唯一例外是 artifact 上传的 `if: always()`）。
- 缺失或超出范围的 `timeout-minutes`、缺失 `permissions`、缺失 `concurrency`、缺失 `defaults.run.shell: pwsh`。
- 多行或带 `;`、`&&`、`||` 的命令步骤（避免吞掉失败退出码）；唯一允许的附加结构是白名单日志抓取管道。
- 长门禁步骤（安装、`test:ci-recovery`、`verify:full`）缺少日志抓取、把日志写到产物目录之外，或改成 `| Out-Null` 等其它管道。
- `--run-real`、`--authorize-live`、`s3b-eval.mjs` 等真实 Provider 命令，以及 `secrets.*` 或凭据形态的环境变量名。
- 任何 GUI/Electron 验收命令（`verify:electron*`、`verify:desktop*`、`verify:window*` 等）或移除本文件的 GUI 未覆盖声明。
- artifact 缺少 `if: always()`、`retention-days: 14`、`if-no-files-found: error`，或上传路径不再是 `LITTLESHEEP_RUN_ARTIFACTS_DIR` 根目录（必须包含元数据与日志）。
- pnpm 版本与 `packageManager` 不一致、Node 版本不是本地验证过的 `26.4.0`、`package.json` 的 `engines.node` 下限排除了固定 Node、`test:ci-recovery` 缺失必需用例。
- 缺失合成数据根引导、引导排在依赖安装之后，或依赖它的门禁排在引导之前。
- 引导脚本不再写 `ci-run-metadata.json`，或去掉小于 2048 MiB 空闲空间时的明确失败。
- 额外新增、未经策略评审的工作流文件。

失败时命令以退出码 1 结束并逐条打印 `[fail] <code>: <location> — <message>`；测试文件对每个变异都断言对应 code 出现，并额外验证 CLI 在变异副本上退出 1。本地命令：

```pwsh
pnpm run verify:ci-config
pnpm exec vitest run scripts/verify-ci-workflows.test.mjs
```

## 硬门完整性

- 没有 `continue-on-error`；没有能让硬门被跳过的作业或步骤条件。
- 每个门禁步骤是一条命令；唯一的附加结构是白名单日志抓取管道 `2>&1 | Tee-Object -FilePath "$env:LITTLESHEEP_RUN_ARTIFACTS_DIR\logs\<name>.log"`。Windows 上 pwsh 会把原生命令退出码交给步骤结果，因此管道不会把失败变成成功；`$?` 不可作为失败判断依据。
- 不读取 secrets，不调用真实 Provider，不产生付费请求；`--run-real` / `--authorize-live` 一律禁止。
- 产物上传使用 `if: always()`；产物缺失按失败处理，避免“没有证据但显示通过”。
- 策略校验本身也是门禁步骤：修改工作流来弱化门禁会先让 `verify:ci-config` 失败。

## 失败诊断与产物

- 结构化报告每个阶段只保留前 4000 字符的 stdout/stderr（`scripts/run-verification-gate.mjs` 的截断上限，存盘约 4019 字符、含截断标记），不足以解释长门禁失败。安装、`test:ci-recovery` 与 `verify:full` 的完整输出因此通过 `Tee-Object` 写入 `run-artifacts/logs/*.log` 并随 artifact 上传。
- 日志抓取是尽力而为的诊断：管道保留门禁退出码（GitHub 为 pwsh 追加 `exit $LASTEXITCODE`；本地以 `pnpm run <不存在的脚本>` 经同一管道验证退出码仍为 1），但 `Tee-Object` 自身写盘失败不会让已经通过的步骤失败，`$?` 也不能作为失败信号。日志不能替代硬门结果。
- artifact 上传使用 `if: always()`；作业级 `timeout-minutes` 取消整个作业时，后续步骤（包括该上传）不会运行；checkout/setup action 失败时引导尚未执行，没有可上传产物。这两种情况以托管运行页日志为准。
- 刻意保留的重复：`verify:app-recovery` 在 `verify:full` 内已有同名阶段，独立步骤约 4.0 秒（上次本地全量门禁总时长 756 秒的 0.53%），用于在长套件前快速失败并明确展示合成数据根证据；`test:ci-recovery` 与全量 vitest 重复同一批 47 个文件、207 个用例，本地 179–216 秒，约占全量测试阶段（656 秒）的 27–33%，用于显式、非静默的恢复回归门。首次托管运行取得真实耗时后再评估是否去重，本轮不削减覆盖。

## 明确未覆盖的能力

<!-- ci-gates:electron-gui-not-covered -->
Electron GUI 交互验收（窗口行为、点击／拖拽／键盘、截图、CDP 合成输入、原生命中测试）需要真实显示器和桌面会话，CI 不运行这些验收，也不用单元测试或源码断言替代它们。相关 `verify:electron-*`、`verify:desktop-*`、`verify:window-*` 等命令必须由具备显示环境的专项验收执行；CI 工作流中出现这些命令会被策略校验拒绝。

<!-- ci-gates:platform-exclusions -->
WSL 终端平台验收（`packages/app/src/main/local-app-api/workspace-terminal-wsl-acceptance.test.ts`，真实 WSL 发行版加 ConPTY 中继）不在通用全量门禁中运行：它依赖真实且响应正常的 WSL 主机，通用 `verify:full` 把它记为明确的 opt-in 跳过，该跳过不计作覆盖。专用入口为 `pnpm run verify:wsl-terminal`：退出码 0 表示通过，1 表示验收失败，2 表示环境阻断（无 WSL 或 WSL 命令超过 45 秒探测上限）；环境阻断只记录为阻断，不报告为通过。CI 工作流中出现该命令会被策略校验拒绝；路径映射与 Shell 发现语义仍由常规单元测试覆盖。Linux/WSL 专用入口 `node scripts/verify-posix-shell-authorization.mjs` 同样不属于 CI 覆盖。

其它明确不在 CI 覆盖范围内：

- 真实 Provider 模型任务、真实费用与 Usage：需要用户直接授权和 Provider 凭据，不属于 CI。
- Windows 安装包生成、签名与发布包运行时验收。
- Linux/macOS 上的构建、路径语义与打包。
- 性能、长稳与 soak 类测量；CI 不产出性能结论。
- 真实用户数据目录的恢复审计：CI 只有隔离的合成数据根。

## 本地复现

在 Windows 本地（pwsh）按 CI 的顺序复现：

```pwsh
$root = Join-Path $env:TEMP 'littlesheep-ci-data-root'
$summary = (node scripts/ci/prepare-ci-data-root.mjs --root=$root --json) | ConvertFrom-Json
$env:LITTLESHEEP_DATA_DIR = $summary.dataDir
$env:LITTLESHEEP_DATA_LOCATOR = $summary.locatorPath
$env:LITTLESHEEP_RUN_ARTIFACTS_DIR = $summary.runArtifactsDir

pnpm install --frozen-lockfile 2>&1 | Tee-Object -FilePath "$env:LITTLESHEEP_RUN_ARTIFACTS_DIR\logs\install.log"
pnpm run verify:ci-config
pnpm run verify:app-recovery
pnpm run test:ci-recovery 2>&1 | Tee-Object -FilePath "$env:LITTLESHEEP_RUN_ARTIFACTS_DIR\logs\test-ci-recovery.log"
pnpm run verify:full 2>&1 | Tee-Object -FilePath "$env:LITTLESHEEP_RUN_ARTIFACTS_DIR\logs\verify-full.log"
pnpm run assert:app-build
```

开发机上不设置上述环境变量时，`verify:app-recovery` 仍然使用真实数据根，这是本地日常验证路径；CI 只使用合成数据根。本地抓取日志前必须先运行引导脚本，否则 `LITTLESHEEP_RUN_ARTIFACTS_DIR` 与 `logs/` 不存在。

## 失败语义与已知风险

- 任一硬门失败即整次运行失败；没有 automatic retry，也不把失败降级为告警。
- 若 `verify:app-recovery` 在合成数据根上失败，表示引导脚本或恢复源审计出现回归，不表示用户数据损坏；运行产物会保留当次输出。
- 在 `77af687d` 上，一次干净的本地 `verify:full` 已通过：691 个测试文件 / 5042 个用例（683 个文件通过、5007 passed、35 skipped、0 failed），门禁耗时 818 秒；`check:repo`、全量测试、typecheck、`build:app` 与 `verify:app-recovery` 均实际执行。此前阻塞已归因：外部磁盘耗尽（ENOSPC）、WSL 宿主机延迟（137–144 秒，超过 120 秒等待上限）与 22–26 秒分段夹具的 30 秒默认超时。WSL 终端验收已改为 opt-in 平台入口，分段夹具超时已按边界调整。
- 两份工作流尚未在 GitHub 上实际执行过：当前仓库没有推送授权，首次运行仍可能暴露 action 版本解析、runner 镜像差异或缓存路径等环境问题。在首次真实运行之前，本页与本地验证只证明配置在本地可解析、可复现，不证明 GitHub 托管的执行结果。

## 首次托管运行检查清单

首次真实 GitHub 运行后逐项确认；未全部满足前，不得把 CI 标记为已通过：

1. 两份工作流都实际触发，并在运行日志中执行了每个必需步骤（不能只看 `verify:ci-config` 通过）。
2. 上传的 `ci-full-artifacts-*` 中存在 `ci-run-metadata.json`；核对其中的 Node（应为 `26.4.0`）、pnpm（`11.9.0`）、Electron 版本与 runner OS。
3. `logs/install.log`、`logs/test-ci-recovery.log`、`logs/verify-full.log` 均存在且非空；`verification-reports/latest.json` 的阶段状态与门禁结论一致。
4. 失败状态真实：既有失败或刻意失败时，步骤与作业为 failure，artifact 仍被上传，且没有 `continue-on-error` 或条件跳过的痕迹。
5. 缓存命中情况与起始磁盘余量（元数据中的 `freeDiskAtStart`）符合预期；首次冷缓存耗时在 `timeout-minutes` 预算内。
6. WSL 终端与 Electron GUI 仍按文档记录为未覆盖／opt-in，没有被托管运行伪装成已覆盖。
7. 记录首次运行耗时与环境差异，再决定是否评估 `test:ci-recovery` 去重或缓存优化。
