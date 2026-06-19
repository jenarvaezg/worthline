import { createHash } from "node:crypto";

/**
 * Derive an opaque public ID for a calculation-fact object (PRD #328, #338)
 * from its stable internal id. Deterministic, so it survives export/import
 * (internal fact ids are stable); opaque, so it leaks no internal id (ADR 0023).
 * No registry write — a read derives it without mutating state, exactly like
 * `deriveOperationPublicId`/`deriveSnapshotPublicId`. Prefixes per PRD #328:
 * `van` valuation anchor, `amp` amortization plan, `irr` interest-rate revision,
 * `erp` early repayment, `ban` balance anchor.
 */
export function derivePublicId(prefix: string, stableInternalId: string): string {
  const digest = createHash("sha256").update(stableInternalId).digest("hex").slice(0, 32);
  return `wl_${prefix}_${digest}`;
}
