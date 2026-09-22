# @littlesheep/embedding

最后更新：2026-09-22 12:47:49

本包拥有 LittleSheep 的本地文本 Embedding 实现、模型登记、离线资产检查和候选基准。Memory v3 只依赖 `EmbeddingEngine` 契约，不依赖具体推理框架。

## 职责与边界

- 公开入口是 `src/index.ts`；`local-transformers-engine.ts` 是 `EmbeddingEngine` 的本地实现（`@huggingface/transformers` **4.3.0**），`model-registry.ts` 登记模型 id、上游仓库、固定 revision、维度、dtype、前缀和逐文件字节数 + sha256，`model-assets.ts` 提供 `verifyLocalEmbeddingModel`/`provisionLocalEmbeddingModel`，`runtime.ts` 是注入式运行时封装。
- 产品运行关闭远程模型与 Transformers 文件缓存（`allowLocalModels = true`、`allowRemoteModels = false`、`useFSCache = false`），只读取经过大小和 SHA-256 校验的显式本地资产目录；不得在一次记忆写入或检索中隐式联网下载模型。Runner 只装配本地引擎（`DEFAULT_LOCAL_EMBEDDING_MODEL`），且 Memory v3 的 `assertEmbeddingPolicy` 会在引擎 `transport === 'remote'` 而未显式允许时直接拒绝，因此记忆正文默认不会发往 Provider embeddings 端点。
- 模型下载只允许由显式准备流程（`provisionLocalEmbeddingModel`）触发，模型根目录由调用方指定，不能写入源码仓库。
- Electron 迁移页通过 App 主进程控制器 `packages/app/src/main/memory-embedding-model-control.ts` 调用同一验证与准备 API，展示缺失/损坏/进度/失败/就绪状态；单实例准备可取消（`AbortController`），应用退出会中止，Renderer 不接触文件系统或任意下载地址。
- 查询与文档使用不同前缀策略；向量输出必须归一化并匹配登记维度。
- 模型不可用时返回明确错误，层级导航和 FTS 继续工作。

## 当前模型

- 默认平衡档 `bge-small-zh-v1.5`（上游 `Xenova/bge-small-zh-v1.5`，revision `75c43b06…`，BAAI 上游）：MIT，512 维，q8，量化 ONNX 24,010,842 字节（约 24 MB）；18 组基准 Recall@1 为 0.7778，Recall@3 为 0.8889，实测 RSS 增量约 106 MB。
- 可选质量档 `multilingual-e5-small`（上游 `Xenova/multilingual-e5-small`，intfloat 上游）：MIT，384 维，q8，量化 ONNX 118,308,185 字节（约 118 MB）；同一基准 Recall@1 为 0.9444，Recall@3 为 1.0，实测 RSS 增量约 505 MB。
- `DEFAULT_LOCAL_EMBEDDING_MODEL` 为 `bge-small-zh-v1.5`，由 Runner 装配时的 `LocalTransformersEmbeddingEngine` 使用；`getLocalEmbeddingModel` 是唯一的规格查询入口。

BGE 是当前平衡默认，因为向量只在层级导航和分支内 FTS 仍不足时介入；E5 保留给更看重混合语言与代码召回、且能接受更高内存占用的设备。模型选择属于运行配置，不能改变层级优先和默认断网策略。

## 验证

- 单元测试使用注入式 runtime，不下载模型（`src/local-transformers-engine.test.ts`、`src/model-assets.test.ts`）。
- 真实候选基准 `scripts/benchmark-local-embedding.mjs` 使用隔离资产目录；`--assert-no-network` 会在模型验证完成后阻断进程内网络请求，证明推理阶段完全离线。结果写入正式任务书或基准报告，不提交模型权重与缓存。
