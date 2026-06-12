/**
 * One-off backfill: reconstruct historical snapshots from the operations
 * already in the database (ADR 0012, PRD #107).
 *
 * For every past investment-operation date that has no snapshot yet, it
 * generates one — folding the position to that date and valuing it at the last
 * known operation price. Existing snapshots are never recalculated; the script
 * is idempotent, so running it twice changes nothing the second time.
 *
 * Manual holdings (cash, housing, debts) use their last known value from the
 * audit log, falling back to the current value when no history reaches that far
 * back (an accepted approximation — see PRD #107).
 *
 * Usage:
 *   npx tsx scripts/backfill-historical-snapshots.ts
 *   WORTHLINE_DATA_DIR=/path/to/data npx tsx scripts/backfill-historical-snapshots.ts
 */
import { withStore } from "@worthline/db";

const today = new Date().toISOString().slice(0, 10);

withStore((store) => {
  const workspace = store.readWorkspace();
  if (!workspace) {
    console.error("No workspace found — nothing to backfill.");
    process.exitCode = 1;
    return;
  }

  const before = store.readSnapshots();
  console.log(`Snapshots before backfill: ${before.length}`);

  store.backfillHistoricalSnapshots(today);

  const after = store.readSnapshots();
  const created = after.length - before.length;
  console.log(`Snapshots after backfill:  ${after.length}  (+${created})`);

  if (created > 0) {
    const beforeIds = new Set(before.map((snap) => snap.id));
    const fresh = after
      .filter((snap) => !beforeIds.has(snap.id))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

    console.log("\nGenerated snapshots:");
    for (const snap of fresh) {
      const total = (snap.totalNetWorth.amountMinor / 100).toLocaleString("es-ES", {
        minimumFractionDigits: 2,
      });
      console.log(`  ${snap.dateKey}  [${snap.scopeLabel}]  neto ${total} €`);
    }
  } else {
    console.log("\nNothing to backfill — every past operation date already has a snapshot.");
  }
});
