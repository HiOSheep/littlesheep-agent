# RCD S2C-I — 主线集成验收

**日期：** 2026-10-17

**最终集成 HEAD：** `51eb3dd8aa306341d9c80722902082b2263a06f1`

**合并提交：** `merge: integrate S2C task outcome delivery`

## Git 关系与冲突处理

- 集成前 main：`a6ca3da1d45120658e5328b5d62e69a690a1562d`，工作树干净。
- `codex/rcd-s2c-b`：`47a21bf0b6e6b204a2bfa7d06c87e12e0bbb28ad`，是 `codex/rcd-s2c-c` 的祖先。
- `codex/rcd-s2c-c`：`ce2d7926b50d1bc57b0821b792ef29eb44bdaf84`。
- main 与 S2C-C 在 `d2c5b3d2193549057fe9e3511f66f3b2d510f0b0` 分叉。S2C-C 分支保留 S2C-B 的三个后续提交；VRS/S2B/S2C-A 共同历史没有重复 cherry-pick。
- 通过普通 `--no-ff` merge 集成，没有重置或改写历史。Git 自动合并成功。审查合并结果确认：main 的消息右键上下文菜单行为保留；S2C-C 的 Task Outcome 卡片和文件操作记录文案保留；`package.json` 同时保留 `verify:context-menus` 与 `verify:task-outcome-renderer`。

合并触及双方都修改过的 `package.json`、`packages/app/src/renderer/app-shell/chat-view.tsx` 和 `packages/app/src/renderer/chat/assistant-turn.tsx`，但没有产生文本冲突。Task Outcome API、Durable Runner 回放与历史记录使用同一结构。

## 集成验证

### 真实 Electron

- `pnpm run verify:task-outcome-renderer`：通过。层级为真实 Electron Renderer + Main/Runner + 本地受控 HTTP Provider + workspace Tools。正确、错误和未检查三个文件场景结果分别是 `passed`、`failed`、`unverified`；Renderer reload 后每个 Run 保持一个持久结果卡片。
  - 报告：`%TEMP%\ls-task-outcome-renderer-i5CBct\report.json`
  - 构建：Electron 44.4.5，input digest `c2d94b2a142ce251e8a561273747f1a8116a143f554f52d0a41d6fe6fd378da0`，output digest `cf2d86ff23d46f952e83f4891ac9da131a8fccdb9d640e4fdbb6736654faf64b`
- `pnpm run verify:context-menus`：通过 64 项 Electron 检查，剪贴板状态已恢复。
- `pnpm run verify:desktop-permission-v2`：真实 Electron/Main/Renderer Permission V2 验收通过，涵盖只读与工作区写入边界、审批和恢复、Shell 批准与精确重复授权、权限降级、过期文件观测拒绝等场景。

本地确定性 Provider 不能代表真实 Provider 的任务理解；CDP 操作不能代替物理输入设备验收。

### Runner / Harness、类型与仓库

- Task Outcome、Runner durable replay、VRS Evidence Settlement/FINALIZE、S2B 段恢复、聊天/历史/产物及 Permission V2 文件边界定向测试：17 个文件、186 项通过。包含跨进程 Runner 段恢复测试，35 项任务在恢复后没有重放已结算 Effect。
- TypeScript 类型检查：通过。
- `pnpm run check:repo`：35 项通过、0 失败、3 类 advisory；均为既有文件热点和拆分地图计数提示。
- `git diff --cached --check`：合并前通过。

### 冻结 RCD 六项

`node scripts/rcd-s0.mjs run --core --timeout-ms=120000` 在集成树上执行完成：基础设施 executed 6、blocked 0、harness error 0、not run 0；清理均成功且无残留。

| Scenario | 结果 |
|---|---|
| C02 | passed |
| C08 | passed |
| R01 | passed |
| R02 | correctly_blocked |
| L01 | partially_completed（30/35） |
| X01 | correctly_blocked |

R02 禁网分支请求数为零；X01 是副作用后结算前的受控异常注入，不是 OS 进程崩溃。账本未能取得真实 usage/cost，保持 unavailable。

机器账本：`%TEMP%\littlesheep-rcd-s0-evidence\rcd-s0b-1792209342105.json`。执行树 source HEAD 为 `a6ca3da1d45120658e5328b5d62e69a690a1562d`，临时工作树指纹为 `769319f54789ca95ecee4c18bb21b22490a078d911525eee7fc5c195add8cf68`；随后该树作为 merge commit `51eb3dd8…` 提交。

## 结果与范围

S2C-B/C 已集成 main。Durable Outcome 仍由 Runner 权威回放，Renderer 不从执行成功推导验收通过。主线原有上下文菜单和 S2C-C 结果展示同时存在。

本提交只完成 S2C-I。多存储结算的真实进程故障矩阵、文件证据时效性和 T06/T07 最终任务交付验收留在 S2C-D/E，不能把本报告视为 S2C 全部通过。
