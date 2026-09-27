# 前端界面检查点 2026-09-27（大规模重构前的回滚锚点）

最后更新：2026-09-27 21:45:03

本文件记录"前端界面大规模重构之前"的确切状态与回滚方式。它不描述重构计划，也不承诺重构后界面不变；它只回答一个问题：**如果重构后的界面不如现在，怎么回到这里。**

## 1. 锚点

| 项 | 值 |
| --- | --- |
| Git 标签 | `ui-baseline-2026-09-27`（附注标签，已推送到 origin） |
| 提交 | `e601ca7e` |
| 打包时的 HEAD | 与上述提交相同；当时**没有任何未提交的前端文件**（在途的只有 SL-04 发布载荷收窄的非前端改动） |
| 平台 | win32 / x64；Electron 44.4.5（`packages/app/runtime/electron-v44.4.5-win32-x64`） |

```powershell
git fetch --tags origin
git show ui-baseline-2026-09-27^{commit} --stat --oneline | Select-Object -First 5
```

## 2. 这个"前端界面"包含什么

重构影响面应当落在这几处；回滚时也以这些路径为准：

- `packages/app/src/renderer/**`：`app-shell/`（含 `chat-view`、`app-view`、`app-controller-projections`）、`chat/`（`assistant-turn`、`agent-tool-row`、`reasoning-row`、`disclosure-panel`）、`composer/`、`sidebar/`（含 `global-titlebar`、`running-pill`）、`settings/`、`ui/`、`approval/`；
- `packages/app/src/renderer/styles/**` 与 `styles.css`：令牌化之后的圆角、cursor、消息元数据等规则；
- 定义界面契约的测试与门禁（见第 4 节）。

## 3. 回滚方式（三档，按影响面从小到大）

**A. 只把前端路径恢复到锚点**（推荐；不影响同期非前端改动）

```powershell
git checkout ui-baseline-2026-09-27 -- packages/app/src/renderer
pnpm run ensure:app-build
```

**B. 在锚点上开一个分支来对照或继续**

```powershell
git switch -c ui-from-baseline ui-baseline-2026-09-27
pnpm install && pnpm run ensure:build
```

**C. 整体回退到锚点**（会连带回退同期非前端改动，慎重）

```powershell
git revert --no-commit e601ca7e..HEAD   # 或按提交逐个 revert
```

无论哪种，改完都要 `pnpm run ensure:app-build`，否则桌面快捷方式启动的仍是旧构建（快捷方式现在会自己 `ensure:app-build`，见 `scripts/README.md`）。

## 4. 当前界面契约（重构后应逐项复跑）

| 入口 | 覆盖 |
| --- | --- |
| `pnpm run verify:desktop-cold-start` | 真实 Electron 视觉基线：`renderer-980x700` / `1280x820` / `1580x900` / `maximized` / `restored`，以及就绪态启动条；PNG 落在 `docs/reference/cold-start-baseline/screenshots/` |
| `pnpm run verify:electron-ui-state-continuity` | 阅读位置锚定、窗口状态在真实退出时的落盘、非活动工作区的 403、第二工作区跨重启往返 |
| `pnpm run verify:model-provider-ui` | 供应商/模型设置界面 |
| `pnpm run check:repo` | 样式令牌门禁（圆角走 `--radius-*`、`cursor: pointer` 只出现在允许处、`.message-meta` 规则形态等）与模块拆分地图计数 |

## 5. 视觉基线的诚实说明

现存 PNG 基线的写入时间是 **2026-09-24**，比本锚点（09-27）**早三天**：它们证明的是当时的界面，不是锚点当天的界面。因此**强烈建议在重构动手之前先刷新一次**：

```powershell
pnpm run verify:desktop-cold-start
git add docs/reference/cold-start-baseline/screenshots docs/reference/cold-start-baseline/*.json
```

刷新后请把提交号补记到本文件第 1 节，这样"重构前 vs 重构后"的图片对照才是同口径的。若重构前不刷新，就只能用代码差异（第 3 节 A）而不是图片来判断界面变化。

## 6. 边界

- 标签只是**提交指针**，不包含任何额外快照；界面资产、样式与基线 PNG 都在该提交里，所以 checkout 标签即可获得完整界面。
- 锚点**不含**未提交的工作。打包当时工作区里只有发布载荷收窄的两个非前端文件（`scripts/package-windows-release.mjs`、`scripts/lib/release-artifacts.mjs`），它们与界面无关。
- 回滚界面时**不要**一并回退同期的性能与瘦身改动：preimage/启动复用、检查点恢复移出就绪路径、脚本运行产物移出检出目录、快捷方式启动器，以及 Electron 44 升级。它们与外观无关，回退会连带丢掉已验收的启动性能与仓库洁净度。
