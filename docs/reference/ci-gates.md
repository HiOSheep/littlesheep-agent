# GitHub Actions CI 门禁

本页是 `.github/workflows/` 的唯一契约说明：两层门禁各跑什么、为什么只跑 Windows、干净 runner 如何准备数据根、哪些能力明确不在 CI 覆盖范围内，以及如何本地复现。

策略不是只写在文档里：`pnpm run verify:ci-config` 会解析工作流并逐条校验，快速门禁自己就运行这条命令，所以削弱门禁的改动会在同一次 CI 中失败。

## 两层门禁

| 文件 | 触发 | 执行的硬门 | 超时 |
|---|---|---|---|
| `ci-fast.yml` | `pull_request`；push 到 `main` | `pnpm install --frozen-lockfile`、`verify:ci-config`、`typecheck`、`check:repo`、`test:core-eval` | 30 分钟 |
| `ci-full.yml` | push 到 `main`；`workflow_dispatch` | `pnpm install --frozen-lockfile`、`verify:ci-config`、合成数据根引导、`verify:app-recovery`、`test:ci-recovery`、`verify:full`、`assert:app-build` | 90 分钟 |

两层都在 `windows-latest` 上运行，都使用 `permissions: contents: read`、显式 `concurrency`、`defaults.run.shell: pwsh` 和作业级 `timeout-minutes`。完整门禁把验证报告作为 artifact 上传：`if: always()`、保留 14 天、`if-no-files-found: error`，因此报告缺失本身也会让运行失败。

`verify:full` 的实际阶段依次是 `check:repo` → 全量 `vitest run` → `typecheck` → `pnpm run build:app` → `pnpm run verify:app-recovery`，与 `scripts/run-verification-gate.mjs` 一致。`test:ci-recovery` 是在全量测试之外显式列出的 Runner/VRS/S2B/S2C 恢复回归，防止未来裁剪测试包含范围时静默失去这部分覆盖。

## 主机与工具链

**只使用 `windows-latest`。** 项目是 Windows-first，且当前可实际验证命令的主机只有 Windows。Linux/macOS CI 是明确的后续工作：需要先在对应主机实测 Electron 构建、路径语义和恢复验收，再新增作业；在完成实测前不添加未经验证的 ubuntu/macOS 作业，也不以“跳过”掩盖缺失。新增主机需要同时更新本文件和 `scripts/lib/ci-workflow-policy.mjs`。

**Node.js 固定为 `26.4.0`。** 这是本仓库本地实际验证过的工具链版本；`package.json` 的 `engines.node` 为 `>=20.9.0`，因此该版本在支持范围内，而 20/22 等其它大版本没有本地实测证据，属于未验证范围。

**pnpm 固定为 `11.9.0`。** 与 `package.json` 的 `packageManager: "pnpm@11.9.0"` 完全一致；`verify:ci-config` 强制两者相等，并强制 `pnpm/action-setup` 的 `run_install: false`，保证唯一的安装入口是冻结锁文件那一步。

依赖缓存只缓存 pnpm store（`actions/setup-node` 的 `cache: pnpm`，以 `pnpm-lock.yaml` 为 key）和 Electron 下载缓存（`~\AppData\Local\electron\Cache`）。缓存不作为正确性证据：命中与否都执行同样的安装与门禁。

## 干净 runner 的合成数据根

`verify:full` 包含 `verify:app-recovery`，而 `scripts/verify-app-recovery-sources.mjs` 在数据根不存在时会失败。干净的 GitHub runner 没有 LittleSheep 用户数据根，所以完整门禁先执行：

```pwsh
node scripts/ci/prepare-ci-data-root.mjs --github-env $env:GITHUB_ENV
```

脚本在 runner 临时区创建一个隔离的合成数据根（默认 `$RUNNER_TEMP/littlesheep-ci-data-root`），写入最小但合法的结构：`data/config.json`（`agents.defaults.workspace` 指向已创建的工作区）、`data/projects/index.json`、`data/sessions.json`、空的 `sessions/`、`execution-logs/`、`run-checkpoints/`、`run-checkpoint-dispositions/`、`workspace/` 索引，以及 locator。随后通过 `GITHUB_ENV` 导出：

- `LITTLESHEEP_DATA_DIR`：合成数据根
- `LITTLESHEEP_DATA_LOCATOR`：指向合成数据根的 locator
- `LITTLESHEEP_RUN_ARTIFACTS_DIR`：runner 临时区中的报告目录，供 artifact 上传

安全约束：脚本拒绝在仓库工作树内创建目录，拒绝覆盖没有自身标记文件的既有目录，也拒绝指向真实数据根（`~/.littlesheep` 或 locator）。因此误配 `LITTLESHEEP_CI_DATA_ROOT` 会明确报错，而不是删除用户数据。

**这条路径证明什么：** 恢复源审计可以在一份干净、结构合法的合成数据根上通过。**它不是真实用户数据恢复证据，也不是 Electron 恢复验收的替代品。** 真实恢复证据来自专项 Electron／故障注入验收，CI 不声称覆盖。

## 恢复回归套件

`pnpm run test:ci-recovery` 用 `vitest run` 显式列出 47 个测试文件，覆盖：

- `packages/runner/src/durable-*.test.ts`：事件存储、inbox、effect/run lease、崩溃 worker、进程级恢复、分段恢复、最终结算与 no-progress 恢复。
- `packages/runner/src/run-checkpoint*.test.ts`：checkpoint 存储、disposition、controller 与主流程。
- `packages/runner/src/task-outcome*.test.ts`：task outcome 请求、结算与持久化。
- `packages/runner/src/session-restart-continuity.test.ts` 与 `vrs-verify-checkpoint-compat.test.ts`：会话重启连续性与 VRS/checkpoint 兼容。
- `packages/app/src/main/run-checkpoint-api.test.ts`、`run-recovery-authorization.test.ts` 以及 `packages/app/src/renderer/runtime-recovery/*.test.ts`：桌面 Main/Renderer 的 checkpoint 与恢复授权。

该列表同时登记在 `scripts/lib/ci-workflow-policy.mjs`；从 npm script 中删除任一必需文件都会让 `verify:ci-config` 失败。套件中的进程级用例在本地验证约需 3 分钟，CI 作业超时留有余量。

## CI 配置正负路径校验

`pnpm run verify:ci-config`（即 `node scripts/verify-ci-workflows.mjs`）用 `yaml` 解析两份工作流，并结合 `package.json`、本文件与数据根引导脚本执行策略检查。它既验证“当前提交的工作流合格”，也通过 `scripts/verify-ci-workflows.test.mjs` 在临时仓库副本中逐项注入违规，证明每条规则确实会拒绝：

- 缺少 `--frozen-lockfile`、出现其它形式的 `pnpm install`。
- 任何 `continue-on-error`、任何门禁步骤／作业上的 `if:`（唯一例外是 artifact 上传的 `if: always()`）。
- 缺失或超出范围的 `timeout-minutes`、缺失 `permissions`、缺失 `concurrency`、缺失 `defaults.run.shell: pwsh`。
- 多行或带 `;`、`&&`、`||` 的命令步骤（避免吞掉失败退出码）。
- `--run-real`、`--authorize-live`、`s3b-eval.mjs` 等真实 Provider 命令，以及 `secrets.*` 或凭据形态的环境变量名。
- 任何 GUI/Electron 验收命令（`verify:electron*`、`verify:desktop*`、`verify:window*` 等）或移除本文件的 GUI 未覆盖声明。
- artifact 缺少 `if: always()`、`retention-days: 14`、`if-no-files-found: error`，或上传路径不再指向 `LITTLESHEEP_RUN_ARTIFACTS_DIR`。
- pnpm 版本与 `packageManager` 不一致、Node 版本不是本地验证过的 `26.4.0`、`test:ci-recovery` 缺失必需用例。
- 缺失合成数据根引导，或依赖它的门禁排在引导之前。
- 额外新增、未经策略评审的工作流文件。

失败时命令以退出码 1 结束并逐条打印 `[fail] <code>: <location> — <message>`；测试文件对每个变异都断言对应 code 出现，并额外验证 CLI 在变异副本上退出 1。本地命令：

```pwsh
pnpm run verify:ci-config
pnpm exec vitest run scripts/verify-ci-workflows.test.mjs
```

## 硬门完整性

- 没有 `continue-on-error`；没有能让硬门被跳过的作业或步骤条件。
- 每个门禁步骤只有一条命令，Windows 上由 pwsh 传播原生退出码，避免多行脚本里前面的失败被后面的成功掩盖。
- 不读取 secrets，不调用真实 Provider，不产生付费请求；`--run-real` / `--authorize-live` 一律禁止。
- 报告上传使用 `if: always()`；报告缺失按失败处理，避免“没有报告但显示通过”。
- 策略校验本身也是门禁步骤：修改工作流来弱化门禁会先让 `verify:ci-config` 失败。

## 明确未覆盖的能力

<!-- ci-gates:electron-gui-not-covered -->
Electron GUI 交互验收（窗口行为、点击／拖拽／键盘、截图、CDP 合成输入、原生命中测试）需要真实显示器和桌面会话，CI 不运行这些验收，也不用单元测试或源码断言替代它们。相关 `verify:electron-*`、`verify:desktop-*`、`verify:window-*` 等命令必须由具备显示环境的专项验收执行；CI 工作流中出现这些命令会被策略校验拒绝。

其它明确不在 CI 覆盖范围内：

- 真实 Provider 模型任务、真实费用与 Usage：需要用户直接授权和 Provider 凭据，不属于 CI。
- Windows 安装包生成、签名与发布包运行时验收。
- Linux/macOS 上的构建、路径语义与打包。
- 性能、长稳与 soak 类测量；CI 不产出性能结论。
- 真实用户数据目录的恢复审计：CI 只有隔离的合成数据根。

## 本地复现

在 Windows 本地（pwsh）按 CI 的顺序复现：

```pwsh
pnpm install --frozen-lockfile
pnpm run verify:ci-config

$root = Join-Path $env:TEMP 'littlesheep-ci-data-root'
$summary = (node scripts/ci/prepare-ci-data-root.mjs --root=$root --json) | ConvertFrom-Json
$env:LITTLESHEEP_DATA_DIR = $summary.dataDir
$env:LITTLESHEEP_DATA_LOCATOR = $summary.locatorPath
$env:LITTLESHEEP_RUN_ARTIFACTS_DIR = $summary.runArtifactsDir

pnpm run verify:app-recovery
pnpm run test:ci-recovery
pnpm run verify:full
pnpm run assert:app-build
```

开发机上不设置上述环境变量时，`verify:app-recovery` 仍然使用真实数据根，这是本地日常验证路径；CI 只使用合成数据根。

## 失败语义与已知风险

- 任一硬门失败即整次运行失败；没有 automatic retry，也不把失败降级为告警。
- 若 `verify:app-recovery` 在合成数据根上失败，表示引导脚本或恢复源审计出现回归，不表示用户数据损坏；报告 artifact 会保留当次输出。
- 完整门禁中的全量 `vitest run` 会继承合成数据根环境变量（`verify:full` 在同一进程环境内执行各个阶段）。本批已按 CI 顺序在本地执行合成数据根引导、恢复审计、`test:ci-recovery` 与 `verify:full`；该次 `verify:full` 的全量测试阶段被宿主机外部负载阻断（WSL 单次命令约 139 s，超过验收脚本 120 s 等待上限；两个 30 s 上限的 Runner 分段用例在 3 worker 下超时，另有 worker 异常退出）。失败用例单独复跑均通过（WSL 验收除外，其受宿主机时延限制），本批未改任何 `packages/` 源码或相关测试。首次 GitHub 运行仍需复核 runner 镜像、action 解析与缓存路径差异，若出现与数据根相关的失败，应先核对这个隔离假设，而不是放宽门禁。
- 两份工作流尚未在 GitHub 上实际执行过：当前仓库没有推送授权，首次运行仍可能暴露 action 版本解析、runner 镜像差异或缓存路径等环境问题。在首次真实运行之前，本页与本地验证只证明配置在本地可解析、可复现，不证明 GitHub 托管的执行结果。
