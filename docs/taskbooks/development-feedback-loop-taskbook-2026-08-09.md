# LS 开发反馈环提速任务书 2026-08-09

最后更新：2026-08-10 04:22:43

## 状态

进行中。阶段 0、阶段 1、阶段 2、阶段 3、阶段 4 已完成并分别形成独立提交且推送到 GitHub；阶段 5 正在进行，阶段 5A、阶段 5B、阶段 5C、阶段 5D、阶段 5E、阶段 5F 的实现、质量门、提交和推送已完成。本文是一个可单独设置为阶段目标的执行基线；完成任一阶段后，必须更新本文的状态、证据和实际边界，并提交、推送一次，再决定是否进入下一阶段。

## Goal

把 LittleSheep 的日常开发反馈环从“长期脏工作树触发近似全量验证”收敛为可解释、可分层、可重复的任务级验证流程，使开发者能在一次小改动后快速得到可信反馈，同时不降低提交前和阶段发布前的质量门。

本任务书优先处理已经测得的直接瓶颈：验证选择与验证编排。状态机、Runner 和 `RunContext` 的结构重构只在反馈环稳定后进入后续阶段，不把所有问题一次性合并成大重构。

## Current Baseline

基线以 2026-08-09 当前工作树为准，工作树可能包含用户未提交改动；以下数字只用于本任务书的起始比较，不代表发布状态：

- 历史基线的 `node scripts/run-affected-verification.mjs --list` 在干净基线下曾显示仅有 1 个变更文件、无受影响 package；历史长期脏工作树样本曾达到 177 个变更文件、27/27 个 package。这些数字不是当前工作树的测量结果。
- 历史长期脏工作树样本中的 `pnpm.cmd run verify:changed` 总耗时为 182.01 秒，其中 affected typecheck 约 0.67 秒，Vitest 约 178.12 秒；实际运行 283 个测试文件、1992 passed、1 skipped。该样本只用于说明原始瓶颈，不作为当前速度结论。
- 仓库导航现状不是“没有 README”：当前有 56 份 README，覆盖 27 个 workspace package 和多个领域子目录；源码、脚本和测试约 899 个文件，已有约 4,900 行注释。短期瓶颈是验证反馈闭环不可信，而不是全仓文档或注释数量不足。
- 初始基线中根脚本的 `build` 先执行全工作区 typecheck，`verify:full` 又显式执行 typecheck 后再调用 `build`，存在重复入口；该问题已在本轮拆出 `build:app` 后局部修正，完整门仍需重跑确认。
- `run-affected-verification.mjs` 会合并 committed、staged、unstaged 和 untracked 文件；lockfile、workspace 与 TypeScript 配置变化，以及无法确认根 `package.json` 契约快照的情况，会把类型检查扩大到全部 workspace package。根 `package.json` 仅脚本变化时现在按 `scripts-only` 分类，不再默认触发全量 typecheck，但构建脚本仍会触发 App build-sensitive 检查。
- 当前仓库已有增量 TypeScript project references、Vitest source alias、`verify:changed`、`verify:core` 和 `verify:full`，因此本任务应优先修正既有机制，不先引入 Turbo/Nx 等新编排层。

## Non-Goals

- 不进行全仓 README 补写或注释普查。
- 不以“所有生产文件低于 300 行”为验收目标，不做只为降低行数的机械拆分。
- 不在本阶段重写 Memory v3、替换 Runner 公共 API 或改变 Agent 的权限、记忆、工具和用户数据语义。
- 不把阶段验证改成只跑单元测试；涉及构建输入、跨包契约、Electron 生命周期或用户数据恢复的风险仍必须保留对应质量门。
- 每个阶段完成并通过验收后，必须只提交该阶段相关变更并推送到 GitHub；用户已有改动必须排除，不得用宽泛的全量暂存覆盖它们。

## Guardrails

- 保留用户当前工作树中的 staged、unstaged 和 untracked 改动；验证工具不得清理、回滚或重写这些改动。
- 验证选择器必须 fail-closed：无法确定基线、依赖传播或构建敏感性时，应扩大验证或明确失败，不能静默跳过。
- 快速门可以减少范围，但不能绕过类型契约、权限边界、工具证据、结构 VERIFY、恢复语义和必要的构建检查。
- 所有缓存、测试分层和构建复用都必须有明确失效条件；不能用过期产物冒充当前源码验证结果。
- 任何新增脚本或报告都必须遵守仓库位置无关、无本机路径泄漏、中文正式文档和生成物不入 Git 的约定。

## Target Workflow

```text
编辑单个任务
  -> 任务级内循环（watch / related test / package typecheck）
  -> 提交前 affected 门（按任务边界和依赖传播）
  -> 阶段门（完整 test + typecheck + app build + recovery）
  -> 发布前真实 Electron / Provider / 长负载专项门
```

快速门的目标不是替代完整门，而是让开发者尽早得到可信的局部反馈；阶段门和发布门仍是唯一的交付依据。

## Work Plan

### 阶段 0：建立可复现计时基线

状态：已完成。已建立 dry-run/受控执行报告入口，并完成完整测试、恢复检查、changed fallback 和完整门的统一计时采证。

- 为 `check:repo`、affected project discovery、typecheck、related tests、changed fallback、full tests、app build 和 recovery check 记录统一的阶段耗时。
- 报告至少包含：基线 ref、变更文件数、直接 package 数、传递受影响 package 数、测试文件数、是否触发 fallback、是否使用增量缓存、构建产物 fingerprint。
- 记录三种样本：单文件小改动、跨一个公共包的改动、长期脏工作树改动。
- 验收：同一机器、同一命令、同一 fixture 重复两次，报告字段完整；不能只给总耗时。

本轮证据（2026-08-09）：`pnpm.cmd run measure:verification` 已支持 JSON/Markdown 摘要、显式文件/package/manifest 样本、分段 timing 和受控 `--run` 阶段执行。单文件 `packages/harness/src/default-harness.ts` 两次 dry-run 的 planning 为 `24.56ms / 14.01ms`，fingerprint 为 `66.37ms / 64.71ms`，selection total 为 `90.96ms / 78.74ms`，直接包 `1`、传递受影响包 `9`、测试模式 `related`；当前单包 Harness 样本 selection total 约 `93.52ms`，直接/传递受影响包 `1/9`。脏工作树样本为 `14` 个变更文件、直接/传递受影响包 `0/0`，模式 `changed-fallback`，显式选择器回归 `4` 个，related 输入 `1` 个（用户已有 `test/e2e-webhook.test.ts`），fallback 原因 `verification-script-changed`；一次 `--run=affected` 的 planning/fingerprint/selection total/命令耗时约为 `350.46ms / 57.24ms / 407.72ms / 153.48s`。命令状态现在明确区分 `executed`、`skipped` 和 `failed`：本轮无 affected package 的 typecheck 为 `exitCode=0`、`signal=null`、状态 `skipped`，不能当作实际执行的 typecheck 通过。

质量门计时证据：`pnpm.cmd run check:repo` 为 `1.78s`，仓库卫生 `33/33`、TypeScript references `27/27`；`pnpm.cmd run verify:changed` 为 `145.34s`、退出码 `0`，运行 274 个测试文件并完成一次 App-only build；`pnpm.cmd run build` 为 `27.43s`、退出码 `0`；`pnpm.cmd run verify:app-recovery` 为 `0.49s`、退出码 `0`；`pnpm.cmd run verify:full` 为 `134.23s`、退出码 `0`，包含完整测试、typecheck、App build 和 recovery。完整测试的通过数随运行时状态有小幅波动，本轮两次均为 274 个测试文件、退出码 `0`，因此不把单次 passed 数写成固定契约。阶段 2 最终定向回归为 4 个文件、44/44；其中选择器与测量器边界回归为 16/16，workspace 图与执行器回归为 12/12；相关脚本语法和 `git diff --check` 均通过。

### 阶段 1：任务级内循环

状态：已完成。本阶段将以独立提交提交并推送；阶段 5 不因本阶段完成而自动开始。

- 增加不依赖 `origin/main` 的任务级入口，允许显式传入文件、package 或 task manifest。
- 为 Harness、Runner、Memory、App Renderer/Main 分别提供最小可执行示例：单文件相关测试、包级 typecheck、必要时 App web typecheck。
- 保留 `vitest` watch/related 的源码别名路径，避免为了单元测试先构建所有 workspace 包。
- 验收目标：典型单文件纯逻辑改动的首次反馈 <= 10 秒；热反馈中位数 <= 3 秒；典型单包改动不超过 30 秒。超出时必须在报告中指出具体阶段。

本轮实现与证据（2026-08-09）：

- 新增 `pnpm.cmd run verify:task` 与 `scripts/run-task-verification.mjs`。入口必须接收显式 `--files=<path>`、`--package=<name>` 或 `--manifest=<path>`，不读取 `origin/main`，不合并工作树其他改动；越界、缺失文件、空任务或无可执行输入均 fail-closed。
- 单文件任务优先寻找同路径的 `.test.*`/`.spec.*`，例如 `continuation-intent.ts` 只运行 `continuation-intent.test.ts`；找不到直接测试时才使用 `vitest related`，并把 fallback 写入计划。Harness、Runner、Memory 和 App Main 的最小文件任务均可执行；App Renderer/shared 输入会分离执行 `packages/app/tsconfig.web.json`，不会重复 typecheck 同一配置。
- package 任务默认只做包级 typecheck，避免 Runner 的整包测试自动触发 Memory v3 和 Runner 集成套件；需整包测试时使用 `--package-tests`，任务 manifest 可固定显式测试文件、typecheck 和 App web typecheck。
- 每次任务执行保存 `task-verification` JSON 报告，包含 explicit task boundary、测试计划、typecheck config、阶段耗时、失败阶段和最近历史；报告写入被忽略的 `.codex_tmp/verification-reports/task/`。
- 真实样本：Harness 单文件 `continuation-intent.ts` 为 `2.70s`，直接测试 5/5；App Renderer 单文件 `input-size.ts` 为 `2.94s`，直接测试 5/5 并完成 App web typecheck；App Main `close-policy.ts` 为 `2.86s`，直接测试 2/2；Memory `task-relevance.ts` 为 `2.52s`，直接测试 8/8；Runner 包级 typecheck 为 `1.25s`。此前未收敛的 `vitest related` 样本约 `59.08s`、28 个测试文件，已作为诊断证据保留，不能冒充任务级目标达成。
- 定向回归：`scripts/run-task-verification.test.mjs` 8/8，连同阶段 4 验证门和 selector 回归共 32/32；验证门脚本语法通过。Harness 单文件热反馈连续三次为 `2.924s / 2.695s / 2.693s`，中位数 `2.695s`，每次均实际执行直接测试和 package typecheck；因此满足热反馈中位数 <= 3 秒。阶段 1 最终 `verify:changed` 退出码为 0，总耗时 `127.51s`，278 个测试文件、1966 passed、1 skipped；`verify:core` 退出码为 0，总耗时 `11.45s`，7 个测试文件、127 passed；`verify:full` 退出码为 0，总耗时 `205.55s`，278 个测试文件、1966 passed、1 skipped，包含一次 workspace typecheck、App build 和 recovery。用户已有 `test/e2e-webhook.test.ts` 仍被纳入 changed fallback 的测试输入，但没有被本阶段暂存或提交。

### 阶段 2：修正 affected 选择器

状态：已完成。runner 与测量器现在共用同一份测试计划、显式选择器测试集、related 输入排除规则、删除输入和宽范围 fallback 语义；无法解析 merge-base、Git change-set、workspace manifest 图或依赖形状时均 fail-closed。根 `package.json` 脚本-only 变化不再误触发全 workspace typecheck，构建脚本和 App 源码/CSS/HTML/资源/Electron 配置按 build-sensitive 规则触发 App-only build。

- 将根级输入分类为：依赖/lockfile/workspace/TypeScript 配置、运行时脚本、测试配置、App 构建配置、文档/非运行时元数据；不同类别采用不同失效范围。
- 独立增加根验证脚本不应自动触发 27 个包全量 typecheck；依赖和编译契约变化仍可触发全量。
- CSS、HTML、资源、Electron/Vite 配置和原生依赖变化必须映射到 App build-sensitive 检查，即使没有对应 Vitest 文件。
- `merge-base` 无法解析时必须 fail-closed 或退化到完整门；Vitest fallback 使用解析后的有效 base。
- 为选择器增加回归测试，至少覆盖：单脚本改动、单 TS 文件、公共 `types` 改动、CSS/资源改动、删除测试输入、浅克隆/缺失 base。
- 验收：单脚本改动不触发无关 package typecheck；公共契约改动仍传播到所有真实 dependents；构建敏感文件不会静默跳过 App build 检查。

本轮已完成子项：`scripts/run-affected-verification.mjs` 不再将无法解析的基线静默回退为 `HEAD`；真实 CLI 在缺失 base 时以退出码 `1` fail-closed，并明确提示获取基线或传入 `--base=<ref>`。Vitest changed fallback 使用已解析的 merge-base SHA。根 `package.json` 仅脚本变化时不再触发全 workspace typecheck，而是输出 `scripts-only` 并把构建脚本变化映射为 App build-sensitive；workspace manifest 变化先校验 base/working 两侧图，再扩大 typecheck 和测试 fallback。runner 与 `measure:verification` 共用 `createAffectedTestPlan`、`GLOBAL_TYPECHECK_FILES` 和 `RUNTIME_CONFIG_FILES`；顶层 `branding.config.json`、`littlesheep.config.json` 变化会进入 `runtime-config-changed` fallback，不再静默跳过。阶段 2 定向回归为 `44/44`，`pnpm.cmd run check:repo` 为 `33/33`，相关脚本语法检查通过；随后真实 `pnpm.cmd run verify:changed` 以退出码 `0` 完成 274 个测试文件（1937 passed、1 skipped）和一次 App-only build。无 affected package 的 typecheck 明确报告为 `skipped`，不会冒充实际 typecheck 通过。

### 阶段 3：消除验证入口重复

状态：已完成。App 与 workspace 构建产物现在各自拥有可验证的新鲜度凭证；Electron 专项门复用同一份 App 产物，性能门只断言而不隐式构建。

- 从根 `build` 中拆出明确的 `build:app` 或等价 App-only build 入口。
- 让 `verify:full` 在一次全工作区 typecheck 后复用 App build，不再通过嵌套 `build` 重复调用 typecheck。
- 为多个 Electron/Memory 专项门增加“build once, verify many”入口，或者通过构建 fingerprint 明确复用当前产物。
- `verify:workspace-performance` 必须验证构建 fingerprint，不能直接启动未知是否过期的 `packages/app/out`。
- 验收：完整门日志中 typecheck 只有一个明确阶段；连续运行两个依赖相同 App 构建的专项门时不重复构建，或报告明确说明为何失效；过期产物被拒绝而不是被测量。

本轮验收证据（2026-08-09）：

- 新增 `scripts/lib/app-build-fingerprint.mjs`、`scripts/ensure-app-build.mjs`：App 必需入口、`out/**` 输出摘要、App 及传递 workspace 依赖闭包输入、根构建输入和 Electron 安装/准备运行时契约共同生成 `packages/app/out/.littlesheep-build-fingerprint.json`。`--build` 强制构建，`--ensure` 新鲜时复用，`--assert` 只断言，构建失败、构建期间输入变化、缺失/篡改输出、损坏 sidecar、符号链接和越界路径均 fail-closed。
- 新增 `scripts/lib/workspace-artifact-fingerprint.mjs`、`scripts/ensure-workspace-artifacts.mjs`：目标包的完整 workspace 依赖闭包生成 `packages/<package>/dist/.littlesheep-build-fingerprint.json`；输入、闭包、目标集合和所有 `dist/**` 输出均参与摘要。实际 `@littlesheep/runner` 验证为首次 `built`、再次 `reused`、`assert` 返回 `fresh`，一次构建覆盖 19 个闭包包。
- Electron 运行时解析统一读取 Electron 包的 `path.txt`，并校验版本、平台、架构、安装/准备可执行文件摘要、`version`、`locales`、`resources` 和 `default_app.asar`；不再依赖固定版本或候选路径。Windows `.cmd` 构建入口通过 `cmd.exe /c` 调用，确保真实构建可执行。DeepSeek V4 tokenizer 和 Memory Provider 两个 Electron 专项入口改用 `scripts/run-verified-electron.mjs`，不再让 Electron CLI 自己重新解析运行时。
- `verify:electron-*` 专项门及 `run-affected-verification.mjs` 改用 `ensure:app-build`；`verify:workspace-performance` 先 `assertAppBuildFresh`，过期或未知 `packages/app/out` 时拒绝测量，不偷偷触发构建。
- 定向测试：`app-build-fingerprint.test.mjs` 6/6、`workspace-artifact-fingerprint.test.mjs` 7/7，共 13/13；真实 `pnpm.cmd run build:app`/`ensure:app-build` 成功，最终 `assert:app-build` 为 `fresh`；相关脚本 `node --check` 全部通过。
- 阶段门：最终 `pnpm.cmd run verify:changed` 退出码 `0`，运行 276 个测试文件（1950 passed、1 skipped），命中 `package.json` 的 App build-sensitive 检查并复用新鲜 App 产物；此前完成的 `pnpm.cmd run verify:full` 退出码 `0`，运行 276 个测试文件（1949 passed、1 skipped），只出现一次显式 `tsc -b tsconfig.workspace.json`，随后完成 App build 和 `LittleSheep recovery sources: ok`。测试计数随运行时状态可能变化，以上数字仅作为本轮证据，不是固定契约。

实际边界：App sidecar 与 workspace `dist` sidecar 是两类独立凭证，不能互相替代；workspace sidecar 只证明声明的源码/依赖闭包和本地产物，不证明外部 Provider 进程或长负载状态；Electron runtime contract 当前证明安装/准备可执行文件和必需目录入口，不把外部 Provider 进程版本或全部运行时负载趋势写入本地 sidecar；性能门仍是只读断言，不负责修复过期产物。新鲜命中目前仍会重新扫描并哈希输入/输出以及 Electron 可执行文件，这是可观测的验证成本，后续可在阶段 4 之后单独优化；它不会触发重复编译。生成的 `out`、`dist` 和 sidecar 留在本机，不进入 Git。

### 阶段 4：把反馈环与质量门接入日常流程

状态：已完成。本阶段将以独立提交提交并推送；阶段 5 不因本阶段完成而自动开始。

- README 和仓库指南只补充命令选择规则、预计成本和失败时的升级路径，不复制实现细节。
- 将 `verify:changed` 定义为提交前门，`verify:core` 定义为核心契约门，`verify:full` 定义为阶段/发布门；明确三者不是简单的包含关系。
- 为每次验证输出机器可读摘要，并保留最近若干次本地结果用于比较冷/热反馈。
- 验收：开发者可根据改动类型在 30 秒内选出正确命令；一次失败能明确定位到 selector、typecheck、test、build 或 recovery 阶段。

本轮实现与证据（2026-08-09）：

- `package.json` 的三个入口统一由 `scripts/run-verification-gate.mjs` 编排。`verify:changed` 只运行一次 `check:repo` 和一次 selector，并复用 selector 计划执行受影响 typecheck、测试及必要的 App build；不再把 `typecheck:changed`、`test:changed` 作为嵌套步骤重复调用。`verify:core` 依次执行仓库门、全 workspace typecheck、核心契约测试；`verify:full` 依次执行仓库门、完整测试、一次全 workspace typecheck、`build:app` 和 recovery。
- 每个阶段均记录 `status`、`reason`、`exitCode`、`signal`、`durationMs`、命令、stdout/stderr 摘要及结构化 `details`；失败报告包含 `failedStage`，后续阶段明确标记为 `skipped` 并记录阻塞原因。`skipped` 不等于通过。
- 每次运行写入被 `.gitignore` 忽略的 `.codex_tmp/verification-reports/latest.json`，并保留最近 5 份带时间戳的历史报告；报告不进入 Git，不依赖用户运行时数据根，避免把诊断产物混入正式应用数据。
- `scripts/run-affected-verification.mjs --list --json` 输出纯 JSON 的 `affected-verification-plan`，人类输出不会污染机器结果；验证门脚本和其测试已加入 affected selector 的显式回归测试集，后续改动会自动扩大到选择器回归范围。
- 定向回归：`scripts/run-verification-gate.test.mjs` 8/8，连同 selector 输入回归共 24/24；`node --check` 和 `git diff --check` 通过；`pnpm.cmd run check:repo` 为 33/33。`verify:core` 真实退出码为 0，总耗时 `10.38s`，`check:repo`、`typecheck`、`tests` 分别为 `1.86s`、`1.58s`、`6.74s`，核心集合为 7 个测试文件、127 项。`verify:full` 真实退出码为 0，总耗时 `191.58s`，阶段为 `check:repo 1.86s`、`tests 115.02s`、`typecheck 0.61s`、`build 73.62s`、`recovery 0.48s`，完整测试为 277 个测试文件、1958 passed、1 skipped；只出现一次明确 workspace typecheck，App build 和 recovery 均通过。最终 `verify:changed` 真实退出码为 0，总耗时 `121.08s`；本次工作树 10 个变更文件、0 个 affected package，因验证脚本变化进入 `changed-fallback`，selector 回归 5 个文件/52 项和 fallback 完整测试均通过，typecheck 因无 affected package 标记为 `skipped`，build 因无 App build-sensitive 输入标记为 `skipped`。

### 阶段 5：状态契约重构（后续阶段，不与本任务前四阶段合并）

状态：进行中。阶段 5A、阶段 5B、阶段 5C、阶段 5D、阶段 5E、阶段 5F 已完成；阶段 5 整体尚未完成，下一候选是评估 `usage` 组的生产写入边界。

- 建立唯一 `allowedTransitions` manifest，运行时校验非法 Stage 边，并生成状态图。
- 为 `RunContext` 建立字段 owner、读写阶段和生命周期表；先收敛 `reply`、`replan`、`runtimeControl`、`memory` 四组高频共享状态。
- 保持 `createRunner()`、Harness 公共入口和持久化格式兼容；先抽取 Runner 的 prepare/execute/finalize/persist coordinator，再评估更深拆分。
- 该阶段的验收不以文件行数为主，而以非法转移可拒绝、字段写入边界可测试、核心流程回归和认知导航时间下降为主。

阶段 5A 本轮实现与证据（2026-08-10）：

- `packages/types/src/stage-transitions.ts` 提供唯一 `allowedTransitions`、稳定 `stageNames`、边检查和 Mermaid 状态图生成；每个 Stage 保留 `exit` 终止边，兼容 `execute -> finalize` 的自定义轻量执行出口。
- `packages/harness/src/default-harness.ts` 在默认 stage、claiming hook 和 modifying hook 结果归并后统一调用 `inspectStageTransition`；非法边收敛为 `ok: false`、`next: 'exit'`，并保留 `meta.transitionViolation`，不再静默进入任意 Stage。
- `packages/types/src/run-context-contract.ts` 提供四组高频字段的 owner、read/write stage、lifecycle 和 purpose；`getRunContextFieldContract`、`runContextFieldsForGroup`、`assertRunContextFieldWriteAllowed` 为后续 coordinator 拆分提供机器可读写入边界。没有改变现有 `RunContext` 公共字段形状或 checkpoint 持久化格式。
- `docs/reference/core-flow-state-contract.md` 提供渐进式披露的状态图、ownership 表和扩展规则，仓库指南已指向该入口。
- 定向回归：`packages/types/src/stage-transitions.test.ts`、`run-context-contract.test.ts` 和 `packages/harness/src/default-harness.test.ts` 共 19 项通过；连同既有验证门和 selector 回归，本轮 6 个定向测试文件共 51 项通过；types/harness TypeScript project check 通过。`check:repo` 为 33/33，27 个 TypeScript project references 通过。`verify:core` 退出码 `0`、`failedStage=null`，7 个测试文件、127 项通过，总耗时 `38.98s`。`verify:full` 退出码 `0`、`failedStage=null`，280 个测试文件、1974 passed、1 skipped，总耗时 `312.01s`；阶段为 `check:repo 5.71s`、`tests 210.89s`、`typecheck 1.08s`、`build 93.87s`、`recovery 0.46s`。

阶段 5A 尚未覆盖 Runner coordinator 的行为拆分，也未宣称阶段 5 整体完成；阶段 5B 已完成该最小抽取并重新运行 core/full 质量门。

阶段 5B：Runner coordinator 最小抽取

状态：已完成。保持 `createRunner()`、Harness 入口、checkpoint 持久化格式和 execution log 格式兼容；将运行结束路径按 `prepare -> execute -> finalize -> persist` 固定顺序组织。新增 `runner-coordinator.ts`、`runner-execute.ts`、`runner-finalize.ts`、`runner-persist.ts` 及 coordinator 边界测试；未进行 RunContext 大规模拆分，也未改变权限策略或业务状态机。

阶段 5B 实现边界：准备逻辑仍由 `runner.ts` 完成；execute helper 负责 Harness throw 转换与 checkpoint 写入；finalize helper 负责 conversation source、memory feedback、session summary activation、memory finish、compaction 和 `RunnerResult` 装配；persist helper 负责 execution log、latest session summary 和版本 checkpoint 完成。通用 coordinator 只负责阶段顺序和数据传递。

阶段 5B 定向证据（2026-08-10）：Runner coordinator 3 项、Runner continuation 2 项、Runner 主回归 26 项全部通过；Runner 包 typecheck 通过。阶段质量门：`check:repo` 为 33/33 且 27/27 TypeScript project references 通过；`verify:core` 为 7 个测试文件、127 项通过、`failedStage=null`；`verify:full` 为 281 个测试文件、1977 passed、1 skipped、`failedStage=null`，并完成 typecheck、App build 和 recovery。唯一 skipped 是 selector 不属于 full gate；recovery 的已有 sampled runIds/existing optional artifact warning 不构成阶段失败。用户已有 `test/e2e-webhook.test.ts` 改动未纳入本阶段。

阶段 5C：replan-state 写入边界

状态：已完成。实际盘点显示，replan 组是当前最分散的生产写入域：TaskBook、plan、revision、partial request、replan history 和 execution projection 横跨 DECIDE、VERIFY、EXECUTE、runtime boundary、TaskBook patch、RECOVER 与 Runner restore。原 ownership manifest 只能查询/断言，不能阻止生产代码绕过它；这正是当前开发反馈不可信的具体瓶颈。

本阶段新增 `packages/harness/src/replan-state.ts`，提供 `writeReplanState()` 和 `updateReplanHistory()`。写入前先完整校验每个字段在当前契约 stage 是否允许，全部通过后才以一个批次提交；因此非法调用不会留下半更新状态。已接入 DECIDE adoption、DECIDE partial merge、VERIFY replan、EXECUTE task-book runner、runtime control boundary、TaskBook patch、RECOVER plan retry 和 Runner checkpoint restore；新增 `replan-state.test.ts` 覆盖合法批次、非法阶段原子拒绝和历史复制更新。

阶段 5C 定向证据（2026-08-10）：replan-state、DECIDE、VERIFY、runtime-control-boundary、TaskBook patch 共 5 个测试文件、74 项通过；Harness 与 Runner typecheck 通过。公共门：`verify:core` 为 7 个测试文件、127 项通过、`failedStage=null`；`verify:full` 为 282 个测试文件、1980 passed、1 skipped、`failedStage=null`，完整测试、27/27 project references、App build 和 recovery 均执行成功。唯一 skipped 是 selector 不属于 full gate；recovery 的已有 sampled runIds/optional artifact warning 不构成阶段失败。测试夹具仍允许直接构造 `RunContext`，不纳入生产写入边界；用户已有 `test/e2e-webhook.test.ts` 改动未纳入本阶段。

阶段 5D：reply/replyProvenance 写入边界

状态：已完成。盘点确认 `reply` 组是下一处最清晰的责任边界瓶颈：REPLY、ASK_USER、DECIDE adoption、EXECUTE legacy/TaskBook、RECOVER 和 Runner restore 均会清空或发布可见文本，若直接写入 `RunContext`，文本与来源证明可能分离，且无法从代码快速判断生产写入责任。本阶段不改变模型生成、重复检查、连续性纠偏或持久化语义，只收敛写入入口。

- 新增 `packages/harness/src/reply-state.ts`，提供 `writeReplyState()` 与 `clearReplyState()`；完整校验批次字段和当前 stage 后才一次性写入。
- `reserveUserFacingReplyOnce()` 在唯一性闸门通过后同时提交 `reply` 与 `replyProvenance`；`acceptUniqueUserFacingReply()` 继续复用该入口。REPLY 的恢复任务回复显式传入 `reply` stage，Runner checkpoint restore 使用 `runner-restore` 清理。
- 生产路径中的回复清空已接入 REPLY、ASK_USER、EXECUTE、RECOVER、TaskBook failure/runtime boundary 和 Runner restore；DECIDE adoption 与 RECOVER direct clarification 不再绕过边界直接赋值。
- ownership manifest 允许 `reply`、`replyProvenance` 在 `runner-restore` 清理；`usage` 仍由模型观测边界负责，未纳入本阶段。

阶段 5D 定向证据（2026-08-10）：reply-state、REPLY、ASK_USER、RECOVER、EXECUTE、DECIDE 共 6 个测试文件、106 项通过；Harness build 与 Runner typecheck 通过。`pnpm.cmd run verify:core` 退出码为 0，仓库卫生 33/33、TypeScript project references 27/27、核心集合 7 个测试文件 127 项通过、`failedStage=null`，总耗时约 12.06s。`pnpm.cmd run verify:full` 退出码为 0，283 个测试文件、1984 passed、1 skipped、`failedStage=null`，并完成一次 workspace typecheck、App build 和 recovery；报告总耗时 198.58s，tests 144.38s、typecheck 1.98s、build 50.01s、recovery 0.43s。唯一 skipped 是 selector 不属于 full gate；recovery 的已有 sampled runIds/optional artifact warning 不构成阶段失败。用户已有 `test/e2e-webhook.test.ts` 改动不纳入本阶段。

阶段 5E：runtime state 写入边界

状态：已完成。盘点确认 `runtimeControl` 组的生产写入分布在 Runtime safe boundary、DECIDE 延迟事件消费、Runner 初始化和 checkpoint restore；若由各调用点自行复制校验和批次更新，仍会出现字段半更新、非法阶段写入和队列恢复语义混杂。本阶段只收敛 RunContext 顶层 runtime state 的写入入口，不代理 `RuntimeEventQueue` 内部的 open/settle/lease 状态。

- 新增 `packages/harness/src/runtime-state.ts`，提供 `writeRuntimeState()`：先校验完整字段批次和当前 stage，全部通过后才一次性写入；未知字段或非法阶段不会留下半更新。
- Runtime safe boundary 通过统一入口写入 `runtimeControl`、延迟事件和事件 id；DECIDE adoption 通过同一入口清理已消费事件；Runner 初始化和 checkpoint restore 通过同一入口写入队列、延迟事件、事件 id 和 loop budget。
- `runtimeEventQueue` 内部租约、open/settle、幂等和快照恢复状态仍由 `packages/runner/src/runtime-event-queue.ts` 自己拥有；本阶段不把队列内部状态提升为 RunContext 字段写入责任。
- `usage` 仍由模型观测边界负责，未纳入阶段 5E；`memory` 组仍是阶段 5 的下一候选。

阶段 5E 定向证据（2026-08-10）：`runtime-state.test.ts`、`runtime-control-boundary.test.ts`、`stages/decide.test.ts`、`runner-continuation.test.ts` 共 4 个测试文件、54 项通过；Harness build 与 Runner typecheck 通过。`verify:core` 与 `verify:full` 均在阶段收尾执行并通过，具体测试数量、耗时和 `failedStage` 以本次生成报告为准。用户已有 `test/e2e-webhook.test.ts` 改动不纳入本阶段。

阶段 5F：Memory 状态写入边界

状态：已完成。盘点确认 Memory 顶层 `RunContext` 字段的生产写入分散在 Runner bootstrap/restore、DECIDE 的任务记忆 refinement、EXECUTE 的 working set 和 KnownState、EVOLVE/CAPTURE、FINALIZE 以及 memory intent audit；如果各调用点继续直接赋值，字段批次、stage 权限和持久化边界无法从单一入口验证。本阶段只收敛顶层 RunContext 状态，不代理 Memory Repository/Service 的持久化事务，也不改变 Memory v3 的存储语义。

- 新增 `packages/harness/src/memory-state.ts`，提供 `writeMemoryState()`；先完整校验字段批次和当前 `RunContextContractStage`，全部通过后才一次性提交，未知字段或非法 stage 不会留下半更新。
- 已接入 Runner 初始化/恢复的 `sessionSummary`、`memoryRootIndex`、`initialMemoryContext`、`memoryKnownState` 和 working set；KnownState 合并、DECIDE refinement、EXECUTE 工具结果、EVOLVE/CAPTURE 输出、FINALIZE 连续性评估和 memory intent decision audit 均通过统一入口写入。
- `RuntimeMemoryContextWorkingSet` 的 open/settle、租约和持久化事务仍由各自 Memory/Runner 领域组件拥有；Memory Repository/Service 内部事务不属于 `memory-state.ts` 的责任边界。
- `memoryKnownState` 的 `reply` 读写阶段已补入 manifest，以覆盖 reply 模型请求前的合法证据标记；`usage` 仍由模型观测边界负责，未纳入统一写入入口。

阶段 5F 定向证据（2026-08-10）：`memory-state.test.ts`、`memory-known-state.test.ts`、`memory-context-working-set.test.ts`、`memory-taskbook-refinement.test.ts`、`stages/finalize.test.ts`、`stages/decide.test.ts`、`runner-continuation.test.ts` 共 7 个测试文件、57 项通过；Harness build 与 Runner typecheck 通过。`verify:core` 通过：仓库卫生 33/33、TypeScript project references 27/27、核心集合 127 项通过、`failedStage=null`。`verify:full` 通过：285 个测试文件、1991 passed、1 skipped，workspace typecheck、App build 和 recovery 均通过，`failedStage=null`；recovery 仅保留既有 sampled runIds 缺失 execution log 和可选 `workspace/artifacts.json` 警告。阶段 5F 已独立提交并推送；用户已有 `test/e2e-webhook.test.ts` 改动未纳入本阶段。

## Acceptance Matrix

| 维度 | 当前基线 | 目标 | 证据 |
| --- | ---: | ---: | --- |
| 单文件热反馈 | selector dry-run planning/fingerprint/selection total 两次 `24.56/66.37/90.96ms`、`14.01/64.71/78.74ms`；完整 related 门不以 selector 代替 | 中位数 <= 3 秒 | `measure:verification` 重复报告 + 定向门日志 |
| 单文件冷反馈 | selector planning/selection total 约 `24.56/90.96ms`；完整冷启动反馈由阶段门实跑记录 | <= 10 秒 | `measure:verification` 报告；不得用 selector 单独替代完整反馈 |
| 单包 affected 反馈 | selector selection total 约 `93.52ms`，直接/受影响包 `1/9`；完整 changed 门单独记录 | <= 30 秒（不含真实外部 Provider） | 选择器报告 + 定向门日志 |
| 任务级单文件冷反馈 | 初次 related fallback `59.08s`；直接测试优先后 Harness `2.70s`、App Renderer `2.94s`、App Main `2.86s`、Memory `2.52s` | <= 10 秒 | `verify:task` task JSON 报告；必须包含测试和 typecheck 阶段 |
| 任务级单文件热反馈 | Harness 直接测试任务三次总耗时 `2.924s / 2.695s / 2.693s`，中位数 `2.695s`；阶段 selector `17-18ms`、测试约 `1.33-1.59s`、typecheck 约 `1.31-1.35s` | 中位数 <= 3 秒 | 三份 `task-verification` JSON 报告 `heat-1/2/3.json` |
| 任务级单包 typecheck | Runner package task `1.25s`；整包测试曾为 `48.05s`，包含重型集成套件 | <= 30 秒 | 默认 package task 只做 typecheck；整包测试必须显式升级 |
| 长脏树行为 | 历史样本为 177 文件/27 包、182.01 秒；当前样本为 14 文件/0 affected package，changed-fallback，planning/fingerprint/selection total 约 `350.46ms / 57.24ms / 407.72ms`，实际 affected 门约 153.48 秒 | 不再默认为日常内循环；显式升级到提交前/阶段门 | 命令模式和日期化测量报告 |
| 根脚本改动失效范围 | 初始规则中任意 `package.json` 可能触发全量 typecheck | 按语义分类 | 当前脚本-only 工作树已收窄为 `0` affected package；契约变化回归仍保留 `27/27` |
| CSS/资源构建敏感性 | 本轮 CSS 样本被识别为 App build-sensitive，未启动测试 | 显式触发 App build-sensitive 检查 | selector 报告 + App build 证据 |
| 完整门 typecheck | 初始 `build` 与 `verify:full` 存在重复入口 | 一次明确 typecheck | `verify:full` 现在直接调用 `build:app`；阶段 3 App-only 构建和阶段 4 完整门日志共同证明只保留一次明确 workspace typecheck |
| Electron 专项门 | 多个命令重复 build | build once, verify many 或 fingerprint 复用 | 专项套件日志 |
| 状态转移可解释性 | `next` 分散、无唯一允许边表 | manifest + runtime validation + graph | Harness 特征测试 |
| RunContext ownership | 74 字段、跨 61 个生产文件访问 | 分域 owner 表，先收敛四组高频状态 | 类型/特征测试 + 导航文档 |

阶段 5A/5C/5D/5E/5F 当前证据：状态 manifest 覆盖 11 个 Stage、每个 Stage 的终止 `exit` 边及 38 条显式边；非法 `finalize -> reply` 自定义转移被拒绝，兼容 `execute -> finalize` 路径有回归保护。ownership manifest 现登记 27 个高频字段，其中 replan 组、reply 组、runtimeControl 组和 memory 组的 RunContext 顶层生产写入分别已通过 `replan-state.ts`、`reply-state.ts`、`runtime-state.ts` 和 `memory-state.ts` 统一校验；`usage` 仍需后续单独评估。阶段质量门和本地报告必须随阶段提交更新；报告中的 `skipped` 仅为 full gate 不适用 selector，不影响已执行的测试、typecheck、build 和 recovery。

## Verification Order

日常小改动只运行：

```powershell
pnpm.cmd run verify:changed
```

公共契约、workspace manifest、Harness、Runner、Context 或 Memory 改动升级为：

```powershell
pnpm.cmd run verify:core
```

阶段完成或发布前运行：

```powershell
pnpm.cmd run verify:full
```

`check:repo`、`typecheck:changed`、`test:changed` 仍保留为隔离诊断入口，不应与 `verify:changed` 连续执行而重复计算。`verify:changed` 默认基线为 `origin/main`，可用 `pnpm.cmd run verify:changed -- --base=<ref>` 或 `LITTLESHEEP_BASE_REF=<ref> pnpm.cmd run verify:changed` 覆盖；基线缺失时先获取基线或显式指定 ref。selector 无法证明范围时扩大验证或进入 fallback；报告中的 `skipped` 必须结合 reason 解读，不等于成功。

阶段 0-4 的日常开发不得因为一次小改动直接运行所有真实 Provider、Electron 长负载和 Memory soak 门；这些专项门在阶段完成或发布前按其自身任务书执行。阶段 5 任何公共契约或状态机变更仍必须至少执行 `verify:core`，并在阶段结束执行 `verify:full`。

## Stop Conditions

- 选择器无法证明变更范围时，扩大验证而不是跳过验证。
- 任务级入口与现有 `verify:changed` 的结果不一致且没有解释性报告时，暂停推广新入口。
- 构建 fingerprint 与源码/配置不匹配时，拒绝运行 Electron 性能或连续性验收。
- 为了缩短时间而删除权限、schema、工具证据、结构 VERIFY、恢复检查或真实最终回答时，立即停止该方向。
- 阶段 0-4 未完成前，不把状态机或 Memory 大重构标记为本任务已完成。

## Risks And Open Decisions

- “任务级”边界需要决定由显式文件列表、临时 task manifest 还是独立 worktree 表达；实现阶段应优先选择可审计且不改写用户工作树的方案。
- 复杂跨包改动可能天然需要较宽验证；目标是让扩大范围可解释，不是假装所有改动都能在秒级完成。
- 测试并发上限受 Windows SQLite/Git/Electron 资源竞争约束；提高 worker 数不是默认优化方向，必须以资源证据证明。
- 构建复用必须区分源码、配置、依赖和运行时资产 fingerprint；仅比较文件时间戳不足以证明可复用。

## Deliverable

完成后应交付：任务级/affected/full 三层命令、选择器回归测试、统一阶段计时摘要、无重复 typecheck 的完整门、至少一个 build-once 验收套件、状态转移 manifest 与 RunContext ownership 说明，以及更新后的项目状态证据。未完成的阶段必须明确标为进行中或未开始。

## 本轮剩余边界

- 阶段 0 已完成；剩余风险是完整测试计数随运行时数据状态小幅波动，及 fingerprint 扫描仍明显高于纯 planning 成本。报告已拆分两者，后续优化应针对扫描范围而不是误判 selector。
- 阶段 2 已完成并单独提交；顶层 `branding.config.json`、`littlesheep.config.json` 不属于当前编译输入，故保持在阶段 3 fingerprint 范围之外。workspace manifest、特殊 Git 状态、共享 `GLOBAL_TYPECHECK_FILES` 和非字符串 dependency 形状均已纳入保守校验或 fail-closed 处理。
- 阶段 3 已实现跨 Electron/Memory 入口的 App/workspace build-once/fingerprint 复用和过期产物拒绝；仍不把外部 Provider 运行时版本纳入本地 sidecar 的证明范围。
- 阶段 1 的任务级入口和直接测试优先策略已完成，阶段 4 的代码实现、定向回归、`verify:changed`、`verify:core` 和 `verify:full` 已完成；阶段 5A 的状态契约第一里程碑、阶段 5B 的 Runner coordinator 最小抽取、阶段 5C 的 replan-state 写入边界、阶段 5D 的 reply/replyProvenance 写入边界、阶段 5E 的 runtime state 写入边界和阶段 5F 的 Memory 顶层 RunContext 写入边界已完成，质量门、提交和推送按阶段独立执行；`usage` 组仍待评估。本阶段提交时必须排除用户已有的 `test/e2e-webhook.test.ts` 改动。
