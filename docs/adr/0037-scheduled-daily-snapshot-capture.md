# Daily snapshots are captured by a scheduled job, not only on visit

ADR 0005 calls a **snapshot** "captured automatically", but the only thing that
ever captured one was a **page render**: signing in ran `loadDashboard`, which
wrote the day's snapshot as a side effect of drawing the dashboard. So "automatic"
quietly meant "on visit". A user who does not sign in for two days has two
missing days in their **histórico** — not a recalculable gap, a genuinely absent
observation. We decided to capture each workspace's daily snapshot from a
**scheduled job that runs whether or not anyone signs in**, at a fixed wall-clock
time, so a day is recorded because the day happened, not because someone looked.

## Why a missed day is not recoverable later

Not every holding loses information equally when a day is skipped. A **modeled**
holding (an **amortized** or **revolving** debt, an **appreciating** house) has a
value that is **deterministic at any past date** — the engine already reconstructs
it on demand, which is what the **ripple** does (ADR 0012, ADR 0031). For those, a
missing day is cosmetic: the line is sparser, the trend is right. A
**market-priced** holding is different: its value on a given day is the **price
observed that day**, and we keep **no historical price series** (ADR 0033 backfills
prices only at explicit, confirmed dates). Miss the day, miss the observation —
and you cannot honestly reconstruct it, because the provider's "price" is today's,
not that day's.

So the only durable fix is to **capture forward, every day**. This is not a
re-run of the ripple engine across all of history; it is freezing **today's**
valued state — and the one irreplaceable ingredient of that state is the day's
fresh market price.

## The cadence the domain already had

ADR 0005 caps snapshots at **one per scope per day, latest wins**. A once-a-day
scheduled capture is therefore not a concession — it is exactly the cadence the
model already defines. (It also happens to match the free tier we deploy on:
Vercel Hobby cron is limited to once per day. The constraint and the domain agree.)

## What the job does, per workspace

1. **Refresh market prices**, then capture — never the reverse. Capturing without
   refreshing would freeze yesterday's stale price and add no information to
   market holdings.
2. **Capture the snapshot** per scope, through the same code a sign-in uses
   (latest-wins makes it idempotent).

It does **not** re-sync **connected sources**. Binance/Numista _balances_ change
only when the user trades, and Numista coins are **frozen** (ADR 0017); what moves
daily is the token _price_, and that arrives through step 1, revaluing the live
Binance holding (balance × fresh price). Balance sync stays **user-triggered**, and
keeps rippling event dates as before (ADR 0012) — complementary to this job, not
replaced by it.

## The price fetch is deduplicated across tenants

The bottleneck is the provider call (CoinGecko, Yahoo, Stooq), not Turso. Two
workspaces that both hold BTC must not each fetch BTC. The run makes two passes:
collect the **union** of `(provider, symbol)` across all workspaces, fetch **each
unique symbol once**, then distribute that price into every workspace's price cache
and capture. Network cost grows with **distinct symbols**, flat in number of users.
Because each workspace is its own libSQL database, there is no cross-tenant SQL
"batch" — the only lever is shared fetch plus, if N ever grows, parallelism.

## Decoupled from the render

The capture is extracted to a **pure function** shared by the cron and the render.
The render then captures **only if the day has no snapshot yet** — a no-op on
almost every load, since the cron has usually already run, and the existence check
is free (the dashboard already reads the scope's snapshots to draw the chart). This
takes the per-render write off the hot path (PRD #485) while leaving a **self-heal**:
if the cron ever fails, the next sign-in records the day. A sign-in before the
scheduled run captures a provisional intraday point; the scheduled run overwrites it
at the day's close (latest-wins), so the stored day is the **close of the day**.

## A new cross-tenant system trust path

Every other way a workspace database is opened goes through a **session** (the
Auth.js JWT) or a verified MCP token. This job has neither: it is a system actor
that lists **all** workspaces from the **control plane** and opens **every**
per-workspace database with the shared group token, no user present. That is a
deliberate, narrow boundary: the endpoint is guarded by a `CRON_SECRET` bearer
(any external scheduler that holds the token may trigger it; an anonymous caller
may not), it **only captures** — it never reads tenant data to return it — and it
needs a new control-plane method, `listAllWorkspaces()`, since enumerating globally
has never been required before.

## Timing

The job runs at **21:00 UTC** — the **close of day**, not dawn. A dawn capture
would stamp a day D with D−1's overnight close and, worse, never record the true
close of a month's last day until the 1st of the next month, breaking the
**monthly close** (ADR 0005). 21:00 UTC is past the European close, late enough to
include the US close, and far from the UTC day boundary, so Hobby's ±59-minute
scheduling imprecision can never flip the `dateKey` to the wrong day. The `dateKey`
stays UTC-derived, consistent with the render path.

## Considered options

- **Keep capture visit-gated (status quo)** — rejected: it is the bug. Absent
  users lose days that cannot be reconstructed.
- **Backfill missed days on the next sign-in** — rejected: a missed day's _market
  price_ is gone, so a backfilled point would freeze a later price onto an earlier
  date — a fabricated number. An honest gap beats an invented point; the self-heal
  covers the common (you-did-visit) case.
- **A public, unauthenticated endpoint ("the more it runs, the fresher")** —
  rejected: this is the most expensive, most rate-limit-fragile, cross-tenant-
  _mutating_ operation in the system. An open trigger is a provider-ban and
  quota-exhaustion vector that would break pricing for every real user. `CRON_SECRET`
  preserves the "any external process can trigger it" flexibility for callers that
  hold the token, and closes only the anonymous path.
- **Per-workspace price fetch (no dedup)** — rejected: provider cost and rate-limit
  exposure scale with users × symbols; the dedup keeps them flat in users.
- **Sync connected sources inside the job** — rejected: balances rarely change,
  Numista is frozen, and external APIs rate-limit; only prices move daily and they
  already flow through the dedup fetch.
- **Dawn capture** — rejected: breaks the monthly close (see Timing).
- **GitHub Action cron instead of Vercel Cron** — a viable fallback (the pattern is
  used in sibling projects and runs without the function timeout), kept in reserve.
  Vercel Cron was chosen for "integrated and free" with no second secret surface; if
  N grows past a single invocation's budget, the answer is concurrency → fan-out →
  queue, not a change of scheduler — echoing ADR 0030's "escalate the tier, don't
  re-architect".

## Consequences

- A new system trust boundary exists: a `CRON_SECRET`-guarded route that opens
  every workspace database with the group token and no session, for capture only.
- `listAllWorkspaces()` is added to the control plane.
- The render stops writing a snapshot on most loads; capture becomes a shared pure
  function (PRD #485 perf).
- The job must use the **real clock** and ignore `WORTHLINE_DEMO_NOW`; **demo**
  workspaces are ephemeral, in-memory, and never enumerated by the control plane, so
  they are skipped by construction.
- Failure is isolated per workspace — a broken tenant does not block the others'
  captures.
- The CONTEXT.md **Snapshot** entry is sharpened: "automatic" now genuinely means
  time-driven, recorded whether or not anyone signs in, finalising at the day's
  close.
