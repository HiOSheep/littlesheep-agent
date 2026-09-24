# 生产依赖安全记录

最后更新：2026-09-24 20:56:17
本次复核执行：2026-09-22（命令与结果见下）
复查日期：2026-10-06，所有者：Embedding / Electron runtime（`@xmldom/xmldom` 条目另需 Documents 所有者）

本文件记录需要在 workspace 配置精确固定的生产依赖，以及当前生产依赖审计的真实结果。每项必须给出来源、完整性、兼容边界、移除条件和复查日期；上游满足安全版本后应删除 override，而不是把临时固定永久化。

## 2026-09-22 复核与修复结果（先读这一节）

复核发现生产审计不再是零。本轮先补齐安全下限，再把 `@huggingface/transformers` 升到能自然解析修复版本的版本，并完成运行时回归；最终 `pnpm audit --prod` 报告 **No known vulnerabilities found**。

- **曾报告 `3` moderate、`10` high（346 个生产依赖），现为 0**。受影响的是 `adm-zip@0.6.0`（high：按声明解压大小做无界内存分配；另有解析目标符号链接的 moderate）、`sharp@0.35.0`（high：继承的 libheif 漏洞，GHSA-g89c-p67h-r497、GHSA-2jg2-4ch7-h545）与 `@xmldom/xmldom@0.8.13`（10 条 moderate：元素/属性名注入、ReDoS 与二次方复杂度）。此前记录的"0 漏洞"是 2026-08-17 与 2026-09-02 的快照，**已被本轮结果取代**。
- **结构性升级（本轮主体）**：`@huggingface/transformers` **4.2.0 → 4.3.0**（`packages/app` 与 `packages/embedding` 同步）。它声明 `onnxruntime-node@1.30.0`（其自身声明 `adm-zip: ^0.6.0`，自然解析到 0.6.1）与 `sharp: ^0.35.4`，因此**删除了 `adm-zip` 与 `sharp` 两个 override**，而不是把临时 pin 永久化。原生运行时同批从 1.24.3 升到 1.30.0。
- **保留两个 pin**：`dompurify: 3.4.13`（Monaco 最新版仍只声明 3.4.8）与新增的 `'@xmldom/xmldom': 0.8.15`。
- **`@xmldom/xmldom` 为什么仍需 pin**：`mammoth@1.12.x` 声明 `^0.8.6`，该范围**允许**已修复的 0.8.15，但已提交的 lockfile 长期解析到 0.8.13。pin 让"已修复版本"成为显式事实，而不是取决于 lockfile 上次刷新的时间；0.8.15 仍在 mammoth 范围内（0.9.x 不在）。
- **`packages/app/src/main/electron-runtime-dependencies.test.ts` 同步为守卫**：断言 app 侧 Transformers 版本、`dompurify` 与 `@xmldom/xmldom` 下限，并断言 overrides 段**不再**出现 `adm-zip`/`sharp`（防止把已可自然解析的依赖重新钉住而掩盖上游漂移）。
- **一次真实的安装故障与处置（记录以免重踩）**：`pnpm install` 曾报 `No matching version found for @huggingface/tokenizers@^0.2.0`，而 `pnpm view` 能看到 0.2.0 —— 原因是 registry 的**安装用（abbreviated）packument 仍是被 CDN 缓存的旧副本**。处置：`pnpm cache delete '@huggingface/tokenizers' '@huggingface/transformers'` 后重装成功。另外本机需要经系统代理访问外网与 `huggingface.co`。

## 本轮运行时回归（实际执行，不是推断）

| 验证 | 执行方式 | 结果 |
| --- | --- | --- |
| 生产审计 | `pnpm audit --prod` | No known vulnerabilities found（346 个生产依赖） |
| 本地向量质量（升级前基线，4.2.0 + ONNX 1.24.3） | `benchmark-local-embedding.mjs --model=bge-small-zh-v1.5 --assert-no-network` | recall@1 **0.7778**、recall@3 **0.8889**、MRR **0.8352**（512 维、q8、模型 24,010,842 字节） |
| 本地向量质量（升级后，4.3.0 + ONNX 1.30.0） | 同一命令、同一离线资产 | recall@1 **0.7778**、recall@3 **0.8889**、MRR **0.8370**；逐查询仅 q2 由第 6 名升到第 5 名，其余名次不变；维度/量化/模型字节数完全一致 |
| **真实 Electron 内本地推理** | 用 `run-verified-electron.mjs` 在 Electron 36.9.5（Node 22.19.0）里跑 Transformers feature-extraction，`allowRemoteModels=false` 读本地资产 | 管道创建成功，输出 **512 维**向量，自相似 1.0000、跨句相似 0.3758 |
| 原生图片处理 | 经 Transformers 上下文加载 `sharp`：创建 PNG → resize 4×4 → 读 metadata | `sharp 0.35.4`，尺寸正确 |
| 原生 ZIP | 同一上下文加载 `adm-zip`：写入并读回一个条目 | `adm-zip 0.6.1`，内容逐字正确 |
| ONNX 运行时 | 同一上下文加载 `onnxruntime-node` | 版本 `1.30.0`，正常加载 |
| DOCX 解析（xmldom 唯一真实消费者） | `docx` 生成含中文文档 → `mammoth.extractRawText` 读回 | 文本逐字正确，`@xmldom/xmldom` DOMParser 可用 |
| 包级回归 | `vitest run packages/documents packages/embedding packages/context` | 110 项通过 |
| 工作区类型与构建 | `tsc -b tsconfig.workspace.json` | 退出 0 |
| 实际 Electron 文档运行时 | `pnpm run verify:electron-documents`（重建 App 后） | `{"check":"electron-document-runtime","ok":true}`，pdf/docx/xlsx/csv 生成与 xls/tsv/pptx 读取矩阵通过 |
| 全量回归 | `vitest run` | 3160 通过、1 跳过、2 失败——两个失败都是既有的 pnpm/Windows shim 脚本用例，与依赖无关 |

**离线证明**：向量质量两次都在 `--assert-no-network` 下运行（脚本会在运行时把 `globalThis.fetch` 换成抛错实现并统计被拦截的尝试），说明 Embedding 完全使用本地已校验资产，没有隐式联网。

## 当前 pin 清单

| 依赖 | 固定版本 | 来源与完整性 | 许可证 / Node | 原因 | 移除条件 |
| --- | --- | --- | --- | --- | --- |
| `dompurify` | `3.4.13` | npm registry；lockfile integrity `sha512-2vmYIoqjze2d+kakP8S/nS5shfsl587kzwEjcGlTdiksUVgFHnFCsLYDVj/JNqJVOQZGSYBTmuycv0PodwmnMQ==` | MPL-2.0 OR Apache-2.0 | Monaco 的声明（最新 0.56.0 仍为 `3.4.8`）低于修复版本 | 受支持的 Monaco 自然解析到 `>=3.4.13`，且 Monaco/UI/性能门通过 |
| `@xmldom/xmldom` | `0.8.15` | npm registry；lockfile integrity `sha512-/5NV/vDALVFDXgLmfsy9TRCBlKwO2LNBFzpzvb9iIj+jR+eSc6DLYYvVOdivT/jm7MtU6TebYuRmzEOI7w40UA==` | MIT；Node `>=10.0.0` | mammoth 的 `^0.8.6` 允许已修复版本，但 lockfile 曾长期停在 0.8.13 | mammoth 的自然解析稳定落在已修复的 0.8.x（或上游迁到 0.9+ 并通过文档回归） |

**已删除的 pin**：`adm-zip`（原 0.6.0）与 `sharp`（原 0.35.0）。删除依据是 Transformers 4.3.0 的声明范围自然解析到 `adm-zip@0.6.1`（经 onnxruntime-node 1.30.0）与 `sharp@0.35.4`，并且上面的离线向量与 Electron 推理回归已通过。守卫测试会阻止它们被重新钉住。

## 需要持续保留的许可证记录（原《网络检索供应链审查 2026-08-29》并入，2026-09-24）

`pnpm.cmd licenses list --prod` 除常见 MIT/Apache/BSD/ISC 外，还包含以下组合或替代许可证，发布材料与依赖升级时必须持续保留记录：

| 依赖 | 清单中的许可证表达 | 处理要求 |
| --- | --- | --- |
| `pako` | MIT AND Zlib | 保留两份通知要求，升级时复核 |
| `jszip` | MIT OR GPL-3.0-or-later | 选择并记录实际分发所依据的许可路径，发布包附带 notices |
| `dompurify` | MPL-2.0 OR Apache-2.0 | 记录采用的许可路径并保留相应通知 |
| `@img/sharp-win32-x64` | Apache-2.0 AND LGPL-3.0-or-later | 评估平台可选依赖是否进入发布包，保留 LGPL 履行材料 |

唯一已知识别缺口是 `khroma@2.1.0`：其 manifest 缺 `license` 字段，工具报 `Unknown`，已从包内 `license` 文件核验为 MIT（由 `@littlesheep/app → mermaid@11.17.2` 引入）。该核验只澄清当前依赖的许可证文本，最终发行包仍须包含所需 notices 并由发布责任人核对。`@littlesheep/web` 本身没有引入第三方 HTTP 客户端或 HTML 抽取依赖（边界与复核条件见[网络检索安全合并验收](web-retrieval-security-acceptance-2026-08-29.md)）。

兼容约束：根清单最低 Node 版本为 `>=20.9.0`，与 `sharp@0.35.x` 的真实 engine 要求一致（0.35.4 同样声明 `>=20.9.0`）；Electron 打包继续包含 `onnxruntime-node`、`sharp` 与 `@huggingface/transformers`。任何原生依赖变更都必须重跑本节的离线向量与 Electron 推理两项。

## 本轮未覆盖的部分

- 向量质量只对比了同一个 18 文档 / 18 查询的合成语料，且都在 q8 量化下；未做长时间、真实用户记忆规模的召回评估。
- Electron 内推理用的是临时探针（已删除）读取基准目录里的模型资产，不是走完整应用流程（记忆写入 → 检索）的端到端路径。
- Pro 工具协议与其他实际启用 Provider 的模型专用校准不属于依赖安全范围，未在本轮重跑。
