# Cache request-shape comparison: pre-fix vs post-fix

Produced by the same probe (`packages/harness/src/probe/baseline.test.ts`) against
two checkouts, with the same frozen loads, model name, tool set and compaction
configuration:

| Report | Freeze |
| --- | --- |
| [`pre-fix-cd6cabc.md`](pre-fix-cd6cabc.md) | `cd6cabc`, the commit before this work started |
| [`baseline-git-0af62a7.md`](baseline-git-0af62a7.md) | `0af62a7`, after SP-01/02/04/05/06/07 |

## What the probe measures

Per request, from the request the client actually sends:

- `chars` — bytes of the serialized message array;
- `shared prefix (chars)` — how much of the previous request in the same load is
  literally repeated at the start of this one, i.e. how much of a prefix cache
  could be reused;
- `stable head` — bytes of the first system message above the cache boundary
  marker;
- `catalog` — advertised tool names plus a digest of their schemas.

**It never calls a Provider.** These are structural character counts. They are
not token counts, not cost, and not cache-hit evidence.

## Results

### Load A: one session, local → web → local

| Request | pre-fix chars | post-fix chars | pre-fix shared | post-fix shared | pre-fix catalog | post-fix catalog |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| turn 1 (local) | 6019 | 6730 | - | - | read+doc | read+web+doc |
| turn 2 (web) | 6159 | 6847 | 2311 (0.384) | **5585 (0.830)** | +web | same |
| turn 3 (local) | 5965 | 6676 | 2311 (0.375) | **5585 (0.816)** | read+doc | same |

- The catalog changed on every turn before (three different schemas); it is now
  one catalog across all three turns.
- Reusable prefix per turn grew 2.4× (2311 → 5585 characters). The remaining gap
  is the per-turn retrieval contract, which is stated text and must change when
  the intent changes.
- Cost: each request is ~700 characters larger because the Web schemas are now
  always advertised. That is the deliberate trade the taskbook's SP-05 asks for:
  a fixed catalog in exchange for slightly larger requests.

### Load B: one tool loop, four rounds

| Request | pre-fix chars | post-fix chars | pre-fix shared | post-fix shared |
| --- | ---: | ---: | ---: | ---: |
| round 1 | 6308 | 7019 | - | - |
| round 2 | 6606 | 7317 | 5870 (0.931) | **7019 (1.000)** |
| round 3 | 6904 | 7615 | 6168 (0.934) | **7317 (1.000)** |
| round 4 | 7202 | 7913 | 6466 (0.937) | **7615 (1.000)** |

- Before: every round diverged 438 characters in — at the Runtime tail, which was
  re-appended at a new position each round. Reuse ratio was stuck near 0.93 and
  the divergence point never moved.
- After: reuse ratio is exactly 1.000; each round repeats the whole previous
  request and only appends. The first divergence is now the newly appended
  content, which is the only thing that can differ.
- Cost: requests are ~700 characters larger on rounds 2–4, again from the fixed
  catalog. Round 1 is larger for the same reason.

### Load C: a conversational turn and a tool turn

| Request | pre-fix chars | post-fix chars | pre-fix shared | post-fix shared | pre-fix stable head | post-fix stable head |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| tool turn | 6014 | 6725 | - | - | 3430 | 3446 |
| chat turn | 3737 | 5278 | 360 (0.060) | **3591 (0.534)** | 1916 | **3446** |

- Before: the chat path rendered a different Core Flow variant and a different
  memory index paragraph, so it shared only 360 characters with the tool path —
  the identity line. Its stable head was 1916 characters against the tool path's
  3430.
- After: both paths render the same stable head (3446) and share 3591 characters.
  The remaining difference is the advertised catalog, which legitimately differs:
  a conversational turn has no tool loop.

## Converged numbers

| Metric | pre-fix | post-fix |
| --- | ---: | ---: |
| Load A reusable prefix per turn | 2311 | 5585 |
| Load B tool-round reuse ratio | 0.93 | 1.000 |
| Load C chat/tool shared prefix | 360 | 3591 |
| Load C chat stable head | 1916 | 3446 |
| Distinct tool catalogs in load A | 3 | 1 |
| Compaction request Runtime-facts block | 355 chars | 0 |

## What this does not show

- **No hit rate.** Nothing here contacts a Provider, so no cache-hit percentage
  is claimed and the 95% acceptance target is not asserted. A Provider's cache
  depends on its own state as well as prefix stability.
- **No usage completeness.** The probe's requests have no Provider usage, so the
  usage-completeness dimension SP-08 asks for is recorded as `unavailable` rather
  than reported as zero.
- **Only two freezes.** The comparison is between one pre-fix commit and one
  post-fix commit on a synthetic frozen load. It is evidence that the structural
  defects named in the taskbook are repaired; it is not a measurement of a real
  session.
- **Cost is not net-negative.** The fixed catalog makes requests larger. Whether
  that pays off depends on how many turn-to-turn prefix bytes it recovers, which
  only a real long session can measure.
