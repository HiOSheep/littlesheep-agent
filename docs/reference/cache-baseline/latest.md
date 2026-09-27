# Cache request-shape baseline

最后更新：2026-09-27 05:55:59

Freeze: git 56d4cc4c

本文件由 `packages/harness/src/probe/baseline.test.ts` 在每次 harness 测试运行时重新生成：
只统计请求字符数、共享前缀字符数与工具目录摘要，不调用供应商，也不含提示词正文或会话内容。

## Load: local-web-local

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | turn1.call1 | 8435 | 11 | - | - | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | turn2.call1 | 8552 | 11 | 3574 | 0.4237 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 3 | turn3.call1 | 8381 | 11 | 3574 | 0.4179 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |

## Load: tool-loop

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | loop.call1 | 8724 | 12 | - | - | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | loop.call2 | 8980 | 14 | 8724 | 1 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 3 | loop.call3 | 9236 | 16 | 8980 | 1 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 4 | loop.call4 | 9492 | 18 | 9236 | 1 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |

## Load: chat-versus-tool

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | tool.call1 | 8430 | 11 | - | - | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | chat.call1 | 5604 | 7 | 3557 | 0.4219 | 3444 | none |

Character counts only. No token estimate, no cost estimate, and no Provider
cache-hit evidence: this probe never calls a Provider.
