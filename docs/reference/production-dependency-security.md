# 生产依赖安全记录

最后更新：2026-08-17 11:15:44

本文件只记录无法立即由上游依赖图自然修复、因而需要在 workspace 配置精确固定的生产依赖。每项必须给出来源、完整性、兼容边界、移除条件和复查日期；上游满足安全版本后应删除 override，而不是把临时固定永久化。

## Transformers 间接依赖

`@huggingface/transformers@4.2.0` 是 2026-08-17 的 npm 最新版，但其依赖图仍解析到 `onnxruntime-node@1.24.3 -> adm-zip@0.5.18`，并通过 `sharp@^0.34.5` 排除 `0.35.x`。`pnpm-workspace.yaml` 因此使用两个精确 override：

| 依赖 | 固定版本 | 来源与完整性 | 许可证 / Node | 原因 |
| --- | --- | --- | --- | --- |
| `adm-zip` | `0.6.0` | npm registry；lockfile integrity `sha512-XleryMhbuksdKtofnWZ9Sk+4CUTbms4Mb/EU32SZwToAyZ5RgVos/ki8n+yr0LWHOGKuakbXTuuYNHLQjhddgg==` | MIT；Node `>=14.0` | 修复低于 `0.6.0` 的恶意 ZIP 超大内存分配问题 |
| `sharp` | `0.35.0` | npm registry；lockfile integrity `sha512-BqvG5XbwPZ4NV0DK90d86leEECMsoa8bO0nqnKWlBDYxri4GJ7c4EDInaF6q20lTh/mATmnDIKWJFfXnoVfH5g==` | Apache-2.0；Node `>=20.9.0` | 修复低于 `0.35.0` 的继承 libvips 漏洞 |

兼容约束：根清单最低 Node 版本同步调整为 `>=20.9.0`，与 `sharp@0.35.0` 的真实 engine 要求一致，避免向 Node 20.0-20.8 做出错误兼容承诺；正式验证环境为 Node `v26.4.0` 和 Electron `36.9.5`。升级必须通过本地 Embedding、ONNX 加载、图片处理和实际 Electron runtime 验证。

移除条件：当受支持的 Transformers/ONNX 版本在无 override 情况下自然解析到 `adm-zip>=0.6.0`，且 Transformers 对 `sharp` 的声明范围包含已修复版本时，分别删除对应 override 并重新执行生产审计和运行时验证。

复查日期：2026-09-17，所有者：Embedding / Electron runtime。

## Monaco 间接依赖

`monaco-editor@0.55.1` 直接声明 `dompurify@3.2.7`。2026-08-17 的 npm 最新版 Monaco `0.56.0` 也只把该依赖提升到 `3.4.8`，仍低于当前 advisory 要求的 `3.4.13`，因此本阶段不扩大 Monaco 升级面，而由 `pnpm-workspace.yaml` 精确固定 `dompurify@3.4.13`。

| 依赖 | 固定版本 | 来源与完整性 | 许可证 | 原因 |
| --- | --- | --- | --- | --- |
| `dompurify` | `3.4.13` | npm registry；lockfile integrity `sha512-2vmYIoqjze2d+kakP8S/nS5shfsl587kzwEjcGlTdiksUVgFHnFCsLYDVj/JNqJVOQZGSYBTmuycv0PodwmnMQ==` | MPL-2.0 OR Apache-2.0 | 覆盖截至 2026-08-17 解析到的 DOMPurify XSS、配置污染、危险属性和 mutation-XSS advisory |

兼容约束：Monaco 的编辑器加载、语言 worker、Markdown/HTML、链接、粘贴、评论和审阅行为必须保持；真实 Electron Renderer 专项门必须使用 Monaco 解析上下文中的 DOMPurify，而不是另装测试副本。

移除条件：当受支持的 Monaco 版本自然解析到 `dompurify>=3.4.13`，且升级后的 Monaco/UI/性能门全部通过时删除 override。

复查日期：2026-09-17，所有者：Renderer / Monaco。
