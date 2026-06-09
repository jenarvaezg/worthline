# Forward migration with Drizzle as schema source

`packages/db/src/schema.ts` (drizzle-orm) remains the single authored definition of
the SQLite schema. `drizzle-kit generate` (`npm run db:generate`) emits incremental
DDL migration files into `packages/db/drizzle/`. The full target schema DDL is inlined
as a string in `packages/db/src/schema-sql.ts` and applied at runtime via `sqlite.exec`.

`migrate()` in `packages/db/src/migrate.ts` owns the entire schema evolution lifecycle.
It is guarded by the `user_version` PRAGMA and applies a forward migration ladder:

- **v0 → v2**: Apply the full target schema (`schemaSql`) with `IF NOT EXISTS` guards.
  This handles both fresh databases and legacy pre-version databases.
- **v2 → v3**: Create `asset_price_cache` table.
- **v3 → v4**: Create `audit_log` table and add `deleted_at` columns to `assets` and
  `liabilities` via `ALTER TABLE` (wrapped in try/catch for idempotency).

Each step stamps `user_version` on completion, so migrations never re-run.

## Why not drizzle-kit's runtime migrator

Drizzle-kit's runtime migrator resolves a migrations folder through
`new URL("../drizzle", import.meta.url)`, which Turbopack cannot bundle and which
points inside `.next` at runtime. Inlining the DDL as a string keeps the schema
bundler-safe and identical across vitest, `next dev`, and `next build`.

## Schema evolution workflow

1. Edit `packages/db/src/schema.ts` (add tables, columns, indexes).
2. Run `npm run db:generate` to emit an incremental migration file.
3. Update `packages/db/src/schema-sql.ts` to reflect the full target schema
   (the generated DDL from drizzle-kit, concatenated across all migrations).
4. Add a forward migration step in `packages/db/src/migrate.ts` for existing
   databases that cannot be recreated from scratch.
5. Bump `SCHEMA_VERSION` and add the corresponding `if (version < N)` block.

## Consequences

- Fresh databases always get the full target schema in one step.
- Existing databases are evolved forward through explicit, versioned steps.
- `schemaSql` must be kept in sync with `schema.ts` — drift means fresh databases
  will be missing columns that the forward migrations then try to add.
- Forward migration steps are idempotent (IF NOT EXISTS, try/catch on ALTER TABLE).
- Local `.local/*.sqlite` data is disposable and git-ignored pre-release.
