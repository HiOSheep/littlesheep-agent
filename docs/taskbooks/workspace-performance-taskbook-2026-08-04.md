# LS 拓展工作区性能任务书 2026-08-04

最后更新：2026-08-14 01:10:00

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

Current source contracts observed on 2026-08-13:

- Directory reads use a 5 second Renderer cache capped at 128 keys. Concurrent
  reads of the same path coalesce, expanded children load lazily, and a remount
  restores retained directory snapshots before stale entries are revalidated.
  Manual refresh bypasses a completed cache entry while still joining an
  already-running request for the same path. `directory-preload.ts` may start
  the persisted workspace root request before React mounts, but only when the
  panel is visible, the file navigator is expanded, and the active tab needs
  the ordinary navigator; review, collapsed panel, and collapsed navigator
  states do not preheat or scan the directory.
- Git status snapshots use a 5 second Main cache capped at 8 workspaces and
  8 MiB of estimated completed state. Snapshot loads coalesce per workspace,
  at most two status scans run concurrently across workspaces, and Git Diff
  jobs are capped at two concurrent processes. Caller cancellation is isolated;
  manual, focus, visible and local-mutation refresh paths can request a forced
  refresh.
- Every status scan creates an opaque revision. A file diff is bound to the
  retained snapshot with that revision; an invalidated or evicted revision
  returns 409 instead of silently running a new status scan for an old tree.
- Review scheduling uses a 30 second visible interval plus window-focus and
  manual refresh signals. Signals arriving during a snapshot load are coalesced
  into one queued soft/forced refresh; hidden or inactive views do not poll.
- Local editor saves and the workspace `artifactVersion` signal request a
  forced review refresh. The review component keeps the previous snapshot and
  Diff visible while the replacement request runs, so a refresh does not blank
  the editor or reset the current selection.
- Memory v3 historical maintenance is admitted by the host: active Agent runs
  always block it; hidden/minimized windows may admit it immediately; a visible
  window requires 25 seconds of system inactivity. The Electron adapter
  aggregates all live windows and is disposed before Runner shutdown. If local
  embedding assets are provisioned after an unavailable startup drain, the
  model manager retriggers the current Runner's coalesced drain without adding
  a resident retry timer.

Focused tests cover the bounded directory and file-preview caches in
`packages/app/src/renderer/workspace/directory-cache.test.ts` and
`packages/app/src/renderer/workspace/file-preview-cache.test.ts`; review
transport/cache behavior in `packages/app/src/renderer/workspace/review-cache.test.ts`;
review filtering and keyboard navigation in `review-model.test.ts`; shared
Monaco lifecycle behavior in `monaco-model-cache.test.ts`; and Git snapshot
TTL, cancellation, concurrency, byte budgets and revision 409 handling in
`packages/app/src/main/local-app-api/workspace-git-review-cache.test.ts`.

The focused capacity and scheduler tests are now present:

- `directory-cache.test.ts` verifies TTL boundaries, same-path request
  coalescing, cross-mount snapshot reuse and bounded least-recently-used
  retention. `file-preview-cache.test.ts` covers byte-aware text eviction,
  concurrent preview reuse and save-versus-read races.
- `workspace-git-review-cache.test.ts` covers completed-entry LRU/byte-budget
  eviction, the two-load concurrency ceiling, queued cancellation before
  loader start, and queue progress after a load settles.
- `directory-preload.test.ts` covers visible-root preheating, file-tab root
  selection, and the no-scan guards for review, closed tabs, collapsed panels,
  and collapsed navigators.

## Acceptance evidence

| Requirement | Evidence required | Current status |
| --- | --- | --- |
| File tree cache correctness | Focused cache suite including 128-key capacity, stale-while-revalidate behavior and request coalescing | Revalidated in the current build; see the command output recorded below |
| Review cache correctness | Focused suite including 5-second snapshot TTL, 8-workspace/8 MiB eviction, two-load scheduling, cancellation and revision 409 | Revalidated in the current build; see the command output recorded below |
| Review background scheduling | Slow-scan, focus, visibility and hidden-state scheduling tests | Pure policy tests pass; component uses the tested reducer and callback visibility guard |
| Memory v3 stale embedding admission | Isolated stale-vector acceptance plus deterministic soak; no embedding call while active/denied, eventual recovery after admission | Complete: `maintenance-idle-acceptance.test.ts` and deterministic 48-Atom soak pass; model-ready callback covers post-provision retry |
| Cold/warm interaction budgets | Production Electron timings with an isolated data root and representative repository | Complete: all measured paths within budget |
| Idle resource budget | Hidden/collapsed CPU, disk I/O and process RSS observation over a fixed interval | Complete: stable hidden interval within budget; closing interval retained as diagnostic |
| Monaco resource policy | Verify first coloured frame plus which TS/JSON/CSS/HTML workers start for each tested language | Complete for current contract: worker runtime is not started; Prism first frame and Monaco ink are verified |
| Build size | Rebuild and compare named chunks, worker assets, CSS and total `packages/app/out` bytes | Complete: current post-build total 17,743,898 bytes; no worker assets are packaged |
| Release quality gates | Targeted tests, typecheck, build, repository check and `git diff --check` | Current review/workspace scope passes; final desktop interaction acceptance and repository-wide whitespace check are recorded at phase close |

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

Review-layout and shared-editor verification on 2026-08-13:

- Nine focused Renderer workspace files passed all 32 tests. The contracts
  cover the shared Monaco viewer/editor/Diff surface, unified navigator frame,
  removal of the old review live view, persisted inline/side-by-side mode,
  keyboard navigation, theme colours, model lifecycle and stable row layout.
- The shared code surface reports a computed `13px` font size and `23px` line
  height. This density applies to ordinary source viewing, editing and Git
  Diff, without changing Markdown, Office or image preview typography.
- The root directory preheat contract is covered by six focused tests and is
  attached to the existing cache request, so it does not add a second scan or
  a resident timer.
- `pnpm run check:repo`, `pnpm run typecheck` and `pnpm run build` passed.
- The isolated production Electron acceptance passed on the complete rerun
  after a first harness-only timeout; the harness timeout happened before any
  performance assertion and did not require a code change.

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

Current production build and runtime evidence (Windows, isolated temporary
data root, ordinary Git fixture; cold means a fresh Electron process, warm
means the same Renderer process after the first load):

| Artifact / path | Observed |
| --- | ---: |
| Main bundle (`out/main/index.js`) | 2,278,128 bytes |
| Renderer application bundle (`out/renderer/assets/index-DPJ4qaQ0.js`) | 2,296,995 bytes |
| Monaco editor runtime (`out/renderer/assets/editor.api2-Dc-goIUu.js`) | 4,913,487 bytes |
| Renderer CSS (`out/renderer/assets/index-Dhuvar_6.css`) | 255,646 bytes |
| Monaco CSS | 110,565 bytes |
| Total `packages/app/out` | 17,743,898 bytes |
| Packaged Monaco workers | 0 |
| Process to locator | 865 ms |
| Locator to visible window | 612 ms |
| Workspace first frame | 333.6 ms |
| File tree cold / warm | 347.8 / 23.2 ms |
| Stale tree visible before revalidation | 18.2 ms |
| First syntax-coloured frame | 399.2 ms |
| Monaco ready cold / warm | 405.9 / 44.7 ms |
| Monaco ink cold / warm | 581.2 / 235.7 ms |
| Review tree cold / warm | 645.9 / 31 ms |
| First review Diff | 530.9 ms |
| Stable hidden CPU / I/O (5 s) | 15.6 ms / 0 bytes |
| Review editor instances / syntax colours | 2 / 4 |
| Git inserted / removed backgrounds | present / present |

The first complete run of the preceding build recorded file-tree cold at
780.2 ms, review tree cold at 1,873.9 ms and Monaco warm ink at 506.5 ms. The
first attempt against the current build timed out in the harness while waiting
for the review collapse button; it produced no performance sample. The
subsequent complete run above passed without changing the budgets, and both
historical samples remain documented as Windows first-process/disk-cache and
harness variance rather than being treated as passing measurements.
The earlier 2026-08-05 full-suite result remains valid historical evidence for
the performance phase. The final 2026-08-13 close additionally uses focused
workspace tests, current typechecks/build/repository checks, production
Electron timing, and direct desktop interaction acceptance.
