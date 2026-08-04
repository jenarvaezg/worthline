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

There are three assistant categories: `infidelity` (a persisted figure the current
config no longer reproduces — the #1042 class), `residual` (an unexplained residual
above the documented modeling tolerance after normalizing the magnitude and verifying
config), and `sync_source` (the smell is a connected-source/sync ownership problem,
not a worthline calc bug).

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

## Amendment (#1339): the system may raise about itself

A fourth category, `missed_capture`, is raised by the **daily-capture cron** about
**itself** when the durable queue shows an expected pass that was never invoked
(Vercel Cron is best-effort and skips invocations — ADR 0037). It is deliberately
absent from the chat tool's enum: no model can raise it, and the assistant's
category list stays a strict subset of the stored vocabulary.

This is the first alert that belongs to no tenant and no holding, so it carries
sentinels in the dedup key: workspace `fleet`, holding `daily-capture:<runKey>`. The
holding slot names the alert's **subject** rather than a holding, which keeps the
existing `workspace + holding + category` dedup exactly right — a retried capture
run re-detecting the same gap accumulates an occurrence, while a different missed
pass is a distinct incident a maintainer closes on its own. The `/admin` surfaces
translate the sentinels (`flota` + the pass in words) so they never reach a
maintainer's eyes raw, and the occurrence renders as the gap itself: there is no
config snapshot and no calculation trace to tabulate.

The alert stays consistent with the rest of the decision: control-plane-only, pull
from `/admin`, and never a user-facing signal.

## Amendment (#1347): an alert must carry a discrepancy, and no one is behind it

The three assistant categories all describe a discrepancy of MAGNITUDES, but until
#1347 nothing checked that one was actually in the payload. A real run
(2026-07-30) found the hole from the other side: cornered by a user asking to set
an ISIN on a fund — a field `propose_correction` does not have — the model raised
an `infidelity` alert whose summary was the user's **wish**, and then told the
user that «nuestro equipo» would take care of it. Three lies at once: the category
was false, the ISIN was already registered, and there is no team behind the alert
— it is the maintainer's own `/admin` panel.

So admission is now decided in code (`maintainer-alert-evidence.ts`), over the
assembled payload rather than the model's arguments. Three forms of evidence let an
alert through, and the summary's prose is none of them:

- **the trace's own verdict** — an unfaithful persisted point, a diverging
  reconciliation row, or a declared residual outside the documented band;
- **the two conflicting figures** — the user's declared balance against the painted
  one. Both now travel: the config snapshot gained `currentValue` in raw minor
  units, because the trace exists only for modelled debts and without it an alert
  about a fund reached `/admin` with a figure and nothing to reconcile it against.
  Figures that AGREE are refused, whether the trace says «within tolerance» or the
  declared number is simply the painted one read back;
- **the source itself, for `sync_source` only** — that category is by definition
  about a connected-source ownership problem rather than a magnitude, and its
  smells (a source stuck for weeks, a sync that returned nothing) have no figure to
  declare. The holding must actually be materialized by a source, so the snapshot
  now carries which adapter and how stale — and a manual holding cannot get in by
  relabelling the category, which is exactly what the 2026-07-30 fund was.

The refusal routes rather than merely blocking: it names the two surfaces that own
what an alert cannot fix — the holding's ficha for identity data, and
`/ajustes/conexiones` for a connected source — as places to look rather than as the
answer, since inventing a confident wrong surface would be #1347 in a new costume.
And the refusal is reported to the route (`onMaintainerAlertRefused`), like the
ungrounded-id one: a gate over the maintainer's only forensic channel must not be
able to over-block in silence.

The half code cannot close stays in the prompt, in one rule: there is no support,
no backoffice and no «equipo», so the assistant never promises that anyone will
review anything later, and an unsupported request is answered with the truth plus
the surface that does support it.

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
