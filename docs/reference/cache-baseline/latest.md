# Cache request-shape baseline

最后更新：2026-09-26 21:16:00

Freeze: git 9203c1f1

本文件由 `packages/harness/src/probe/baseline.test.ts` 在每次 harness 测试运行时重新生成：
只统计请求字符数、共享前缀字符数与工具目录摘要，不调用供应商，也不含提示词正文或会话内容。

## Load: local-web-local

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | turn1.call1 | 8434 | 11 | - | - | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | turn2.call1 | 8551 | 11 | 3574 | 0.4238 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 3 | turn3.call1 | 8380 | 11 | 3574 | 0.418 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |

## Load: tool-loop

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | loop.call1 | 8723 | 12 | - | - | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | loop.call2 | 8979 | 14 | 8723 | 1 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 3 | loop.call3 | 9235 | 16 | 8979 | 1 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 4 | loop.call4 | 9491 | 18 | 9235 | 1 | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |

## Load: chat-versus-tool

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | tool.call1 | 8429 | 11 | - | - | 3444 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | chat.call1 | 5604 | 7 | 3557 | 0.422 | 3444 | none |

Character counts only. No token estimate, no cost estimate, and no Provider
cache-hit evidence: this probe never calls a Provider.
