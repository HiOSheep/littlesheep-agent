# RCD S3B — Real Provider Evaluation Protocol

This evaluator is an overlay on the frozen product commit `d5015136ca9cf9583423361263b5bacba257a385`. Runtime, Harness, Tools, permission policy, prompts, and task oracles are not changed by S3B.

## Evidence tiers

- **A — controlled Provider:** deterministic scripted responses or injected local fake HTTP responses. This measures Runtime and evaluator wiring only; it is not model task-completion quality.
- **B — real model:** an explicitly configured Provider sends live requests and independently evaluates isolated synthetic task outputs. This is the only tier that can measure model-selected actions.
- **C — product comparison:** out of scope for S3B.

S3A's four controlled adapters and their original oracles remain frozen. Additional task adapters are maintained as a separate S3B extension. The original twelve task definitions and all historical baseline ledgers remain unchanged.

## Provider profile and privacy

`node scripts/s3b-eval.mjs --preflight` reads the following process environment without sending a request: `S3B_PROVIDER_ID`, `S3B_MODEL`, `S3B_API_PROTOCOL`, `S3B_BASE_URL`, `S3B_API_KEY`, `S3B_MAX_PHYSICAL_REQUESTS`, `S3B_MAX_OUTPUT_TOKENS`, `S3B_MAX_COST_USD`, and `S3B_PROVIDER_BILLING_CAP_CONFIRMED=true`. The supported wire protocols are the existing LLM package's OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages adapters. External endpoints must use HTTPS; plain HTTP is accepted only for loopback fixtures.

Preflight prints only the endpoint origin and sanitized model settings. It never prints a key, Authorization header, request body, prompt, or full endpoint path. Temperature and output-token limits are observed on actual requests. The current Harness request contract does not expose `top_p` or `seed`, so these are recorded as unsupported/unset rather than inferred.

Live calls also require the explicit run acknowledgement `S3B_REAL_PROVIDER_AUTHORIZED=I_AUTHORIZE_THIS_EVALUATION_RUN`, an explicit positive request and cost budget, and confirmation that a provider-side billing cap is configured. This software guard supplements but does not replace direct user authorization in the active task. The local runner enforces physical HTTP request count and maximum output tokens; it cannot independently enforce a USD charge limit. Provider billing usage/cost remains `unavailable` unless the Provider returns an authoritative billing receipt.

## Measurement contract

- Physical Provider requests are counted at the injected fetch boundary, including retries; requests blocked before dispatch are recorded separately.
- Logical model requests count `chat` and `chatStream` calls.
- Tool proposals count tool calls returned by the Provider.
- Tool executions and denied calls come from Runner `toolInvocations`; proposal count is never substituted for execution count.
- Settled Effects come from Runner's side-effect evidence. Unknown Effects remain separate and cannot count as successful task outcomes.
- Provider Usage comes only from `onProviderResponse` receipts (and actual embedding usage if used). Missing receipts remain unavailable/partial.
- Agent Web requests are recorded independently from Provider HTTP calls. Offline/loopback task policies are verified separately.
- Approval counts come from the trusted approval callback invocation count. If the execution path does not expose the count, it is `unavailable`.
- Each record includes one independent Oracle result, a failure attribution with evidence, a sanitized Provider profile, environment/config fingerprints, and cleanup status.

No full prompt, response body, API credential, private user data, or unrestricted tool output belongs in the report. Task workspaces contain synthetic fixtures only. The app's host Shell remains outside an OS sandbox, so these trials do not claim host process containment.

## Commands

- `node scripts/s3b-eval.mjs --preflight` — sanitized configuration readiness; no network.
- `node scripts/s3b-eval.mjs --verify-provider-metering` — local fake HTTP checks; no external network.
- Controlled task and real task commands are added in the S3B-2 evaluator commit after the task adapters are ready.

## Current live-run status

No real Provider request is made during S3B-1 or S3B-2 without direct user authorization and an explicit budget. Until that authorization is supplied, the live result must remain `real_provider_pending`; controlled trials are reported separately.
