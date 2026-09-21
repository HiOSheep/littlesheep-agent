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
| turn 1 (local) | 6019 | 6885 | - | - | read+doc | read+web+doc |
| turn 2 (web) | 6159 | 7002 | 2311 (0.384) | **3574 (0.519)** | +web | same |
| turn 3 (local) | 5965 | 6831 | 2311 (0.375) | **3574 (0.510)** | read+doc | same |

- The catalog changed on every turn before (three different schemas); it is now
  one catalog across all three turns.
- The reusable prefix per turn grew 1.5× (2311 → 3574), and — more importantly —
  it is now a genuine prefix extension: the difference between two turns is the
  turn's own text plus the below-boundary sections the prompt declares, not a
  rewrite.
- Cost: each request is ~800 characters larger, because the Web schemas are now
  always advertised and the below-boundary sections travel as their own messages
  instead of being folded into the system message. That is the deliberate trade
  SP-05 and SP-02 ask for.

### Load B: one tool loop, four rounds

| Request | pre-fix chars | post-fix chars | pre-fix shared | post-fix shared |
| --- | ---: | ---: | ---: | ---: |
| round 1 | 6308 | 7174 | - | - |
| round 2 | 6606 | 7472 | 5870 (0.931) | **7174 (1.000)** |
| round 3 | 6904 | 7770 | 6168 (0.934) | **7472 (1.000)** |
| round 4 | 7202 | 8068 | 6466 (0.937) | **7770 (1.000)** |

- Before: every round diverged 438 characters in — at the Runtime tail, which was
  re-appended at a new position each round. Reuse ratio was stuck near 0.93 and
  the divergence point never moved.
- After: reuse ratio is exactly 1.000; each round repeats the whole previous
  request and only appends. The first divergence is now the newly appended
  content, which is the only thing that can differ.
- Cost: requests are ~800 characters larger on rounds 2–4, from the fixed catalog
  and from the below-boundary sections travelling as their own messages.

### Load C: a conversational turn and a tool turn

| Request | pre-fix chars | post-fix chars | pre-fix shared | post-fix shared | pre-fix stable head | post-fix stable head |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| tool turn | 6014 | 6880 | - | - | 3430 | 3444 |
| chat turn | 3737 | 5371 | 360 (0.060) | **3557 (0.517)** | 1916 | **3444** |

- Before: the chat path rendered a different Core Flow variant and a different
  memory index paragraph, so it shared only 360 characters with the tool path —
  the identity line. Its stable head was 1916 characters against the tool path's
  3430.
- After: both paths render the same stable head and share 3557 characters. In both
  the system message *is* the stable head: there is no boundary marker inside it,
  because the boundary is where it stops.

## Converged numbers

| Metric | pre-fix | post-fix |
| --- | ---: | ---: |
| Load A reusable prefix per turn | 2311 | 3574 |
| Load B tool-round reuse ratio | 0.93 | 1.000 |
| Load C chat/tool shared prefix | 360 | 3557 |
| Stable head (all loads) | 3430 | 3444 |
| Distinct tool catalogs in load A | 3 | 1 |
| Compaction request Runtime-facts block | 355 chars | 0 |
| System message that was the prompt's own stable half | no (4058 vs 2323) | **yes (2323 = 2323)** |

The reusable-prefix figure for load A is lower than an earlier reading took it to
be (5,585) because that reading counted bytes that only matched by accident: the
system message then contained the prompt's below-boundary sections, so the
"shared prefix" included text the prompt itself says belongs below the boundary.
With the boundary honoured, the request is a true prefix-extension and the
system message is exactly the sections above the boundary. The trade is honest:
fewer matching bytes, and the bytes that match are the ones the design says are
stable.

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
- **Cost is not net-negative.** The fixed catalog makes requests larger, and
  honouring the boundary turns below-boundary sections into their own messages
  rather than folding them into the system message. Whether that pays off depends
  on how many turn-to-turn prefix bytes it recovers, which only a real long
  session can measure.
