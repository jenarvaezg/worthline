# Performance budgets for large local workspaces

The performance audit flagged four hot paths that scale with a workspace's
history: **dashboard load**, **snapshot holding reads**, **position reads**, and
**historical snapshot ripple**. This document records the conservative budgets we
hold those paths to, the large-workspace baseline they are conservative against,
and how to change a budget on purpose (#203).

The budgets are enforced — not just documented — by the performance harness
(`tests/performance-harness.integration.test.ts`, seeded by
`tests/performance-harness-seeds.ts`, issue #200). The harness is deterministic
and network-free: it uses the file-backed SQLite store with manual prices and
valuations only (no Numista, no Yahoo, no ECB), so the same work runs every time
and a regression shows up as a timing change rather than seed drift.

## The large-workspace baseline

The budgets are conservative against a single seeded workspace whose dimensions
are recorded as `SEED_DIMENSIONS` in `tests/performance-harness-seeds.ts`. The
harness asserts the live seed equals that record, so the budgets can never
silently drift off their stated scale.

| Dimension              | Baseline | What it stresses                                     |
| ---------------------- | -------: | ---------------------------------------------------- |
| `members`              |        2 | Ownership-split fan-out across scopes                |
| `assets`               |       11 | Assets read on every dashboard load                  |
| `liabilities`          |        3 | Mortgage + revolving credit + plain debt curves      |
| `scopes`               |        3 | Capture-loop iterations (household + one per member) |
| `positions`            |        3 | Investment positions projected from operations       |
| `householdSnapshots`   |       83 | Net-worth snapshots stored for the household scope   |
| `totalSnapshots`       |      249 | Net-worth snapshots across every scope               |
| `householdHoldingRows` |    1,162 | Frozen holding rows for the household scope          |
| `totalHoldingRows`     |    2,656 | Frozen holding rows across every scope               |

These are the dimensions as `seedPerformanceWorkspace` returns, **before** the
harness runs any capture or ripple of its own. The "large" property the audit
cared about is the thousands of frozen holding rows; the harness guards a floor
on that explicitly so the seed can never quietly shrink below a meaningful scale.

## The budgets

Conservative wall-clock ceilings live in the `THRESHOLDS_MS` map in the harness.
They are deliberately loose (roughly 4–8× the observed local median) so CI
variance never makes the harness flaky — they exist to catch order-of-magnitude
regressions, not to benchmark precisely. Each audit-flagged path maps to one or
more ceilings (`BUDGETED_AUDIT_PATHS`), and the harness asserts every path stays
budgeted:

| Audit path                 | Threshold key(s)                                   | Ceiling                  |
| -------------------------- | -------------------------------------------------- | ------------------------ |
| Dashboard load             | `dashboardLoad`                                    | 3,000 ms                 |
| Snapshot holding reads     | `fullHistoryRead`, `windowedHistoryRead`           | 250 / 500 ms             |
| Position reads             | `positionProjection`                               | 250 ms                   |
| Historical snapshot ripple | `operationRipple`, `valuationRipple`, `debtRipple` | 4,000 / 4,000 / 2,500 ms |

A structural baseline snapshot (a vitest snapshot of names + ceilings + touched
counts, never raw timings) freezes _what_ is measured and at what scale, so the
set of measured operations cannot drift without a deliberate snapshot update.

## How to change a budget on purpose

1. **Locking in an optimization.** After an intentional speedup (#201 added the
   hot-read indexes; #205–#208 build further on this harness), **lower** the
   relevant ceiling in `THRESHOLDS_MS` to lock the gain in, and say so in the PR.
2. **The domain workload grows.** When the seed genuinely needs to represent a
   larger workspace, edit the seed, **re-baseline** `SEED_DIMENSIONS` to the new
   measured dimensions in the same change, and review whether the ceilings still
   hold at the larger scale. The dimensions test will fail until the baseline
   matches the live seed — that failure is the prompt to re-baseline deliberately.
3. **The set of measured paths changes.** Regenerate the structural snapshot with
   `npm test -- -u` and explain the change in the PR.

**Never raise a ceiling to silence a regression** without first understanding why
the path slowed down. A budget that only ever goes up is not a budget.

## Running the harness

```
npx vitest run tests/performance-harness.integration.test.ts
```

It runs in local and CI agent environments with no external network access.
