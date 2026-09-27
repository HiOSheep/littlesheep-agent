# 整仓瘦身与冗余收口任务书 2026-09-27

最后更新：2026-09-27 18:57:47

状态：实施中（2026-09-27 起）。SL-00 / SL-01 / SL-06 已完成并提交，SL-03 主体完成（`vector` 已裁定退役、待与 SL-02 同批执行），SL-05 与 memory-v3 验收修复在进行，SL-02 / SL-04 / SL-08 因并行工作进行中而按任务书要求暂缓，SL-07 已出清单、用户裁定不删除。逐项证据与保留理由见文末「执行记录」。

## 1. 目标、范围和执行原则

在保持现有能力、权限边界、会话连续性和历史数据可读的前提下，减少无效文件、未使用的依赖、过时的执行接线、重复维护和发布体积。分别计量源码维护成本、安装包大小、本地磁盘占用和运行成本，不能互相替代。

- 不把文件大、名称包含 legacy、只有测试调用、包数量多直接判为无用。
- 不为减少行数删除回归覆盖；拆文件本身不算瘦身，必须减少重复实现、无用分支或依赖。
- 不重做已退役 HC/RS 任务书；生产热点拆分仍由 [模块拆分地图](../reference/module-split-map.md) 拥有，本任务书只承接净删除和依赖收口。
- 子 Agent 由 [现有任务书](single-level-subagent-taskbook-2026-09-24.md) 拥有，本轮不新增并行执行体系。
- 每批改动同步对应 package/领域 README，使用系统秒级时间；保留旧数据兼容夹具、授权校验、observation/revision、settlement 幂等与副作用恢复约束。
- 当前工作区有他人进行中的 App 依赖、圆角样式和测试改动，且临时构建文件持续出现。实施前重新核对差异，不清除或合并这些工作；本报告不冻结它们的状态。

## 2. 审查基线与证据边界

2026-09-27 读取 HEAD `ea3e5af8` 对应的版本库文件清单，统计的是当时工作区字节，包含既有未提交编辑；不是纯 HEAD 快照。未逐行证明所有源码可达，也未重建发布包或运行真实 Electron。

| 维度 | 实测值 | 口径 |
| --- | ---: | --- |
| Git 跟踪文件 | 1,929 | `git ls-files`，不含忽略目录和未跟踪文件 |
| 跟踪文件总字节 | 18,335,543（17.49 MiB） | 当前工作区文件长度；不是 Git 历史或磁盘实际分配 |
| workspace package | 28 | 不含根 manifest |
| package TS/TSX 非测试 | 154,830 行 | 包含空行、注释；按扩展名和 `.test.` 区分 |
| package TS/TSX 测试 | 96,320 行 | 同上，不将测试自动列作删除目标 |
| scripts | 148 个跟踪文件 | mjs/cjs/ps1 合计 67,393 行，包含脚本测试；文件数还包含 README |
| 已跟踪测试/编译临时产物 | 111 个，271,959 字节 | 110 个 cache-scope JSON + 1 个 Vitest 临时 mjs |
| 现存 Windows 解包目录 | 1,096.3 MiB | 本地已有 `release/win-unpacked` |
| 现存安装程序 | 229.7 MiB | 本地已有 Setup.exe，压缩体积不能由删文件大小直接推算 |

本地目录只读取文件长度，不跟随符号链接；不是磁盘占用工具的 allocated size。`.codex_tmp` 跳过了 1,257 个链接。以下目录存在不表示可以立刻删除：

| 目录 | MiB | 说明 |
| --- | ---: | --- |
| `release` | 1,326.3 | 含解包程序、安装程序与旁车文件，可能仍用于验收 |
| `.codex_tmp` | 1,172.5 | 其中 `p5d-p5c-output` 约 1,041.7；需确认是否保留唯一证据 |
| `packages/app/runtime` | 289.0 | 存在 `electron-v36.9.5-win32-x64`；当前 App manifest 声明 Electron 44，仍需确认启动路径与进程占用 |
| `packages/app/out` | 26.9 | 当前构建输出，不能当作无用缓存 |
| `tmp` | 9.4 | 主要为图标材料，不默认视为可再生 |
| `node_modules.link-damaged-20260804` | 0.1 | 名称显眼但当前字节很少，不是优先收益点 |

## 3. 已确认发现与待验证候选

### F-01：测试生成物进入版本库，现有门禁漏检（高置信）

`packages/harness/src/cache-scope-isolation-matrix.test.ts:63` 在 `process.cwd()` 下创建 `cache-scope-matrix-*`，`afterEach` 正常清理，但中断可留下目录。当前 10 个这样的目录共有 110 个跟踪 JSON；根目录还跟踪一份 `vitest.config.ts.timestamp-*.mjs`。不需要读取或发布其正文即可核对文件数与来源。

`.gitignore` 没有覆盖这两种形状；`scripts/check-repository-hygiene.mjs` 的 `checkTrackedGeneratedFiles` 只覆盖 out/dist/coverage/release/tsbuildinfo/log。因此本轮 `check:repo` **38/38 通过**与存在这些文件同时成立，不能用门禁通过反证无冗余。

### F-02：4 条没有所属包代码引用的生产依赖（高置信，删除仍需构建验证）

| manifest | 声明 | 当前依据 |
| --- | --- | --- |
| `packages/tools/package.json` | `@littlesheep/experience` | 所属包跟踪代码含测试和配置中无包名引用 |
| 同上 | `@littlesheep/memory-core` | 同上 |
| 同上 | `@littlesheep/vector` | 同上；vector README 明确称这是未使用声明 |
| `packages/harness/package.json` | `@littlesheep/safety` | 所属包跟踪代码含测试和配置中无包名引用 |

文本筛查不是完整动态依赖证明；还需核对 exports、运行期加载和打包规则。`packages/tools/tsconfig.json` 目前仍引用前三个包，因此维护和增量验证图也受影响。不要据此声称已证明能减少多少运行时间。

### F-03：旧模块存在不同程度的遗留，不能一刀切（分级）

- `packages/experience/src/record-experience.ts` 的 `createRecordExperienceTool` 只见定义和 public export，未见 Runtime 装配；对应 README 明确确认遗留状态。它是可退役候选。
- `packages/vector` 没有生产导入；README 仍承诺 v2 读取/验证能力，应先裁定这项离线兼容是否还有消费者，再退役包或缩成迁移夹具，不删用户数据库。
- **必须保留的当前消费者**：`packages/runner/src/infra.ts` 使用 ExperienceStore 和 LegacyExperienceBranch；`packages/cli/src/commands/import-repo.ts` 仍执行 `experienceStore.append`。所以 experience 整包不是死代码。
- **待验证的过时接线**：`packages/runner/src/runner.ts:686` 对每个 run 注册动态 taskbook Skill；`packages/harness/src/taskbook-skill.ts` 的说明仍要求先加载步骤，正文在既无 taskBook 又无 plan 时为空。`packages/skills/src/loader.ts` 把已注册动态项并入目录。需对普通新 run 和旧 checkpoint 分别取证，再决定是否只在有正文时注册；不能据此声称存在第二执行循环。
- `taskbook-patch.ts` 仍被 runtime-control-boundary 调用；`memory-epistemic-policy.ts` 仍被受控写入/纠正接线调用，二者不属于已证明无人调用的模块。

### F-04：现存 Windows 包含跨平台原生文件和整份前端依赖（明确体积，部分可删性待验证）

检查对象为现存 `release/win-unpacked/resources/app.asar` 与解包目录，asar 修改时间为 2026-09-26 15:04:45（本地时间）。它是旧构建样本，不代表当前工作区重建后的结果。

| 位置/依赖 | MiB | 判断 |
| --- | ---: | --- |
| `app.asar` 文件 | 444.71 | 包含依赖与 out |
| `app.asar.unpacked` | 361.26 | 原生/外置依赖 |
| 解包 `onnxruntime-node` | 287.51 | 其中 darwin 85.3、linux 68.4、win32 133.3；win32 同时有 arm64 和 x64 |
| asar 内 `onnxruntime-web` | 138.07 | 是否为当前 Node 推理路径所需，必须实测，暂不裁掉 |
| asar 内 `mermaid` | 79.87 | 完整依赖目录，需核对打包后的引用 |
| asar 内 `monaco-editor` | 68.53 | 同上 |
| asar 内 `pdfjs-dist` | 35.35 | worker、字体/cmap/wasm 等资源可能必须保留 |
| asar 内 `out` | 26.71 | 已构建业务代码和前端资产 |

`packages/app/electron.vite.config.ts` 将 workspace 和大部分依赖打入输出，明确把 Transformers/ONNX/node-pty 等保持外置；`packages/app/electron-builder.yml` 同时解包整个 ONNX/Transformers 目录。故跨平台二进制约 **153.7 MiB** 是优先过滤候选，前端库完整目录是重复携带候选。两个候选不能直接相加为承诺节省量；不要把所有 dependencies 移到 devDependencies，或删除原生动态依赖。

### F-05：脚本和文档的维护负担值得收口，但尚未证明大面积重复

- scripts 的约 6.74 万行不是应用运行时代码。大型场景脚本已部分复用 `scripts/lib/electron-cdp-harness.mjs`，不能再提出“从零搭公共框架”。
- `verify-html-preview-baseline.mjs`（2,952 行）、`verify-electron-ui-state-continuity.mjs`（2,199 行）、`verify-workspace-performance.mjs`（2,182 行）适合做场景/断言矩阵后去重，行数本身不是删除依据。
- 根目录 `head-sections.mjs`、`ts-keys.mjs`、`tool-keys.mjs` 是执行日志诊断脚本；在 packages/scripts/test/docs/package scripts 中没有发现其名称引用。先确认维护入口，再归并到现有诊断脚本或退役。
- 根 package scripts 中显式引用的脚本/测试文件本轮均存在；对跟踪 ts/tsx/mjs/css 的字节散列扫描未发现大于等于 100 字节的完全相同文件。未做 AST 克隆分析，因此不宣称不存在语义重复。
- `docs/README.md` 开头仍说“模型没有记忆写入工具，持久记忆的唯一写入方是会话压缩路径”，但 `packages/runner/src/infra.ts:520,654` 已装配 memory_manage/memory_write，项目状态也记载压缩只产摘要。`packages/harness/src/stages/README.md` 同时出现 tool stage 新说明与压缩写入旧说明。这是已确认的文档漂移，重复转述当前事实有维护成本。

## 4. 实施任务

### SL-00｜固定四类基线（P0，S）

- [ ] 依赖：无。
- 范围：本任务书、`scripts/lib/app-build-fingerprint.mjs`、现有构建和发布脚本。
- 操作：选定无并行编辑的提交/工作区状态；保存 Git 清单、源码/测试/脚本计量、构建指纹、安装包与 unpacked 分项、进程占用。本轮审查数据作为参考，不能替代实施前快照。
- 验收：所有前后对比绑定 commit、工作区差异摘要、平台/架构和构建指纹；区分本地缓存、Git 跟踪文件、发布载荷、运行成本。没有运行测量时不声明提速。

### SL-01｜移除误入库生成物并堵住来源（P1，S）

- [ ] 依赖：SL-00。
- 范围：`.gitignore`、`cache-scope-isolation-matrix.test.ts`、`scripts/check-repository-hygiene.mjs`、对应 harness/scripts README。
- 操作：精确核对并移除上述 111 个已跟踪产物；把测试目录放在系统临时区或仓库统一忽略暂存区，保留 finally/afterEach；补窄范围忽略规则和跟踪文件拒绝规则，并兼顾当前出现的临时 Electron Vite 配置文件。
- 验收：跟踪清单不再包含这些生成物；相关测试运行及受控中断后，根目录不新增可入库文件；故意将同类生成物纳入隔离测试仓库时门禁失败。不能用忽略全部 JSON/MJS 通过检查。

### SL-02｜删除无效依赖边（P1，S）

- [ ] 依赖：SL-00；与 SL-01 可独立推进。
- 范围：tools/harness manifest、对应 README、生成的 tsconfig references、锁文件。
- 操作：逐条复核 F-02 的 4 条依赖并删除无运行用途者；同步 TypeScript 项目图和 lock，不手改生成图以隐藏依赖。
- 验收：`pnpm run sync:tsconfig`、`pnpm run typecheck`、相关 tools/harness/runner 测试通过；干净环境 frozen-lockfile 安装和构建可重复；没有依赖未声明的偶然提升包。记录依赖边净减少量，不能把依赖边数当作二进制大小收益。

### SL-03｜退役未装配工具，隔离旧数据兼容（P1，M）

- [ ] 依赖：SL-02。
- 范围：experience 的 record-experience/index、vector 包及调用声明、harness/taskbook-skill、runner/runner、skills/loader、相关 README。
- 操作：先删除无消费者的旧 record_experience 工厂及其 export；另行明确 vector 离线读取契约的所有者，确无产品/迁移消费者才退役包。普通 run 的 taskbook 目录项是否为空先取证，有正文才注册或在兼容边界供给；不得破坏会话前缀稳定性。每类改动分开提交和验收。
- 验收：新 run 不暴露无正文的动态 Skill；旧 checkpoint 的计划仍可读、仍走单循环；skill 目录跨轮/重启行为和缓存观测通过；CLI import-repo、旧数据根升级、memory_write/manage 与 v3 检索回归通过。删除旧模块不删除持久数据，不恢复退休执行路径。

### SL-04｜按目标平台收窄发布载荷（P1，M）

- [ ] 依赖：SL-00；先在未做源码清理的基线上验证体积收益，再与 SL-02/03 合并复测。
- 范围：App manifest、`electron-builder.yml`、`electron.vite.config.ts`、`scripts/package-windows-release.mjs`、App/scripts README。
- 操作：明确 Windows x64 的原生资产清单，首先剔除非目标平台/架构二进制。再从真实 bundle import/动态 require 与资源引用确定最小运行依赖闭包，收窄已经打包到 out 的前端依赖副本。保留需要动态加载的原生模块、PDF 资源和模型资源；WASM 是否可移除单独验证。
- 验收：全新产物不再含 darwin/linux/非目标架构原生文件；在没有源码目录、开发 node_modules 和开发机模型缓存的隔离环境验证启动、终端 node-pty、本地 embedding 首次准备与再次离线使用、PDF/Word/表格读写、Monaco、Mermaid 和 HTML 预览。记录 unpacked/asar/Setup 三组真实差值；功能未覆盖不得宣布发布完成。

### SL-05｜精简重复验收实现与孤立诊断入口（P2，M）

- [ ] 依赖：SL-00。
- 范围：F-05 三个大型脚本、`scripts/lib`、根目录三个诊断脚本、根 package scripts、scripts README。
- 操作：先建立“场景—独有断言—证据层级—所属入口”表；只合并真正相同的等待、进程启动、连接和夹具逻辑，复用已有 helper。删除被完整替代的入口，保留不同故障路径与独有断言。不做纯拆文件工程，不引入通用验收 DSL。
- 验收：被移动/合并的每条独有断言有新归属；真实进程重启、恢复、取消和故障注入仍被执行；所有公开命令有效，脚本净行数或重复实现数量下降。回归耗时变化记录为实测，不删除失败项来改善读数。

### SL-06｜消除当前事实的重复与文档漂移（P1，S）

- [ ] 依赖：无；后续随 SL-02～05 同步收口。
- 范围：`docs/README.md`、`docs/decision/project-status.md`、harness stages/runner/memory-tree/experience README。
- 操作：修正 F-05 已确认的压缩写入旧说明；入口只保留当前方向与 owning 文档链接，减少长篇退休历史和在多处重复测试数字。退休事实回 Git 历史，仍有验收价值的机器账本与独有约束保留。先列出独有事实去向再删除段落。
- 验收：常驻入口对受控记忆写入、摘要压缩、旧 checkpoint 和单循环的描述一致；导航、链接和秒级时间门通过；所有仍开放的验收边界有 owner。文档变短不表示实现有变化。

### SL-07｜安全回收本地可再生输出（P2，S）

- [ ] 依赖：SL-00；发布包作为 SL-04 基线/验收证据时先保留。
- 范围：第 2 节列出的具体本地目录，优先 `.codex_tmp/p5d-p5c-output` 与旧 runtime。
- 操作：生成带绝对解析路径、链接目标、大小、归属、占用情况和保留理由的 dry-run 清单；仅清理已确认不再使用且可重建的项目。保留唯一验收证据、用户图标源文件、模型缓存和用户数据。删除前确认路径在指定目标中且未经过链接跳到外部。
- 验收：保留必要证据后核对实际释放字节；当前开发启动和重建正常；不修改 Git 工作区已有用户改动；不用 `git clean -fdx` 或全盘通配删除。收益仅记为本地磁盘回收。

### SL-08｜整体验收与防回流（P1，M）

- [ ] 依赖：SL-01～07；不执行的候选须写明保留理由和负责人。
- 范围：本任务书、现有 repo/full verification 和 release 门；不另建重复验收框架。
- 操作：比较 SL-00 基线，汇总移除文件、依赖边、实际退役模块、脚本重复量和安装包字节；复跑仓库门、类型检查、受影响测试，跨包清理完成后再跑完整门。发布变更必须绑定新安装包的实机证据。
- 验收：现有功能与硬约束无回归；检查能拒绝已确认的生成物回流；不存在任务清单完成却只跑文档检查的情况。失败、未覆盖平台和真实模型验收缺口保留为未完成。

建议顺序：SL-00 → SL-01/02/06 → SL-03/04 → SL-05/07 → SL-08。SL-04 是发布体积收益重点，SL-01/02 是低风险清理起点；不先改 Harness 主循环或砍产品能力。

## 5. 本轮验证记录

- 已完成：版本库清单/尺寸、workspace manifest 与引用筛查、生成物来源、关键运行接线、现存 asar 元数据和目录大小核对；没有提取发布包中的用户数据或执行日志正文。
- 已完成：修改前 `pnpm.cmd check:repo`，38 项通过、28 个 TypeScript 项目引用有效。明确保留 F-01 的检查盲点。
- 文档交付检查：修改后 `check:repo` 仍为 38/38，TypeScript references 为 28/28；19 个明确源码引用均存在，9 项任务均未勾选且已接入文档入口。任务书尚未纳入 Git index，因此门禁的 tracked-only 任务书计数仍为 1，实际现存 2 份已单独核对。本次文档的空白检查通过；全仓 `git diff --check` 在并行编辑的 Renderer README 第 2/8/9 行报告行尾空白，本轮未处理。没有用文档检查证明瘦身实施完成。
- 未运行：完整测试、真实模型、真实 Electron、重新打包、干净机器安装与性能对比。本轮没有移除产品源码、依赖或本地文件。

## 6. 执行记录（2026-09-27，按提交绑定）

本轮由主 Agent 与子 Agent 分批实施；每条记录都注明证据与门槛结果，未执行的候选写明保留理由。基线见 [repository-slimming-baseline-2026-09-27.md](../reference/repository-slimming-baseline-2026-09-27.md)（绑定 HEAD `ec527a7e`）。

### 已完成

| 任务 | 提交 | 证据 |
| --- | --- | --- |
| SL-00 固定基线 | `5116e74b` | 基线账本：1,930 跟踪条目 / 18,351,219 HEAD 字节 / 本地目录 lstat 实测 / 平台与 Node 版本；**明确记录没有重建、打包或实跑，因此不含任何提速声明** |
| SL-01 移除误入库生成物 | `c203f4aa` | 删除 111 个跟踪产物（110 个 `cache-scope-matrix-*/*.json` + 1 个 `vitest.config.ts.timestamp-*.mjs`，271,959 B，与审查值一致）；两处测试暂存改到系统临时目录；**中断实测**仓库根不再新增可入库文件；门禁新增 4 种形状拒绝 + 4 条忽略规则存在性校验，并有"把门禁拷进临时仓库"的失败用例；跟踪清单中该类产物现为 **0** |
| SL-06 消除文档漂移 | `25cf9764` | 14 个文件修正为"受控工具写入 + 压缩只产摘要"（每处先在代码核对行号）；入口文档历史段 19 段 → 1 行规则 + 10 行归属表，逐条先确认独有事实去向；两处自相矛盾消除；25 个文档链接无丢失 |
| SL-03 退役未装配工具 + Skill 取证 | `db8b3197` | 删除 `record-experience.ts` 及其导出（全仓搜索仅定义/导出/README/任务书；净 −229 生产行，导出 10→8，零测试覆盖被删；`infra.ts` 与 CLI `import-repo` 的消费者保持）；`runner.ts` 仅在正文非空时注册动态 taskbook Skill —— 取证测试在模型请求内读实时描述：改前普通 run 广告 `taskbook` 而正文 `undefined`，改后为 `(none)`，旧 checkpoint 仍读出计划且 `execute` 恰好一次、无 `decide` |

验证门槛：`check:repo` 在上述每次提交后均为 38/38（含 28 个 TypeScript 项目引用）；SL-01 后 `packages/harness` 82 文件 / 703 项通过；SL-03 后 experience+vector+skills+harness+runner+cli 共 151 文件 / 1,200 项通过。

### 进行中

- **SL-05**（脚本收口）：先建"场景—独有断言—证据层级—入口"表再合并；根目录三个诊断脚本先查维护入口再决定退役。
- **memory-v3 验收修复**（用户追加要求）：`verify:memory-v3-provider` 等仍在断言已删除的 EVOLVE/CAPTURE 意图与旧阶段列表，属于验收落后于实现；整族审计并重写到"受控写入 + 压缩只产摘要 + 单循环"，新增"无记忆指令的 run 不得产生 durable 写入"的负例；真实 provider 运行需要 `DEEPSEEK_API_KEY`，未设置前不宣称通过。

### 未执行（保留理由与前置条件）

| 任务 | 状态 | 理由 / 前置 |
| --- | --- | --- |
| SL-02 删除无效依赖边 | 待执行 | 需要同步 `pnpm-lock.yaml`，而该文件正被并行的 Electron 44 升级占用且尚未提交；现在改写会把两批改动混进同一提交，违反本任务书"不清除或合并这些工作"的要求 |
| SL-03 的 `vector` 退役 | **已裁定：退役** | 用户 2026-09-27 裁定退役该包；用户 v2 数据库原样保留、读取实现留在 Git 历史。执行需改 `packages/tools/package.json`、`vitest.config.ts` 别名、生成的 tsconfig references 与锁文件，与 SL-02 同批进行 |
| SL-04 收窄发布载荷 | 待执行 | 依赖 SL-00 基线；`packages/app/runtime` 现为 1,625.9 MiB（含并行升级正在写入的临时目录），打包配置在途，先做会测到中间状态 |
| SL-07 回收本地输出 | **已按裁定收尾**：清单见文末「SL-07 本地输出回收：dry-run 清单」，本轮零字节回收 | 用户 2026-09-27 决定：只出带保留理由的清单，等逐个确认。实测：`release` 1,326.3 MiB（保留为 SL-04 基线）、`.codex_tmp` 1,172.6 MiB（其中 `p5d-p5c-output` 1,041.7 / `dependency-audit` 58.4 / `verification-reports` 27.9 / `ls-instances` 21.8 MiB）、`packages/app/runtime` 1,625.9 MiB、`packages/app/out` 26.9 MiB、`tmp` 9.4 MiB（任务书明确不默认视为可再生） |
| SL-08 整体验收与防回流 | 待执行 | 依赖 SL-01～07；须汇总移除文件、依赖边、退役模块与安装包字节，并在跨包清理完成后跑完整门 |

### 实施期间发现的独立问题（不在本任务书范围，已登记）

- `pnpm run verify:memory-v3-provider` 在本任务书开始时**不可能通过**：脚本仍要求已删除的 EVOLVE/CAPTURE 记忆意图与 ENTER/CLASSIFY/DECIDE 阶段。已由本轮的验收修复任务处置。
- workspace `typecheck` 当前失败于 `packages/app/src/main/embedded-browser.ts:125,127`（Electron 44 类型使 `hostWebContents` 可空），来源是并行的 Electron 升级，不由本任务书引入，需由该工作收口。
- `packages/app/out/.littlesheep-build-fingerprint.json` 在测量时缺失，`ensure-app-build.mjs --assert` 报 `manifest-unavailable`；基线账本改用只读重算的输入/输出摘要并已注明。
- `packages/experience` 的 `zod` 与 `@littlesheep/types` 依赖边在 SL-03 删除后不再被该包使用；依赖边收口属 SL-02。

### SL-04 前置测量（2026-09-27，只读；未改任何打包配置）

对象是现存旧构建样本 `release/win-unpacked`（解包时间 2026-09-26 15:04，**不代表当前工作区重建结果**）。口径：文件长度合计，不跟随符号链接，不是磁盘分配量。

`resources/app.asar.unpacked/node_modules` 中的原生载荷：

| 依赖 | MiB |
| --- | ---: |
| `onnxruntime-node` | 287.5 |
| `@napi-rs` | 36.0 |
| `@img` | 18.5 |
| `node-pty` | 9.3 |
| `@huggingface` | 8.6 |

`onnxruntime-node` 按平台/架构拆分（`napi-v6/<platform>/<arch>`）：

| 目标 | MiB | 判定 |
| --- | ---: | --- |
| `darwin/arm64` | 85.3 | 非目标平台，移除候选 |
| `linux/arm64` | 24.3 | 非目标平台，移除候选 |
| `linux/x64` | 44.1 | 非目标平台，移除候选 |
| `win32/arm64` | 69.4 | 目标平台但非目标架构，移除候选 |
| `win32/x64` | 64.0 | **唯一需要保留** |

**实测非目标载荷合计 223.1 MiB**（占该依赖 287.5 MiB 的 78%）。任务书 F-04 原估 153.7 MiB 只计入了 darwin 与 linux，**漏掉了 `win32/arm64` 的 69.4 MiB**；本表为实测修正值。

留待 SL-04 执行时验证的两点，均未测量：①`@napi-rs`、`@img`、`node-pty` 是否同样携带非目标平台/架构变体（同一方法可测）；②该 223.1 MiB 是**解包体积**，安装包（NSIS 压缩）与 asar 内的差值必须在**真实重建产物**上重测，不能由本表推算；③必须保留动态加载的原生模块、PDF 资源与模型资源，WASM 是否可移除需单独验证（任务书 SL-04 验收项）。

### SL-07 本地输出回收：dry-run 清单（2026-09-27，用户裁定不删除）

口径：`lstat` 递归文件长度合计，不跟随符号链接，不是磁盘分配量（allocated size）。上表所有命中项均为 `real` 目录，**没有链接指针**（此前审查记录的 1,257 个链接位于 `.codex_tmp` 更深处，按设计跳过，未计入任何数字）。**本轮未删除任何文件**——用户 2026-09-27 裁定只保留清单与理由，待逐个确认。

| 绝对路径 | MiB | 文件数 | 归属 | 保留理由 / 处置 |
| --- | ---: | ---: | --- | --- |
| `D:\Repositories\littlesheep\.codex_tmp\p5d-p5c-output` | 1041.7 | 20834 | 早期 Codex 会话的产物目录 | 体积最大的一项；**未确认是否含唯一证据**，故保留。确认可再生后再议 |
| `D:\Repositories\littlesheep\.codex_tmp\dependency-audit` | 58.4 | 162 | 依赖审计输出 | 可由审计脚本重跑再生；保留待用户确认 |
| `D:\Repositories\littlesheep\.codex_tmp\verification-reports` | 27.9 | 365 | 历史验收报告 | 可能含某次验收的唯一证据；**必须逐个确认**，不得整目录删除 |
| `D:\Repositories\littlesheep\.codex_tmp\ls-instances` | 21.8 | 159 | 实例运行数据 | 待确认 |
| `D:\Repositories\littlesheep\.codex_tmp\electron-userdata-pending-20260805-1928` | 4.7 | 67 | Electron 用户数据暂存（2026-08-05） | 待确认 |
| `D:\Repositories\littlesheep\release` | 1326.3 | 1448 | 打包输出（`win-unpacked` 1096.3） | **保留**：SL-04 的体积基线与验收证据；其中旧 Setup.exe 仍需用于对照 |
| `D:\Repositories\littlesheep\packages\app\runtime` | 1625.8 | 294 | `prepare-littlesheep-runtime.mjs` 准备的 Electron 运行时 | **保留**：当前开发启动依赖它，且并行升级正在写入其中两个临时目录 |
| `D:\Repositories\littlesheep\packages\app\out` | 26.9 | 165 | 当前 App 构建输出 | **保留**：当前构建产物，不是缓存 |
| `D:\Repositories\littlesheep\tmp` | 9.4 | 53 | 图标等源材料 | **保留**：任务书明确不默认视为可再生 |
| `D:\Repositories\littlesheep\node_modules.link-damaged-20260804` | 0.1 | 2 | 已损坏链接的隔离目录 | 体积可忽略，不是收益点；保留（清理它可能影响 node_modules 解析） |

按此裁定，SL-07 **不发生任何字节回收**，其产出是上表（含保留理由与待确认项）。这不是"未完成"：任务书允许"仅清理已确认不再使用且可重建的项目"，而用户裁定先不删除，故本项以清单交付收尾。

**若后续要回收**，仍须遵守任务书的两条硬约束：删除前确认路径确实位于上述目标内且未通过链接跳到外部；不使用 `git clean -fdx` 或全盘通配删除。收益只能记为本地磁盘回收，**不得计入安装包或运行成本**。
