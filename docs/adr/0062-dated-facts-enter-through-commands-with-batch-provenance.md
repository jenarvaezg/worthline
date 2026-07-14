# Dated facts enter through commands with batch provenance

ADR 0012 defines what a **dated fact about the past** does to historical
**snapshots**. ADR 0020 made persistence and **ripple recalculation** atomic,
but placed that guarantee at a public store seam whose method names exposed the
mechanism (`*AndRipple`). As more entry points appeared — manual forms,
statements, connected sources, and assistant-confirmed history — callers still
had to choose among persistence-shaped methods and could couple themselves to
the ripple implementation.

Bulk ingestion also needs a small, common provenance unit. A statement or sync
may declare facts of different kinds, but those rows must remain traceable to
the one application that accepted them without storing the raw source document
or inventing a provider-specific batch model.

Finally, an investment **operation** has historically carried only its calendar
execution date. Connected-source histories can provide several operations on
that date in a trustworthy source order. A date alone loses that order, while a
synthetic time would claim precision the source did not provide.

## Decision

### Commands own persist-and-ripple orchestration

Every external dated-fact mutation enters through the command host
(`store.command`). Its methods name user or application intent — for example,
`recordInvestmentOperation`, `applyStatementImport`, or
`addBalanceAnchor` — without an `AndRipple` suffix. The public
`WorthlineStore` surface exposes neither raw ripple methods nor dated-fact
`*AndRipple` methods.

The command owns the complete mutation: validation after parsing, the
transaction, persistence, derivation of the ripple from-date, and the ripple
itself. Server actions, connected-source flows, imports, scripts, and tests call
the command; they do not pair a store write with a ripple by convention.
Persistence stores remain implementation dependencies of commands, not an
alternative mutation API.

The existing dated-fact seam may remain as a private implementation module while
the migration proceeds. It is not exported from the package and is not spread
onto the runtime store. ADR 0020's atomicity and ripple semantics remain
accepted; this decision moves their public boundary from persistence-shaped
store methods to intent-shaped commands.

### One universal fact-batch sliver

`fact_batch` is the shared provenance header for one application of dated facts,
regardless of whether its trigger is interactive entry, an import, a connected
source, or a future assistant-confirmed ingestion. It records an id, a trigger,
creation time, and optional connected-source and sync-run references. It stores
neither raw payloads nor a serialized diff; those belong to their source
workflow, not to the financial fact ledger.

The first schema sliver adds a nullable `batch_id` to exactly the fact families
that participate in this common ingestion path:

- `asset_operations`;
- `asset_valuations`;
- `liability_balance_anchors`;
- `liability_balance_rebaselines`.

The references are nullable so existing rows remain valid and fact commands can
adopt batching incrementally. Null means that no batch provenance was recorded;
it does not mean a synthetic batch should be inferred. Once non-null, a fact's
`batch_id` is immutable: an update preserves the originating batch rather than
rewriting provenance. New fact families join this one table only when their
ingestion command needs the same contract; they do not get parallel batch
tables.

`ApplyDatedFactsBatch` is the common batch executor. Each successful invocation
persists exactly one `fact_batch` inside the same transaction, passes its id to
every fact step, derives one ripple floor from all affected dates, and performs
at most one ripple. This remains true for an empty or future-only application:
the invocation has one provenance row even when it has no ripple plan. If fact
persistence or ripple fails, the transaction rolls back both facts and batch,
so a failed invocation persists neither.

### Source instants refine asset-operation order

An asset operation may additionally carry `occurredAt`, a nullable UTC instant
serialized with a trailing `Z`. `executedAt` remains the financial calendar
date and remains the field used for dated-fact and ripple boundaries;
`occurredAt` only refines order within that date.

Only an importer with a trustworthy source instant may populate `occurredAt`.
Manual entry and date-only CSV imports leave it null. Importers must preserve the
source instant in UTC; they must not manufacture midnight or derive a timestamp
from ingestion time. Other dated-fact tables do not gain this field until they
have a demonstrated same-day ordering requirement.

The canonical asset-operation ledger order is ascending:

1. `executedAt` calendar date;
2. nullable `occurredAt` UTC instant;
3. stable operation id.

An absent `occurredAt` sorts before present instants on the same date, and the id
provides deterministic order for two absent or equal instants. Persistence
queries and pure domain calculations use this same comparator so positions,
returns, pagination, and rendered ledgers cannot disagree about operation order.

## Considered options

- **Keep `*AndRipple` methods public alongside commands** — rejected. Two public
  write surfaces preserve the very choice this boundary removes and let new
  callers bypass command-level provenance and orchestration.
- **Create one batch table per importer or fact kind** — rejected. A batch names
  one application, not one provider or domain table. Parallel models would make
  mixed historical ingestion impossible to trace uniformly.
- **Require `batch_id` on every existing fact immediately** — rejected. Legacy
  rows have no honest batch to reference, and manufacturing one would falsify
  provenance. Nullable, immutable references permit an additive migration.
- **Use `occurredAt` as the operation's dated-fact boundary** — rejected. The
  product's historical model is calendar-date based; source time is only a
  same-day ordering refinement.
- **Populate missing source times with midnight or ingestion time** — rejected.
  Both manufacture chronology. Null states exactly what is known.

## Consequences

- The public mutation vocabulary describes intent, while commands are the one
  testable boundary for transaction, provenance, and ripple behavior.
- Batch-aware imports gain one auditable application id across supported fact
  kinds and one ripple regardless of row count.
- Existing data and callers migrate forward additively: old fact rows keep null
  batch references, and date-only operations keep null source instants.
- Same-day operation order is stable across database reads and domain
  calculations without changing the date-based snapshot model.
- ADR 0020 remains authoritative for atomic persist-and-ripple behavior; this
  ADR supersedes only its choice of a public persistence-shaped store seam.
