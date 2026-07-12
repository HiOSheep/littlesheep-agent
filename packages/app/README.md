# @littlesheep/app

LittleSheep 的 Electron 桌面应用。Agent Runner、记忆、工具、会话和可选渠道在主进程中装配；React renderer 通过 loopback Local App API 与主进程通信。

## 开发

从仓库根目录执行：

```powershell
pnpm install
pnpm --filter @littlesheep/app dev
```

完整构建和桌面快捷方式刷新使用：

```powershell
pnpm --filter @littlesheep/app build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\refresh-desktop-shortcut.ps1
```

根目录的 `build-app.bat` 已把这两步集中到 `scripts/build-app.ps1`，并且不依赖固定仓库路径。应用构建输出位于 `packages/app/out/`，只保留在本机供 Electron 启动，不进入 Git。

## 运行边界

1. 主进程在 `src/main/index.ts` 初始化用户数据、配置、密钥、Runner、会话/项目索引和 Local App API。
2. `src/main/local-app-api-server.ts` 提供本地 UI、流式执行、设置、记忆树、项目、工作区和终端接口。
3. `src/preload/` 只暴露 renderer 必需的桥接信息。
4. `src/renderer/` 负责聊天、侧边栏、设置、归档、记忆树、执行过程和拓展工作区。
5. 外部渠道由 `@littlesheep/gateway` 和 `packages/channels/*` 提供，不是本地 UI 的必要依赖。

## 重要入口

| 路径 | 职责 |
| --- | --- |
| `src/main/index.ts` | Electron 主进程启动和退出。 |
| `src/main/local-app-api-server.ts` | Local App API、SSE、工作区和终端。 |
| `src/main/keychain.ts` | API key 安全存储。 |
| `src/main/workspace-*.ts` | 工作区布局、产物、文件路由和 shell。 |
| `src/renderer/App.tsx` | 主 UI 编排。 |
| `src/renderer/TraceCard.tsx` | TaskBook、工具和验证过程。 |
| `src/renderer/MemoryTreeView.tsx` | 真实记忆树控制面。 |
| `src/renderer/api.ts` | Local App API 客户端。 |
| `src/renderer/styles.css` | 共享深灰视觉和交互规范。 |

## 验证

从仓库根目录运行：

```powershell
pnpm.cmd --filter @littlesheep/app typecheck
pnpm.cmd --filter @littlesheep/app build
pnpm.cmd run verify:app-recovery
```

涉及公共事件、持久化、权限或恢复时，还必须运行根目录的全量测试、typecheck 和 build。用户数据默认位于 `C:\Users\<用户名>\.littlesheep`，应用代码和仓库维护脚本不得擅自迁移或重写它。
