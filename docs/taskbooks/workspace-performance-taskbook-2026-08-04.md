# LS 拓展工作区性能任务书 2026-08-04

最后更新：2026-08-06 00:04:40

## Goal

Make the extension workspace feel immediate on repeated use while keeping cold
work bounded and idle CPU, memory, and I/O low. Performance work takes priority
over adding or publishing more review features.

## Guardrails

- Preserve the currently staged Git review implementation and the user's
  existing unstaged editor work.
- Do not commit, push, or refresh the desktop shortcut until this phase is
  measured and verified end to end.
- Prefer request coalescing, bounded caches, lazy work, and visibility-aware
  scheduling over new heavyweight dependencies.
- Cache only data that has a cheap, explicit invalidation path. Bound every
  cache by entry count and/or lifetime.
- Keep the renderer main bundle, Monaco assets, and packaged output within the
  existing order of magnitude; record before/after sizes.

## Initial budgets

These are acceptance targets, not claims about the current build. Measure on a
production Electron build with an isolated data root.

| Path | Cold target | Warm target | Notes |
| --- | ---: | ---: | --- |
| Root file tree visible | <= 500 ms | <= 100 ms | Root only; children load on expansion |
| Monaco first syntax-coloured frame | <= 1,500 ms | <= 250 ms | Warm means Monaco was used once in this app session |
| Git review tree visible | <= 1,500 ms | <= 250 ms | Ordinary repositories; cancellation must remain prompt |
| Hidden workspace background | near-zero sustained CPU and I/O | | No review polling while hidden/collapsed |

## Work plan

- [x] Capture the current implementation, bundle sizes, and reproducible
  cold/warm measurements.
- [x] Optimize Monaco loading and reuse without eagerly keeping unnecessary
  language services alive.
- [x] Add bounded, coalesced directory reads and preserve lazy expansion.
- [x] Add bounded, coalesced Git review snapshots/diffs with cheap invalidation
  and visibility-aware refresh.
- [x] Add focused tests for cache correctness, invalidation, cancellation, and
  request deduplication.
- [x] Run targeted tests, full typecheck/test/build/repository checks, and
  `git diff --check`.
- [x] Verify cold/warm UI paths and idle process resources in an isolated
  Electron instance; record before/after bundle sizes.
- [x] Only after all checks pass, update the phase status and prepare the
  existing review work plus performance work for one publish decision.

## Source and test audit

Current source contracts observed on 2026-08-04:

- Directory reads use a 5 second Renderer cache capped at 96 keys. Concurrent
  ordinary reads coalesce; only requests with active waiters may be reused, so
  a view reopened during abort/finally propagation cannot join an abandoned
  read. A forced read advances the entry generation so a stale in-flight
  response cannot replace or leak back to the caller instead of the refreshed
  result. A successful save clears that workspace's entries.
- Git status snapshots use a 30 second Main cache capped at 8 workspaces and
  8 MiB of estimated completed state. Snapshot loads coalesce per workspace,
  at most two status scans run concurrently across workspaces, caller
  cancellation is isolated, and save/manual/focus/visible refresh paths
  explicitly invalidate the snapshot.
- Every status scan creates an opaque revision. A file diff is bound to the
  retained snapshot with that revision; an invalidated or evicted revision
  returns 409 instead of silently running a new status scan for an old tree.
- Review scheduling uses a one-shot 30 second delay after a completed visible
  scan and queues refresh signals that arrive while a scan is running. The
  hidden-state contract now clears an armed timer on transition to hidden and
  re-checks visibility inside the callback before requesting a refresh.
- Immediate review invalidation is driven by a dedicated workspace mutation
  version instead of the general artifact version. Reply-only and read-only
  runs no longer scan Git; successful in-workspace write/edit tool events and
  local editor saves do. Shell/exec remains on focus and the 30 second fallback.
- Memory v3 historical maintenance is admitted by the host: active Agent runs
  always block it; hidden/minimized windows may admit it immediately; a visible
  window requires 25 seconds of system inactivity. The Electron adapter
  aggregates all live windows and is disposed before Runner shutdown. If local
  embedding assets are provisioned after an unavailable startup drain, the
  model manager retriggers the current Runner's coalesced drain without adding
  a resident retry timer.

Existing focused tests cover directory coalescing, forced-refresh races, save
invalidation and TTL expiry in
`packages/app/src/renderer/api/workspace-files-cache.test.ts`; review transport
refresh/revision query parameters in
`packages/app/src/renderer/api/workspace-review.test.ts`; and Git snapshot TTL,
explicit invalidation, cancellation isolation, orphan recovery and revision
409 handling in
`packages/app/src/main/local-app-api/workspace-git-review-cache.test.ts`.

The focused capacity and scheduler tests are now present:

- `workspace-files-cache.test.ts` fills 97 completed directory keys, verifies
  least-recently-used eviction, keeps active in-flight entries protected, and
  proves a zero-waiter request is not rejoined during delayed abort delivery
  (20 tests in the focused suite).
- `workspace-git-review-cache.test.ts` covers completed-entry LRU/byte-budget
  eviction, the two-load concurrency ceiling, queued cancellation before
  loader start, and queue progress after a load settles.

## Acceptance evidence

| Requirement | Evidence required | Current status |
| --- | --- | --- |
| File tree cache correctness | Focused cache suite including 96-key capacity and forced-refresh race | Complete: capacity, race, TTL and save invalidation covered |
| Review cache correctness | Focused suite including 30-second TTL, 8-workspace/8 MiB eviction, two-load scheduling, cancellation and revision 409 | Complete: 16 focused tests pass |
| Review background scheduling | Slow-scan, focus, visibility and hidden-state scheduling tests | Pure policy tests pass; component uses the tested reducer and callback visibility guard |
| Memory v3 stale embedding admission | Isolated stale-vector acceptance plus deterministic soak; no embedding call while active/denied, eventual recovery after admission | Complete: `maintenance-idle-acceptance.test.ts` and deterministic 48-Atom soak pass; model-ready callback covers post-provision retry |
| Cold/warm interaction budgets | Production Electron timings with an isolated data root and representative repository | Complete: all measured paths within budget |
| Idle resource budget | Hidden/collapsed CPU, disk I/O and process RSS observation over a fixed interval | Complete: stable hidden interval within budget; closing interval retained as diagnostic |
| Monaco resource policy | Verify first coloured frame plus which TS/JSON/CSS/HTML workers start for each tested language | Complete for current contract: worker runtime is not started; Prism first frame and Monaco ink are verified |
| Build size | Rebuild and compare named chunks, worker assets, CSS and total `packages/app/out` bytes | Complete: final post-build total 14,783,369 bytes; no worker assets are packaged |
| Release quality gates | Targeted tests, full tests, typecheck, build, repository check, recovery check and `git diff --check` | Complete for the scoped change: excluded full suite passes; one user-owned desktop-shell assertion remains intentionally excluded; targeted diff check passes |

Audit command results on 2026-08-04:

- `workspace-files-cache.test.ts` and `workspace-review.test.ts`: cache,
  transport, capacity and invalidation tests passed.
- `workspace-git-review-cache.test.ts`: TTL, revision, cancellation,
  concurrency and LRU/byte-budget tests passed after the queued scheduler was
  finalized.
- `node node_modules/typescript/bin/tsc -b tsconfig.workspace.json --pretty
  false`: passed.

Post-change focused verification on 2026-08-05:

- Renderer mutation/review policy, Monaco loader/first-frame, directory cache,
  review transport and Main review cache: 7 files, 48 tests passed.
- `node node_modules/typescript/bin/tsc --noEmit -p
  packages/app/tsconfig.web.json --pretty false`: passed.
- `node node_modules/typescript/bin/tsc -b tsconfig.workspace.json --pretty
  false`: passed.
- Memory v3 maintenance worker, idle acceptance and backend: 3 files, 29
  tests passed; the broader Memory v3/backend selection set is 10 files, 76
  tests passed.
- App background-maintenance policy and embedding-model control: 2 files, 17
  tests passed, including all-window aggregation and model-ready retrigger.
- Model-controller lifecycle and Local App API shutdown regression coverage:
  12 focused tests passed, including queued-start sealing, late provision
  results, idempotent stop identity, and HTTP close after resource rejection.
- Snapshot traversal now tolerates an atomic writer removing an entry between
  `readdir` and `lstat`; the dedicated file-policy test and the 7-case Runner
  Memory v3 integration suite both pass.
- `pnpm run verify:workspace-performance`: passed in an isolated Electron
  process; this fixture intentionally sets `memory.repositoryBackend` to `v2`,
  so it is evidence for workspace UI/cache/hidden-resource budgets only and
  is not ONNX or stale-embedding evidence.
- After the abandoned-request hardening, `workspace-files-cache.test.ts` passed
  20/20 and the rebuilt Electron acceptance passed again; the final run showed
  the stale tree in 17 ms, started revalidation in 4.6 ms and completed it in
  270.3 ms.
- `pnpm exec vitest run --exclude
  packages/app/src/renderer/chat-layout-stability.test.ts`: 286 files, 2,006
  tests passed and 1 skipped. The only excluded file is the known user-owned
  desktop-shell assertion described below.

## Memory v3 idle evidence

The expensive historical-vector path is verified separately from the UI
fixture:

- `maintenance-idle-acceptance.test.ts` creates a durable ready vector, reopens
  it with a new engine descriptor so it becomes stale, and proves that the
  initial quiet period and denied active period make zero embedding calls. Once
  admission is released, one bounded pass indexes the vector and clears the
  queue.
- `node scripts/verify-memory-v3-soak.mjs --atoms=48 --restarts=1 --runs=1
  --embedding=deterministic` passed on 2026-08-05: catalog integrity `ok`, 48
  ready vectors, 0 stale/pending vectors, max batch 16, peak RSS 126 MiB, and
  the isolated data root was removed after verification. This deterministic
  run validates lifecycle and bounded scheduling; it does not claim local
  ONNX model quality. The BGE soak remains the separate opt-in provider test.
- A read-only five-second sample of the already running formal Electron
  instance (Main/GPU/network/Renderer process tree) recorded 15.6 ms aggregate
  CPU, 0 I/O bytes and -4,096 bytes working-set delta while idle; no window or
  user data was changed.
- Targeted `git diff --check` for the performance/review files: passed. The
  repository-wide command is still blocked by unrelated pre-existing
  whitespace changes elsewhere in the shared dirty worktree.

## Measurement record

Pre-change build artifact baseline recorded before the performance rebuild:

| Artifact | Bytes |
| --- | ---: |
| Renderer main JavaScript | 2,284,477 |
| Monaco `editor.main` JavaScript | 7,295,639 |
| TypeScript worker | 13,246,900 |
| CSS worker | 1,865,590 |
| HTML worker | 1,241,161 |
| JSON worker | 839,277 |
| Renderer CSS | 263,038 |
| Monaco editor CSS | 206,313 |
| Total `packages/app/out` | 33,831,278 |

Post-change production build and runtime evidence (Windows, isolated temporary
data root, ordinary two-file Git fixture; cold means a fresh Electron process,
warm means the same Renderer process after the first load):

| Artifact / path | Observed |
| --- | ---: |
| Main bundle (`out/main/index.js`) | 2,257,864 bytes |
| Renderer application bundle (`out/renderer/assets/index-CW3uL21H.js`) | 1,728,356 bytes |
| Monaco editor runtime (`out/renderer/assets/editor.api2-BggN9QXB.js`) | 5,016,605 bytes |
| Renderer CSS (`out/renderer/assets/index-DVU_DPnB.css`) | 264,308 bytes |
| Monaco CSS | 110,565 bytes |
| Total `packages/app/out` | 14,783,369 bytes |
| Process to locator | 635 ms |
| Locator to visible window | 222 ms |
| Workspace first frame | 70.5 ms |
| File tree cold / warm | 126.8 / 9.3 ms |
| Stale tree visible before revalidation | 17 ms |
| Stale tree revalidation request / complete | 4.6 / 270.3 ms |
| Prism coloured first frame | 129.2 ms |
| Monaco ready cold / warm | 471.6 / 95.3 ms |
| Monaco ink cold / warm | 597.4 / 196.4 ms |
| Review tree cold / warm | 321 / 13.9 ms |
| First review diff | 82.1 ms |
| Stable hidden CPU / I/O (5 s) | 0 ms / 0 bytes |

The first hidden sample is kept separately because Windows may perform
one-shot close-to-background cleanup; it is not used as the sustained idle
budget. The final excluded full-suite run completed 286 of 286 files (2,006
tests passed, one skipped). The only intentionally excluded file is the
existing `packages/app/src/renderer/chat-layout-stability.test.ts` assertion
against `desktop-shell.ts`'s user-owned transparent-window options; that file
was not modified. Targeted performance/maintenance suites, typechecks,
production build, repository checks and the isolated Electron acceptance all
passed.
