# 生产依赖安全记录

最后更新：2026-09-22 10:56:22
本次复核执行：2026-09-22（命令与结果见下）
复查日期：2026-10-06，所有者：Embedding / Electron runtime（`@xmldom/xmldom` 条目另需 Documents 所有者）

本文件记录需要在 workspace 配置精确固定的生产依赖，以及当前生产依赖审计的真实结果。每项必须给出来源、完整性、兼容边界、移除条件和复查日期；上游满足安全版本后应删除 override，而不是把临时固定永久化。

## 2026-09-22 复核结果（先读这一节）

本次实际执行 `pnpm audit --prod --json`、`pnpm why <pkg> --prod`，并查询 npm registry 元数据。结果如下：

- **生产依赖审计不再为零**：本次报告 `3` 个 moderate、`10` 个 high、`0` 个 critical；生产依赖数为 `346`。受影响的生产依赖是 `@xmldom/xmldom@0.8.13`、`sharp@0.35.0` 与 `adm-zip@0.6.0`。此前记录的"0 漏洞"是 2026-08-17 与 2026-09-02 的快照，**已被本次结果取代**；不得再以"生产依赖当前无漏洞"表述。
- **本文件登记的两个 pin 已经低于修复版本，必须上调**：`adm-zip` 的 high advisory 覆盖 `<0.6.1`（声明解压大小导致的无界内存分配），当前 pin `0.6.0` 落在受影响区间；`sharp` 的 high advisory 覆盖 `<0.35.4`（libheif 相关，GHSA-g89c-p67h-r497、GHSA-2jg2-4ch7-h545），当前 pin `0.35.0` 落在受影响区间。**本次只做了复核，没有修改 `pnpm-workspace.yaml`，两个 pin 仍是旧值。**
- **新发现、尚无 override 的生产依赖**：`@xmldom/xmldom@0.8.13` 经 `mammoth@1.12.0` 由 `@littlesheep/documents` 引入，advisory 覆盖 `<=0.8.14`。它不在原有登记范围内，也还没有处置决定；需要升级 `mammoth` 或补一条精确 pin，并重新执行文档解析回归。
- **上游元数据已满足两个 override 的移除条件，但未执行升级**：当前 npm 最新版 `@huggingface/transformers@4.3.0` 声明 `onnxruntime-node@1.30.0`（其自身声明 `adm-zip: ^0.6.0`）与 `sharp: ^0.35.4`。也就是说，把 Transformers 升到 4.3.0 后，`adm-zip` 与 `sharp` 有可能在不使用 override 的情况下自然解析到已修复版本。**本次没有升级依赖，也没有运行本地 Embedding、ONNX 加载、图片处理与 Electron runtime 验证**，因此不能据此宣布 override 可以移除。
- **Monaco 的 `dompurify` override 仍然必要**：npm 最新版 `monaco-editor@0.56.0` 仍精确声明 `dompurify: 3.4.8`，低于 advisory 要求的 `3.4.13`。

## Transformers 间接依赖

`@huggingface/transformers@4.2.0` 的依赖图解析到 `onnxruntime-node@1.24.3 -> adm-zip@0.5.18`，并通过 `sharp@^0.34.5` 排除 `0.35.x`。`pnpm-workspace.yaml` 因此使用两个精确 override：

| 依赖 | 固定版本 | 来源与完整性 | 许可证 / Node | 原因 |
| --- | --- | --- | --- | --- |
| `adm-zip` | `0.6.0` | npm registry；lockfile integrity `sha512-XleryMhbuksdKtofnWZ9Sk+4CUTbms4Mb/EU32SZwToAyZ5RgVos/ki8n+yr0LWHOGKuakbXTuuYNHLQjhddgg==` | MIT；Node `>=14.0` | 修复低于 `0.6.0` 的恶意 ZIP 超大内存分配问题。**该值现已低于 `<0.6.1` 的修复线，待上调。** |
| `sharp` | `0.35.0` | npm registry；lockfile integrity `sha512-BqvG5XbwPZ4NV0DK90d86leEECMsoa8bO0nqnKWlBDYxri4GJ7c4EDInaF6q20lTh/mATmnDIKWJFfXnoVfH5g==` | Apache-2.0；Node `>=20.9.0` | 修复低于 `0.35.0` 的继承 libvips 漏洞。**该值现已低于 `<0.35.4` 的修复线，待上调。** |

兼容约束：根清单最低 Node 版本已同步为 `>=20.9.0`，与 `sharp@0.35.x` 的真实 engine 要求一致，避免向 Node 20.0-20.8 做出错误兼容承诺。上调任一 pin 都必须通过本地 Embedding、ONNX 加载、图片处理和实际 Electron runtime 验证。

移除条件：当受支持的 Transformers/ONNX 版本在无 override 情况下自然解析到 `adm-zip>=0.6.1`，且 Transformers 对 `sharp` 的声明范围包含已修复版本时，分别删除对应 override 并重新执行生产审计和运行时验证。**当前 registry 元数据（transformers 4.3.0）看起来已满足该条件，但升级与验证尚未执行。**

## Monaco 间接依赖

`monaco-editor@0.55.1` 直接声明 `dompurify@3.2.7`；当前 npm 最新版 `monaco-editor@0.56.0` 也只把该依赖提升到 `3.4.8`，仍低于当前 advisory 要求的 `3.4.13`，因此本阶段不扩大 Monaco 升级面，而由 `pnpm-workspace.yaml` 精确固定 `dompurify@3.4.13`。lockfile 中的 integrity 与登记值一致。

| 依赖 | 固定版本 | 来源与完整性 | 许可证 | 原因 |
| --- | --- | --- | --- | --- |
| `dompurify` | `3.4.13` | npm registry；lockfile integrity `sha512-2vmYIoqjze2d+kakP8S/nS5shfsl587kzwEjcGlTdiksUVgFHnFCsLYDVj/JNqJVOQZGSYBTmuycv0PodwmnMQ==` | MPL-2.0 OR Apache-2.0 | 覆盖截至 2026-08-17 解析到的 DOMPurify XSS、配置污染、危险属性和 mutation-XSS advisory；2026-09-22 复核时 Monaco 的声明仍未达到修复版本 |

兼容约束：Monaco 的编辑器加载、语言 worker、Markdown/HTML、链接、粘贴、评论和审阅行为必须保持；实际 Electron 进程 Renderer 专项门必须使用 Monaco 解析上下文中的 DOMPurify，而不是另装测试副本。

移除条件：当受支持的 Monaco 版本自然解析到 `dompurify>=3.4.13`，且升级后的 Monaco/UI/性能门全部通过时删除 override。**2026-09-22 复核：条件未满足。**

## 本次未执行的事项

- 未修改任何 override、未升级任何依赖、未改动 lockfile。
- 未运行本地 Embedding / ONNX / 图片处理 / Electron runtime 验证，因此上调 pin 或移除 override 都还没有运行时证据。
- `@xmldom/xmldom` 尚未选择处置方案（升级 `mammoth`、补精确 pin，或接受并记录风险）。
