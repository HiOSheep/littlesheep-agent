# Electron Preload

最后更新：2026-09-28 23:56:31

onWindowChrome 通过固定 window-chrome 通道订阅 Main 签发的布局和材质事实，先订阅再查询并重放缓存，覆盖最大化恢复和页面重载；只接受 shared/window-chrome-contracts.ts 校验过的状态。返回退订函数，不暴露设置窗口状态或原生材质的任意 IPC。

Preload 只通过安全的 context bridge 暴露 renderer 启动所需的最小运行时信息。

## 边界

- 入口是 `index.ts`；暴露面是固定形状的 `window.littlesheep`。
- 就绪契约：`localApiBase()` 等待 Main 报告 Local App API 端口（有界 90 秒）后返回 `http://127.0.0.1:<port>`，不再在加载时快照 `LITTLESHEEP_API_PORT`——启动页与正式 renderer 共用同一 preload，端口当时还不存在。
- 只读就绪桥：`getRuntimeReadiness()` 查询当前快照（订阅后补读，补回错过的通知），`onRuntimeReadiness()` 返回退订函数；载荷由 `../shared/runtime-readiness-contracts.ts` 的 `isRuntimeReadiness` 复核，仅接受 `apiVersion === 1`。
- `retryExecution()`：转达 Main 对失败执行阶段的有界重试**决定**（`accepted` / `attemptsUsed` / `attemptsRemaining` / `refusedBecause`）。preload 不实现预算、不重试、不缓存结果，只把 Main 的回答原样交给 renderer，避免出现"界面显示重试了、Main 其实拒绝了"。
- `reportRendererTiming(stage, durationMs)` 只转发 `../shared/runtime-readiness-ipc.ts` 白名单内的阶段名与有界毫秒数，用于启动计时，不接收任意字符串或任意数值。
- `getPathForFile` 经 Electron `webUtils` 取本地路径，失败返回空串。
- 只读事件桥：`onBrowserOpenNewTab`（只转发 HTTP(S) 载荷，返回退订函数）和 `onApplicationStateFlush`（监听器返回后回发 ACK；500 ms 超时归 `../main/desktop-shell.ts`）。
- 窗口拖拽只暴露 `startWindowDrag`/`moveWindowDrag`/`endWindowDrag` 三个固定通道；点结构由 Main 用 `../shared/window-drag-contracts.ts` 的 `isWindowDragPoint` 复核。
- `setWindowAppearance(isDark)` 只传递 Renderer 已解析的深浅文字模式；Main 将其限定用于原生标题栏前景和不透明窗口底色，并校验载荷及发送窗口，不暴露任意颜色或原生窗口设置。
- 通道名与载荷类型只从 `../shared/*-contracts.ts` 读取；不直接暴露 Node.js、文件系统、shell、密钥或任意 IPC。
- 业务请求统一走 Local App API；renderer 侧统一经 `../renderer/api/common.ts` 的 `localApiFetch` 发出，未就绪时不请求端口 0。

## 验证

- 验证按风险分级：只有跨进程契约、暴露面（`contextBridge` API 形状）或生命周期变化时才要求 App typecheck 和 build，并检查 renderer 在 `contextIsolation` 下正常启动；纯内部调整跑定向测试即可。
- 无法证明改动没碰到契约或暴露面时按上一档处理；`skipped` 不等于通过，也不能用旧结果放行没有重跑的检查。
- 禁止把 preload 作为绕过权限或 Local App API 契约的捷径。
