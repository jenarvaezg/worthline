# The control plane is a composition of its ports

- Status: accepted
- Date: 2026-08-26
- Issue: #1587

## Context

ADR 0030 decided WHAT the control plane is: one small libSQL database, separate
from every per-workspace database, that maps users → workspaces → grants. Since
then it has become the home of every fleet-wide concern that cannot live in a
tenant's database — the durable job queue (#887, ADR 0037), the serverless-shared
rate counters and meters (ADR 0051, #1163, #1258), entitlements and billing
(#1161, #1165), the curated exposure catalog (ADR 0058) and the maintainer alert
log (ADR 0064).

The interface already said so. `control-plane.ts` declared eight cohesive ports —
`TenancyDirectory`, `EntitlementDirectory`, `DailyCaptureLog`,
`BenchmarkPriceCache`, `UsageLimits`, `ExposureProfileCatalog`,
`MaintainerAlertLog`, `JobStore` — and the composite `ControlPlaneStore` that
assembles them, with a docstring telling consumers to depend on the narrowest
port they use. But all eight implementations, all eight sets of tables and every
row mapper lived in the same 2.218-line file, inside one `return { … }` with 57
methods over a shared closure.

The file map contradicted the type map, and it cost:

1. **Every new fleet-wide field landed in the same file.** The billing columns
   (#1165), the vision meter (#1258), the missed-pass lookup (#1339) and the
   job queue (#887) were each appended to the one file the others had just
   edited — colliding diffs on unrelated concerns.
2. **The tables were one blob.** A single `SCHEMA` template held the DDL of all
   eight ports, so adding a job column meant editing the string that also
   defines `users` and `workspace_entitlements`.
3. **Every implementation could reach every helper.** `newId`, the client, the
   sealed-secret helpers and the row mappers were all in scope for all 57
   methods. Nothing said which concern was entitled to what.

## Decision

`control-plane.ts` is a **facade**: it composes the ports and owns nothing else.

- **A port is a module.** One file per declared port, under `control-plane/`,
  named after the port it implements (`tenancy-directory.ts`, `job-store.ts`,
  `usage-limits.ts`, …). Each exports its types, its port interface and one
  `create…(client, …)` factory returning that port. A new fleet-wide concern is
  a new module and one line in the facade.
- **A port owns its tables.** Each module exports its own DDL fragment
  (`TENANCY_SCHEMA`, `JOB_SCHEMA`, …) beside the code that reads them; the facade
  only lists which fragments the database holds, tenancy first because the other
  fragments' foreign keys point at it. Adding a column is one edit in one module.
- **A factory takes only what it needs.** `createJobStore(client, newId)` and
  `createMaintainerAlertLog(client, newId)` mint ids; the other six take the
  client alone, so the signature states the module's entitlements rather than
  leaving them to a shared closure.
- **The facade keeps the composite.** `ControlPlaneStore`,
  `AdminControlPlaneStore`, `ControlPlaneStoreOptions`, the three openers and
  every port type stay exported from `./control-plane`, so no consumer's import
  changes. The `/admin`-only narrowing of #1123 is unchanged: the catalog module
  returns `ExposureProfileCatalogAdmin` and the base opener's return type is what
  hides the content writes.

Behavior is untouched. The 57 method bodies are byte-for-byte the ones they
replace, and the assembled DDL is the same 212 statements in the same per-port
order — this is the module map only.

The version ladder (`control-plane/migrate.ts`) stays a single module and is not
split: it is deliberately cross-cutting — a numbered sequence of steps over
whatever the database held at that version — and slicing it per port would break
the ordering that makes it correct.

## Consequences

- A change to jobs touches `control-plane/job-store.ts` and its tests, and
  nothing else. The same holds for each of the other seven.
- The co-located tests move with their port (`control-plane/billing.test.ts`,
  `control-plane/vision-call-usage.test.ts`, …), so the test map matches the
  port map too.
- The facade is now the census: a port that is declared but never composed does
  not typecheck against `ControlPlaneStore`.
- Reaching across ports is now a deliberate import rather than an accident of
  scope. No port needs another today; the day one does, it will be visible in a
  diff.
- The composite object is still assembled by spreading the eight ports into one
  record over ONE shared client connection (ADR 0030 — the control plane is one
  database). Ports are a code boundary, not a connection boundary.
