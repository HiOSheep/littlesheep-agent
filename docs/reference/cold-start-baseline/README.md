# 桌面启动与就绪基线

本目录保存桌面启动专项的可复核原始账本、窗口截图和脚本输出。它们是带时间与环境的历史样本，不代表当前所有机器上的性能保证；当前实现状态与未完成边界以[项目状态](../../decision/project-status.md)为准。

## 当前验证入口

- `pnpm run measure:desktop-cold-start`：开发版启动分阶段计时。
- `pnpm run measure:desktop-large-history-startup`：合成大历史数据根的启动测量。
- `pnpm run measure:desktop-first-token`：真实窗口与确定性 Provider 下首个流式 token 测量。
- `pnpm run verify:desktop-cold-start`：启动页、首屏和窗口视觉状态。
- `pnpm run verify:desktop-cold-start-interaction`：启动期间窗口与工作区交互。
- `pnpm run verify:desktop-cold-start-recovery`、`pnpm run verify:desktop-cold-start-readiness-failure`：恢复与失败状态。
- `pnpm run verify:desktop-readiness-placement`：就绪进度提示布局。

具体命令和构建前置条件以根 `package.json` 为准。验证输出默认写入系统临时产物目录；运行时可用脚本的 `--out` 指定目录。

## 基线数据

根目录的 JSON 是单次测量、启动阶段、文件可用性和失败/恢复证据；`screenshots/` 中的图像与 JSON 是当时的窗口视觉快照及断言结果。文件名中的日期、profile 和 packaged 标识界定样本，不能跨环境直接比较。需要更新性能结论时，重跑对应测量并审阅报告，不要把新结果附成长篇执行流水账。

计时涉及进程启动、真实渲染首帧、会话可读和 Runtime 执行就绪等不同阶段；报告必须保留自身的口径、构建摘要与样本数。新数据根不等于操作系统冷文件缓存，不能把它描述为重启后的绝对冷启动。

历史样本和截图保留为专项基线；逐轮调优过程、已修复缺陷定位和退役任务书正文由 Git 历史恢复。产品正确性由上述验证入口负责，不由本目录中的旧截图单独证明。
