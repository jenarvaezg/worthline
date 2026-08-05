/**
 * The impure half of the chat's identity fill (#1349): read the live portfolio,
 * run the pure fill rule, and clear the two guards that need more than identity
 * to answer — «does this symbol resolve?» (the provider) and «what would it do to
 * the valuation?» (the ledger, #1329).
 *
 * The pure rule lives in `@worthline/domain` because the apply re-runs it against
 * live data; these guards run at draft time only, and deliberately so: their
 * inputs cannot turn against the user between drafting and confirming (a quote
 * that stops resolving is reported by the refresh pass, not by refusing an edit —
 * the same policy the editing surface applies to a retired provider), whereas the
 * identity of a field is exactly what a sibling proposal can change underneath.
 */

import { validateInvestmentProviderSymbol } from "@web/inversiones/provider-symbol-check";
import {
  detectValueOnlyOpening,
  valueOnlySymbolGuardMessage,
} from "@web/patrimonio/value-only-opening";
import type { OperationsStore, WorthlineStore } from "@worthline/db";
import {
  type InstrumentIdentityPatch,
  resolveInstrumentIdentityFill,
} from "@worthline/domain";
import type { CorrectionProposalEditRow } from "./correction-proposal-contract";

/**
 * «Does this symbol resolve, and at what price?» — the editing surface's own check
 * (ADR 0026), injectable so a test never reaches a provider.
 */
export type ProviderSymbolProbe = (input: {
  assetId: string;
  currency: string;
  liquidityTier: Parameters<typeof validateInvestmentProviderSymbol>[0]["liquidityTier"];
  priceProvider: Parameters<typeof validateInvestmentProviderSymbol>[0]["priceProvider"];
  symbol: string;
}) => Promise<
  { ok: false; error: string } | { ok: true; quotedPricePerUnit: string | null }
>;

export const liveProviderSymbolProbe: ProviderSymbolProbe = (input) =>
  validateInvestmentProviderSymbol({
    assetId: input.assetId,
    currency: input.currency,
    liquidityTier: input.liquidityTier,
    nowIso: new Date().toISOString(),
    priceProvider: input.priceProvider,
    providerSymbol: input.symbol,
  });

export type InstrumentIdentityCorrection =
  | { ok: false; error: string }
  | {
      ok: true;
      declaration: InstrumentIdentityPatch;
      before: { isin: string | null; providerSymbol: string | null };
      rows: CorrectionProposalEditRow[];
    };

/**
 * Resolve a chat-declared identity fill for ONE investment holding. Returns the
 * declaration to persist in the draft (not a decision — the apply re-resolves it),
 * the before-values for provenance, and the card's diff rows.
 */
export async function resolveInstrumentIdentityCorrection(
  store: Pick<WorthlineStore, "assets"> & {
    operations: Pick<OperationsStore, "readOperations">;
  },
  input: {
    assetId: string;
    declaration: { isin?: string | undefined; providerSymbol?: string | undefined };
  },
  probe: ProviderSymbolProbe = liveProviderSymbolProbe,
): Promise<InstrumentIdentityCorrection> {
  const portfolio = await store.assets.readInvestmentAssetsWithMeta();
  const target = portfolio.find((holding) => holding.id === input.assetId);
  if (!target) {
    return {
      ok: false,
      error:
        "El ISIN y el símbolo de cotización solo existen en una inversión: este holding " +
        "no lo es, así que no hay identidad de instrumento que corregir.",
    };
  }

  const resolved = resolveInstrumentIdentityFill({
    declaration: input.declaration,
    portfolio,
    target,
  });
  if (!resolved.ok) return resolved;

  const symbol = resolved.patch.providerSymbol;
  if (symbol !== undefined) {
    const checked = await probe({
      assetId: target.id,
      currency: target.currency,
      liquidityTier: target.liquidityTier,
      priceProvider: target.priceProvider,
      symbol,
    });
    if (!checked.ok) return { ok: false, error: checked.error };

    // #1329 on the chat's path: the guard that protects the editing surface lives
    // in its Server Action, which this lane never crosses. Same rule, same wording,
    // and no escape hatch here — «es una participación real» is a ficha decision.
    const valueOnly = detectValueOnlyOpening(
      await store.operations.readOperations(target.id),
    );
    if (valueOnly) {
      return {
        ok: false,
        error: valueOnlySymbolGuardMessage({
          opening: valueOnly,
          quotedPricePerUnit: checked.quotedPricePerUnit,
          symbol,
        }),
      };
    }
  }

  const rows: CorrectionProposalEditRow[] = [];
  if (resolved.patch.isin !== undefined) {
    rows.push({
      after: resolved.patch.isin,
      before: "—",
      label: "ISIN",
      origin: "assistant",
    });
  }
  if (symbol !== undefined) {
    rows.push({
      after: symbol,
      before: "—",
      label: "Símbolo de cotización",
      origin: "assistant",
    });
  }

  return {
    ok: true,
    before: {
      isin: target.isin ?? null,
      providerSymbol: target.providerSymbol ?? null,
    },
    declaration: resolved.patch,
    rows,
  };
}
