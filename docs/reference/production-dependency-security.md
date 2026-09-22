# 生产依赖安全记录

最后更新：2026-09-22 11:24:23
本次复核执行：2026-09-22（命令与结果见下）
复查日期：2026-10-06，所有者：Embedding / Electron runtime（`@xmldom/xmldom` 条目另需 Documents 所有者）

本文件记录需要在 workspace 配置精确固定的生产依赖，以及当前生产依赖审计的真实结果。每项必须给出来源、完整性、兼容边界、移除条件和复查日期；上游满足安全版本后应删除 override，而不是把临时固定永久化。

## 2026-09-22 复核与修复结果（先读这一节）

复核发现生产审计不再是零，本轮把三个 pin 上调到修复版本并完成运行时回归；修复后 `pnpm audit --prod` 报告 **No known vulnerabilities found**。

- **曾报告 `3` moderate、`10` high（346 个生产依赖），修复后为 0**。受影响的是 `adm-zip@0.6.0`（high，声明解压大小导致无界内存分配；另有解析目标符号链接的 moderate）、`sharp@0.35.0`（high，libheif：GHSA-g89c-p67h-r497、GHSA-2jg2-4ch7-h545）与 `@xmldom/xmldom@0.8.13`（10 条 moderate，含元素/属性名注入、ReDoS 与二次方复杂度）。此前记录的"0 漏洞"是 2026-08-17 与 2026-09-02 的快照，**已被本轮结果取代**。
- **本轮实际改动**：`pnpm-workspace.yaml` 的 `adm-zip` `0.6.0 → 0.6.1`、`sharp` `0.35.0 → 0.35.4`，并新增 `'@xmldom/xmldom': 0.8.15`。lockfile 与 `packages/app/src/main/electron-runtime-dependencies.test.ts` 同步更新，该测试现在把三个安全下限当作断言，防止未来静默回退。
- **`@xmldom/xmldom` 为什么用 pin 而不是靠上游**：`mammoth@1.12.x` 声明 `@xmldom/xmldom: ^0.8.6`，该范围**允许**已修复的 0.8.15，但已提交的 lockfile 一直解析到 0.8.13。pin 让"已修复版本"成为显式事实，而不是取决于 lockfile 上次刷新的时间；0.8.15 仍在 mammoth 声明范围内（0.9.x 不在）。
- **Monaco 的 `dompurify` pin 仍然必要**：npm 最新版 `monaco-editor@0.56.0` 仍精确声明 `dompurify: 3.4.8`，低于 advisory 要求的 `3.4.13`；本次复核未改动它。

## 本轮运行时回归（实际执行，不是推断）

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 生产审计 | `pnpm audit --prod` | No known vulnerabilities found（346 个生产依赖） |
| 原生图片处理 | 经 `@huggingface/transformers` 上下文加载 `sharp`，创建 PNG → resize 4×4 → 读 metadata | `sharp 0.35.4`，99 → 94 字节，尺寸正确 |
| ONNX 运行时加载 | 同一上下文加载 `onnxruntime-node` | 版本 `1.24.3`，正常加载 |
| DOCX 解析（xmldom 唯一真实消费者） | 用 `docx` 生成含中文的 DOCX，再用 `mammoth.extractRawText` 读回 | 文本逐字正确 |
| 包级回归 | `vitest run packages/documents packages/embedding` | 54 项通过（含 Office 预览、XLSX 安全回归、PDF 生成/提取） |
| 工作区类型与构建 | `tsc -b tsconfig.workspace.json` | 退出 0 |
| 实际 Electron runtime | `pnpm run verify:electron-documents`（重建 App 后运行） | `{"check":"electron-document-runtime","ok":true}`，pdf/docx/xlsx/csv 生成与 xls/tsv/pptx 读取矩阵通过 |
| 全量回归 | `vitest run` | 3160 通过、1 跳过、2 失败——两个失败是既有的 pnpm/Windows shim 脚本用例，与依赖无关 |

## 仍未验证 / 下一轮（结构性升级）

- **`@huggingface/transformers` 4.2.0 → 4.3.0 尚未执行。** registry 元数据显示 4.3.0 声明 `onnxruntime-node@1.30.0`（其自身声明 `adm-zip: ^0.6.0`）与 `sharp: ^0.35.4`，即升级后这两个 pin 有希望被自然解析的已修复版本取代。**但本机 `huggingface.co` 连接超时、且本地没有预置的 `bge-small-zh-v1.5` 资产，无法运行真实本地 Embedding 验证**；按本文件自己的规则（上调 pin 或移除 override 必须通过本地 Embedding、ONNX 加载、图片处理和实际 Electron runtime 验证），本轮**不做**这次升级。
- 解除阻塞所需：能访问 HuggingFace 的主机（或在 `--cache=` 指向的目录预置 `Xenova/bge-small-zh-v1.5@75c43b069aac4d136ba6bc1122f995fedcfd2781` 全套 sha256 校验文件）。随后执行：`pnpm --filter @littlesheep/embedding add @huggingface/transformers@4.3.0` → 更新 `packages/app` 的同一依赖与 electron 运行时断言 → `pnpm run ensure:workspace-build -- --package=@littlesheep/embedding` → `node scripts/benchmark-local-embedding.mjs --model=bge-small-zh-v1.5 --assert-no-network` 对比召回指标 → 删除 `adm-zip`/`sharp` 两个 pin → `pnpm install` → 重跑上表全部验证。
- 升级 ONNX 原生运行时（1.24.3 → 1.30.0）属于原生二进制变更，除 Embedding 外还必须覆盖实际 Electron 中的本地向量路径。

## Transformers 间接依赖

`@huggingface/transformers@4.2.0` 的依赖图解析到 `onnxruntime-node@1.24.3`。`pnpm-workspace.yaml` 使用两个精确 override 把两个已被上游间接引入的传递依赖固定在修复版本：

| 依赖 | 固定版本 | 来源与完整性 | 许可证 / Node | 原因 |
| --- | --- | --- | --- | --- |
| `adm-zip` | `0.6.1` | npm registry；lockfile integrity `sha512-Xwrja8nx9e5o2N1my4DsKCeKpdrnACyr1wtbPxBDgGzKzKyE9kRtBFA8mWldI+RVlD7CBZNWY/wQ2+ydwOR6kQ==` | MIT；Node `>=14.0` | `0.6.0` 落在 high advisory 区间（`<0.6.1`：按声明解压大小做无界内存分配），另有解析目标符号链接的 moderate advisory（`>=0.5.9 <=0.6.0`） |
| `sharp` | `0.35.4` | npm registry；lockfile integrity `sha512-n++8XWcj+jCOr2IOl7h8LbKnGBDY4aPbmprMONBNFdn0ImXqpGVv5zliDs0V9HbmbCQLpbuo2ej9rAoOQTvMDA==` | Apache-2.0；Node `>=20.9.0` | `0.35.0` 落在 high advisory 区间（`<0.35.4`：继承的 libheif 漏洞） |

兼容约束：根清单最低 Node 版本已同步为 `>=20.9.0`，与 `sharp@0.35.x` 的真实 engine 要求一致（0.35.4 同样声明 `>=20.9.0`），避免向 Node 20.0-20.8 做出错误兼容承诺。上调任一 pin 都必须通过本地 Embedding、ONNX 加载、图片处理和实际 Electron runtime 验证。

移除条件：当受支持的 Transformers/ONNX 版本在无 override 情况下自然解析到 `adm-zip>=0.6.1`，且 Transformers 对 `sharp` 的声明范围包含已修复版本时，分别删除对应 override 并重新执行生产审计和运行时验证。**当前 registry 元数据（transformers 4.3.0）看起来已满足该条件，但升级与验证尚未执行**（原因见上一节）。

## @xmldom/xmldom（Documents 间接依赖）

`packages/documents` 的 `mammoth` 用 `@xmldom/xmldom` 解析 DOCX/OOXML。advisory 覆盖 `>=0.7.0 <=0.8.14`，而 lockfile 曾长期解析到 0.8.13。

| 依赖 | 固定版本 | 来源与完整性 | 许可证 / Node | 原因 |
| --- | --- | --- | --- | --- |
| `@xmldom/xmldom` | `0.8.15` | npm registry；lockfile integrity `sha512-/5NV/vDALVFDXgLmfsy9TRCBlKwO2LNBFzpzvb9iIj+jR+eSc6DLYYvVOdivT/jm7MtU6TebYuRmzEOI7w40UA==` | MIT；Node `>=10.0.0` | 0.8.15 是 0.8 线的修复版本（0.9.x 超出 mammoth 声明的 `^0.8.6`，会变成未经验证的大版本变更） |

兼容约束：DOCX 生成与读取、Office 预览的段落/表格边界保持；本轮已用真实 DOCX 往返与实际 Electron `verify:electron-documents` 覆盖。

移除条件：`mammoth` 的自然解析结果稳定落在已修复的 0.8.x（或上游迁移到 0.9+ 并通过文档回归）时删除该 pin，并重跑文档与 Electron 验证。

## Monaco 间接依赖

`monaco-editor@0.55.1` 直接声明 `dompurify@3.2.7`；当前 npm 最新版 `monaco-editor@0.56.0` 也只把该依赖提升到 `3.4.8`，仍低于当前 advisory 要求的 `3.4.13`，因此本阶段不扩大 Monaco 升级面，而由 `pnpm-workspace.yaml` 精确固定 `dompurify@3.4.13`。lockfile 中的 integrity 与登记值一致。

| 依赖 | 固定版本 | 来源与完整性 | 许可证 | 原因 |
| --- | --- | --- | --- | --- |
| `dompurify` | `3.4.13` | npm registry；lockfile integrity `sha512-2vmYIoqjze2d+kakP8S/nS5shfsl587kzwEjcGlTdiksUVgFHnFCsLYDVj/JNqJVOQZGSYBTmuycv0PodwmnMQ==` | MPL-2.0 OR Apache-2.0 | 覆盖截至 2026-08-17 解析到的 DOMPurify XSS、配置污染、危险属性和 mutation-XSS advisory；2026-09-22 复核时 Monaco 的声明仍未达到修复版本 |

兼容约束：Monaco 的编辑器加载、语言 worker、Markdown/HTML、链接、粘贴、评论和审阅行为必须保持；实际 Electron 进程 Renderer 专项门必须使用 Monaco 解析上下文中的 DOMPurify，而不是另装测试副本。

移除条件：当受支持的 Monaco 版本自然解析到 `dompurify>=3.4.13`，且升级后的 Monaco/UI/性能门全部通过时删除 override。**2026-09-22 复核：条件未满足。**

## 本轮的边界与未决项

- 本轮**只上调 pin 与新增一个 pin**，没有升级任何直接依赖，也没有升级 ONNX 原生运行时；`@huggingface/transformers` 仍是 4.2.0，`onnxruntime-node` 仍是 1.24.3。
- 未运行本地 Embedding 推理：本机无法访问 HuggingFace，且没有预置模型资产（`--allow-download` 连接超时）。因此"图片处理"只在 `sharp` 原生调用层面验证，没有覆盖 transformers 的图像输入路径。
- 上表的运行时回归是本轮实际输出；未列出的项目（Pro 工具协议校准、其他 Provider 的模型专用校准）不属于依赖安全范围。
