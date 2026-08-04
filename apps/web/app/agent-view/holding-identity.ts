/**
 * The instrument identity that travels ON a holding row (#1346): its ISIN, its
 * provider symbol, and the net units still held.
 *
 * Derived in ONE place so the three reads that carry it — the compact context row,
 * a `find_holdings` match, and the `get_holding_detail` identity block — can never
 * disagree about what a holding IS. The dead end it closes is an enumeration
 * question («todos los instrumentos con nombre, ISIN y participaciones»): with the
 * identity off the row, the only path was a fan-out of detail calls, and a model that
 * gives up mid-fan-out reports the data as missing rather than as unread.
 *
 * Units are the ledger's net position (`netUnitsFromOperations`, the same fold the
 * dashboard and the closed-position filter use), so a row and a detail page can never
 * quote different participaciones for the same fund.
 */

import type { InvestmentOperation } from "@worthline/domain";
import { netUnitsFromOperations } from "@worthline/domain";

import type { AgentViewHoldingIdentity } from "./contract";

export interface HoldingIdentityInput {
  /** The projected asset row, whose `providerSymbol` is what the price path reads. */
  asset?: { providerSymbol?: string | undefined } | undefined;
  /** The investment reference row (`readInvestmentAssetsWithMeta`), when it exists. */
  meta?: { isin?: string | undefined; providerSymbol?: string | undefined } | undefined;
  /**
   * The holding's operation ledger. Pass it only for investments: `undefined` (or
   * empty) leaves `units` absent, which reads as "no units recorded here" — the
   * honest answer for cash, a property, or a connected-source rung whose units live
   * in `get_connected_source_positions`.
   */
  operations?: readonly InvestmentOperation[] | undefined;
}

/**
 * Resolve a holding's identity fields, omitting whatever it has no fact for. The
 * asset row's provider symbol wins over the investment reference row's: the asset
 * row is what the price path reads (ADR 0011), so a row would otherwise report a
 * symbol no price was ever fetched with.
 */
export function resolveHoldingIdentity(
  input: HoldingIdentityInput,
): AgentViewHoldingIdentity {
  const isin = input.meta?.isin;
  const providerSymbol = input.asset?.providerSymbol ?? input.meta?.providerSymbol;
  const operations = input.operations;

  return {
    ...(isin ? { isin } : {}),
    ...(providerSymbol ? { providerSymbol } : {}),
    ...(operations && operations.length > 0
      ? { units: netUnitsFromOperations(operations) }
      : {}),
  };
}

/**
 * Copy the identity fields OFF a row that already carries them, keeping the
 * omission rule intact. The chat surface trims the context row field by field
 * (ADR 0047), and this is what stops that trim from hand-rolling a fourth guard
 * that quietly drops a legitimate `units: "0"`.
 */
export function pickHoldingIdentity(
  row: AgentViewHoldingIdentity,
): AgentViewHoldingIdentity {
  return {
    ...(row.isin === undefined ? {} : { isin: row.isin }),
    ...(row.providerSymbol === undefined ? {} : { providerSymbol: row.providerSymbol }),
    ...(row.units === undefined ? {} : { units: row.units }),
  };
}
