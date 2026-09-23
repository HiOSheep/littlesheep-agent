# Cache request-shape baseline

最后更新：2026-09-23 17:38:22

Freeze: git 424151a

本文件由 `packages/harness/src/probe/baseline.test.ts` 在每次 harness 测试运行时重新生成：
只统计请求字符数、共享前缀字符数与工具目录摘要，不调用供应商，也不含提示词正文或会话内容。

## Load: local-web-local

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | turn1.call1 | 7735 | 11 | - | - | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | turn2.call1 | 7852 | 11 | 3574 | 0.4621 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 3 | turn3.call1 | 7681 | 11 | 3574 | 0.4552 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |

## Load: tool-loop

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | loop.call1 | 8024 | 12 | - | - | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | loop.call2 | 8280 | 14 | 8024 | 1 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 3 | loop.call3 | 8536 | 16 | 8280 | 1 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 4 | loop.call4 | 8792 | 18 | 8536 | 1 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |

## Load: chat-versus-tool

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | tool.call1 | 7730 | 11 | - | - | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | chat.call1 | 5604 | 7 | 3557 | 0.4602 | 3444 | none |

Character counts only. No token estimate, no cost estimate, and no Provider
cache-hit evidence: this probe never calls a Provider.
