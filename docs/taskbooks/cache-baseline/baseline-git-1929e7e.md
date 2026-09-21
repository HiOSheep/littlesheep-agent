# Cache request-shape baseline

Freeze: git 1929e7e

## Load: local-web-local

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | turn1.call1 | 6730 | 5 | - | - | 3446 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | turn2.call1 | 6847 | 5 | 5585 | 0.8299 | 3446 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 3 | turn3.call1 | 6676 | 5 | 5585 | 0.8157 | 3446 | document_read,read,web_fetch,web_search#9c23a5b0 |

## Load: tool-loop

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | loop.call1 | 7019 | 6 | - | - | 3446 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | loop.call2 | 7317 | 8 | 7019 | 1 | 3446 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 3 | loop.call3 | 7615 | 10 | 7317 | 1 | 3446 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 4 | loop.call4 | 7913 | 12 | 7615 | 1 | 3446 | document_read,read,web_fetch,web_search#9c23a5b0 |

## Load: chat-versus-tool

- model: test
- tools: read, web_search, web_fetch, document_read

| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | tool.call1 | 6725 | 5 | - | - | 3446 | document_read,read,web_fetch,web_search#9c23a5b0 |
| 2 | chat.call1 | 5278 | 3 | 3591 | 0.534 | 3446 | none |

Character counts only. No token estimate, no cost estimate, and no Provider
cache-hit evidence: this probe never calls a Provider.
