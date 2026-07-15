# Maintainer alerts are control-plane-only

When the assistant diagnoses a "this figure is wrong" complaint (PRD #1048), the
calculation trace (#1049) sometimes shows that the config is right and the engine
still diverges — a real worthline bug hiding under the friction of modeling
(#1042). Today nobody hears about it: the user is helped, the figure is repaired,
and the underlying defect stays invisible. These signals are a MAINTAINER concern,
not a user-facing data-quality signal, and they carry forensic material about a
specific workspace — a config snapshot, the full calculation trace, the declared
figure, a conversation pointer, and structured data extracted from the user's
document.

That forensic material must never be exportable with a workspace. A per-workspace
alert table would ride along in any future workspace export or transfer, leaking
maintainer diagnostics between tenants. The alert is also decoupled from repair:
the fix must ship regardless of whether the alert persists (framing of map #1033).

## Decision

Maintainer alerts live ENTIRELY in the control plane (ADR 0030) — index plus
per-occurrence payload — never in a workspace database. No workspace export can
drag maintainer material out.

The assistant's only path to an alert is the chat tool `raise_maintainer_alert`,
separate from the proposal path. The tool assembles the forensic payload
DETERMINISTICALLY from the read store (config snapshot + the S1 calculation trace),
so the model never re-types the engine's arithmetic into the alert (the lesson of
#1034). The model supplies only its diagnosis, the declared figure, and any
structured data extracted from the document — never the binary (process-and-discard
of #865 stays intact).

There are three categories: `infidelity` (a persisted figure the current config no
longer reproduces — the #1042 class), `residual` (an unexplained residual above the
documented modeling tolerance after normalizing the magnitude and verifying config),
and `sync_source` (the smell is a connected-source/sync ownership problem, not a
worthline calc bug).

The modeling tolerance is documented as a constant so a "difference" below it reads
as modeling friction, not a defect: `max(1 €, 0.05 % of |balance|)` in integer minor
units (`calculation-trace.ts`). The agent never invents its own threshold; the
verdict arrives pre-computed on the trace.

Dedup is keyed on `workspace + holding + category`. While an alert is `open`, a
re-raise accumulates another occurrence (each with its full payload). Lifecycle is
`open → resolved | dismissed` with an optional note/link. A re-raise AFTER closure
mints a NEW alert linked back to the prior one — it smells like a regression, not a
duplicate. A partial unique index enforces at most one open alert per key.

The surface is a paper section under the existing `/admin` guard: a global list by
recency with an open-count badge, and a forensic detail that tabulates the trace
like a bank's cuadro (declared-vs-computed, reconciliation, amortization schedule),
shows the extracted data, and links to the conversation. Pull-only in v1 — no push
or email.

The repair NEVER waits on the alert.

## Considered options

- **Store alerts in the workspace database** — rejected. Any export/transfer would
  carry maintainer diagnostics across tenants; the control plane is the only place
  that already sits outside every workspace.
- **Reuse the user-facing data-quality signal taxonomy** — rejected. Those signals
  are for the user to act on; a suspected worthline bug is a maintainer concern with
  a different audience, payload, and lifecycle.
- **Let the model send the whole trace in the tool arguments** — rejected. That
  re-introduces the #1034 failure mode (the model rebuilding arithmetic in tokens).
  The tool reads the trace from the same deterministic seam the chat already uses.
- **Persist the source document with the alert** — rejected. The structured
  extraction is enough to diagnose; keeping the binary would add a sensitive storage
  lifecycle and break the process-and-discard guarantee of #865.
- **Push/email alerts in v1** — deferred. Pull from /admin is enough while the
  maintainer is a single operator; a notification channel can layer on later.

## Consequences

- Maintainer diagnostics are structurally unexportable from a workspace.
- The alert payload is self-contained: a maintainer diagnoses from the config
  snapshot and trace without reconstructing the scenario.
- Dedup keeps noise down while occurrences preserve every signal; a regression after
  closure is visible as a new, linked alert rather than a silently reopened one.
- The tool is the single write path; chat and extractor code still receive no
  workspace write capability.
- The modeling tolerance is auditable in one place, so "real divergence" has a fixed,
  documented meaning across the trace and the alert.
