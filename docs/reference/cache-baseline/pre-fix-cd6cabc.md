# Cache request-shape baseline

最后更新：2026-09-22 02:10:00

本文件是一次冻结对比的结构基线副本：只含请求字符数、共享前缀字符数与工具目录摘要，不含提示词正文、会话内容或密钥。

Freeze: pre-fix (cd6cabc)

## Load: local-web-local

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | turn1.call1 | 6019 | 4 | - | - | 3430 | document_read,read#3e86180d |
| 2 | turn2.call1 | 6159 | 4 | 2311 | 0.384 | 3453 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 3 | turn3.call1 | 5965 | 4 | 2311 | 0.3752 | 3430 | document_read,read#3e86180d |

## Load: tool-loop

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | loop.call1 | 6308 | 5 | - | - | 3430 | document_read,read#3e86180d |
| 2 | loop.call2 | 6606 | 7 | 5870 | 0.9306 | 3430 | document_read,read#3e86180d |
| 3 | loop.call3 | 6904 | 9 | 6168 | 0.9337 | 3430 | document_read,read#3e86180d |
| 4 | loop.call4 | 7202 | 11 | 6466 | 0.9366 | 3430 | document_read,read#3e86180d |

## Load: chat-versus-tool

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | tool.call1 | 6014 | 4 | - | - | 3430 | document_read,read#3e86180d |
| 2 | chat.call1 | 3737 | 3 | 360 | 0.0599 | 1916 | none |

Character counts only. No token estimate, no cost estimate, and no Provider
cache-hit evidence: this probe never calls a Provider.
