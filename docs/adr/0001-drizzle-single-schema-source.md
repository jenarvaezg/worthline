# Drizzle is the single schema source; migrate creates tables but does not evolve them

`packages/db/src/schema.ts` (drizzle-orm) is the single authored definition of the
SQLite schema. `drizzle-kit generate` (`npm run db:generate`) emits the DDL, which we
inline verbatim as a string in `src/schema-sql.ts` and apply at runtime via
`sqlite.exec`. We do **not** use drizzle-kit's runtime migrator: it resolves a
migrations folder through `new URL("../drizzle", import.meta.url)`, which Turbopack
cannot bundle and which points inside `.next` at runtime — so the folder is never
found. Inlining the DDL keeps the same schema bundler-safe and identical across
vitest, `next dev`, and `next build`.

`migrate()` is guarded by the `user_version` PRAGMA and rewrites the applied DDL with
`CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS`, so it is idempotent
across reopens and upgrades pre-`user_version` databases in place.

## Consequences

`migrate()` only **creates missing tables** — it does not **evolve existing ones**.
When `SCHEMA_VERSION` is bumped past 1, an existing database re-runs the same
`IF NOT EXISTS` DDL (a no-op on tables that already exist) and stamps the new version,
so an added or changed column is never applied and the app then queries a column the
table doesn't have. This is acceptable pre-release because local `.local/*.sqlite` data
is disposable and git-ignored. Before the first schema change that must preserve real
user data, replace this with a forward-migration path — either drizzle's journalled
migrations applied per version, or an explicit `ALTER TABLE` ladder keyed on
`user_version`.
