/**
 * Holding-creation proposal builder (#1105, PRD #1103 S2). Turns a chat-declared
 * "añade este fondo / esta cuenta / esta deuda" into a persisted `holding_creation`
 * assistant proposal: an **alta por estado actual** (ADR 0056) — a manual holding
 * created by its value/balance dated today, never an empty holding, never invented
 * history (ADR 0048). Modelled as the degenerate reconcile of the S1 matcher (0
 * matches, 1 new), so it reuses {@link matchHoldings} for the informative — never
 * blocking — duplicate warning. It writes NOTHING to the portfolio: the app applies
 * it on confirm through the same persistence seams the «Añadir holding» wizard uses.
 */

import { createHash } from "node:crypto";
import { resolveOwnershipSplit } from "@web/intake";
import type {
  AgentViewReadStore,
  AssistantProposalStore,
  HoldingCreationPlan,
  WorthlineStore,
} from "@worthline/db";
import {
  defaultsFor,
  formatMoneyMinor,
  type Instrument,
  type MatchCandidateRow,
  type MatchPortfolioHolding,
  matchHoldings,
  reassignToNew,
} from "@worthline/domain";
import { fetchPriceNow, type RegisteredSource } from "@worthline/pricing";
import { holdingCreationImpact } from "./holding-creation-impact";
import {
  type OpeningCardBreakdown,
  openingCardBreakdown,
  resolveHoldingCreationOpening,
} from "./holding-creation-opening";
import {
  HOLDING_CREATION_FOLIO,
  type HoldingCreationDuplicate,
  type HoldingCreationProposal,
} from "./holding-creation-proposal-contract";
import { instrumentLabel } from "./instrument-labels";
import { readScopeNetWorthBeforeMinor } from "./proposal-net-worth";

type ProposalStore = Pick<WorthlineStore, "assets" | "liabilities" | "workspace"> & {
  assistantProposals: AssistantProposalStore;
  agentView: AgentViewReadStore;
};

type Family = HoldingCreationPlan["family"];

/** The alta the model declares. Fields are read per family; the rest are ignored. */
export interface HoldingCreationArgs {
  family?: string;
  name?: string;
  instrument?: string;
  /** stored / appreciating: the current value in minor units. */
  currentValueMinor?: number;
  /** appreciating: whether the property is the primary residence. */
  isPrimaryResidence?: boolean;
  /** debt: the outstanding balance in minor units. */
  balanceMinor?: number;
  /** debt: overrides the catalog default model when the model is known. */
  debtModel?: string;
  /** investment: the second strong matching key (Finect / CoinGecko id). */
  providerSymbol?: string;
  /** investment: the ISIN, when the holding has one. */
  isin?: string;
  /** investment: the cash amount of the opening BUY, in minor units. */
  openingValueMinor?: number;
  /** investment: the unit price, as an es-ES decimal string. */
  pricePerUnit?: string;
  /**
   * investment: the units the document states (es-ES decimal string), persisted
   * verbatim. Absent → derived from the amount (#1315).
   */
  units?: string;
  /** investment: the broker commission of the opening BUY, in minor units (#1315). */
  feesMinor?: number;
}

type BuildResult =
  | { ok: true; proposal: HoldingCreationProposal }
  | { ok: false; error: string };

/** Which alta family an instrument belongs to. `coin_collection` is OUT (#1105). */
const FAMILY_BY_INSTRUMENT: Partial<Record<Instrument, Family>> = {
  credit_card: "debt",
  crypto: "investment",
  current_account: "stored",
  etf: "investment",
  fund: "investment",
  index: "investment",
  loan: "debt",
  mortgage: "debt",
  other: "stored",
  pension_plan: "investment",
  precious_metal: "stored",
  property: "appreciating",
  stock: "investment",
  term_deposit: "stored",
  vehicle: "stored",
};

function parseInstrument(value: string | undefined): Instrument | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed in FAMILY_BY_INSTRUMENT ? (trimmed as Instrument) : null;
}

function isPositiveMinor(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Validate the args into a fully-resolved plan, or a Spanish rejection. */
function buildPlan(
  args: HoldingCreationArgs,
  ownership: HoldingCreationPlan["ownership"],
):
  | { ok: true; plan: HoldingCreationPlan; openingMismatchWarning?: string }
  | { ok: false; error: string } {
  const name = (args.name ?? "").trim();
  if (!name) return { ok: false, error: "Falta el nombre del holding a crear." };

  const instrument = parseInstrument(args.instrument);
  if (!instrument) {
    return { ok: false, error: "No reconozco ese tipo de holding para el alta." };
  }
  const family = FAMILY_BY_INSTRUMENT[instrument]!;
  if (args.family !== undefined && args.family !== family) {
    return {
      ok: false,
      error: `El instrumento «${instrument}» no pertenece a la familia «${args.family}».`,
    };
  }

  if (family === "stored") {
    if (!isPositiveMinor(args.currentValueMinor)) {
      return { ok: false, error: "Falta el valor actual (en céntimos) del holding." };
    }
    return {
      ok: true,
      plan: {
        currentValueMinor: args.currentValueMinor,
        family,
        instrument,
        name,
        ownership,
      },
    };
  }

  if (family === "appreciating") {
    if (!isPositiveMinor(args.currentValueMinor)) {
      return { ok: false, error: "Falta el valor actual (en céntimos) del inmueble." };
    }
    return {
      ok: true,
      plan: {
        currentValueMinor: args.currentValueMinor,
        family,
        instrument,
        isPrimaryResidence: args.isPrimaryResidence === true,
        name,
        ownership,
      },
    };
  }

  if (family === "debt") {
    if (!isPositiveMinor(args.balanceMinor)) {
      return { ok: false, error: "Falta el saldo pendiente (en céntimos) de la deuda." };
    }
    const fallback = defaultsFor(instrument).liability?.debtModel ?? "informal";
    const debtModel =
      args.debtModel === "amortizable" ||
      args.debtModel === "revolving" ||
      args.debtModel === "informal"
        ? args.debtModel
        : fallback;
    return {
      ok: true,
      plan: {
        balanceMinor: args.balanceMinor,
        debtModel,
        family,
        instrument,
        name,
        ownership,
      },
    };
  }

  // investment: an optional opening BUY dated today, resolved by the one module
  // that owns `importe = títulos × precio + comisión` (#1315). Nothing declared →
  // an empty container (no 0 € valuation invented); a half-declared opening fails
  // honestly rather than guessing; declared terms that disagree warn, never block.
  const base: HoldingCreationPlan = {
    family: "investment",
    instrument,
    name,
    ownership,
    ...(args.isin ? { isin: args.isin.trim() } : {}),
    ...(args.providerSymbol ? { providerSymbol: args.providerSymbol.trim() } : {}),
  };
  const resolved = resolveHoldingCreationOpening(
    {
      ...(args.feesMinor === undefined ? {} : { feesMinor: args.feesMinor }),
      ...(args.openingValueMinor === undefined
        ? {}
        : { openingValueMinor: args.openingValueMinor }),
      ...(args.pricePerUnit === undefined ? {} : { pricePerUnit: args.pricePerUnit }),
      ...(args.units === undefined ? {} : { units: args.units }),
    },
    // Value-only resolves as 1 participación × valor only without a symbol
    // (#1325): with one, a live quote derives the units upstream instead.
    { allowValueOnly: base.providerSymbol === undefined },
  );
  if (!resolved.ok) return resolved;
  if (resolved.opening === null) return { ok: true, plan: base };
  return {
    ok: true,
    plan: { ...base, opening: resolved.opening },
    ...(resolved.mismatchWarning === undefined
      ? {}
      : { openingMismatchWarning: resolved.mismatchWarning }),
  };
}

/** Project the current portfolio into matcher holdings for the duplicate warning. */
async function projectHoldings(store: ProposalStore): Promise<MatchPortfolioHolding[]> {
  const assets = await store.assets.readAssets();
  const investmentMeta = await store.assets.readInvestmentAssetsWithMeta();
  const isinBy = new Map(investmentMeta.map((meta) => [meta.id, meta]));
  const assetHoldings: MatchPortfolioHolding[] = assets.map((asset) => {
    const meta = isinBy.get(asset.id);
    return {
      holdingId: asset.id,
      name: asset.name,
      ...(asset.instrument ? { instrument: asset.instrument } : {}),
      ...(meta?.isin ? { isin: meta.isin } : {}),
      ...((asset.providerSymbol ?? meta?.providerSymbol)
        ? { providerSymbol: asset.providerSymbol ?? meta?.providerSymbol ?? null }
        : {}),
    };
  });
  const liabilities = await store.liabilities.readLiabilities();
  const liabilityHoldings: MatchPortfolioHolding[] = liabilities.map((liability) => ({
    holdingId: liability.id,
    name: liability.name,
  }));
  return [...assetHoldings, ...liabilityHoldings];
}

/** The informative duplicate warning for the alta, or undefined when unique. */
function duplicateOf(
  plan: HoldingCreationPlan,
  holdings: MatchPortfolioHolding[],
): HoldingCreationDuplicate | undefined {
  const row: MatchCandidateRow = {
    rowId: "alta",
    instrument: plan.instrument,
    name: plan.name,
    ...(plan.family === "investment" && plan.isin ? { isin: plan.isin } : {}),
    ...(plan.family === "investment" && plan.providerSymbol
      ? { providerSymbol: plan.providerSymbol }
      : {}),
  };
  // The alta always creates: run the (possibly matched) row through reassignToNew
  // and read the surviving best candidate as the informative duplicate (#1090).
  const created = reassignToNew(matchHoldings([row], holdings)[0]!);
  const duplicate = created.possibleDuplicate;
  if (!duplicate) return undefined;
  return {
    confidence: duplicate.confidence === "strong" ? "strong" : "weak",
    name: duplicate.name,
  };
}

/**
 * The resolved price symbol the card surfaces for confirmation (#1186), only
 * for an investment alta that carries one. Absent otherwise.
 */
function providerSymbolOf(plan: HoldingCreationPlan): string | undefined {
  return plan.family === "investment" ? plan.providerSymbol : undefined;
}

/**
 * The informative price-tracking warning (#1186): ANY investment holding is
 * repriced by `pricePairKey(priceProvider, providerSymbol)`, so one created
 * without a symbol lands valued today and then freezes — the daily capture and
 * the stale-price refresh drop it. Keyed on the investment FAMILY, not on the
 * search tool's `MARKET_INSTRUMENTS` set: it is deliberately broader (a
 * pension_plan reprices by its Finect symbol too), so it warns for every
 * symbol-less investment alta. Never blocks: the alta still applies.
 */
function priceTrackingWarningOf(plan: HoldingCreationPlan): string | undefined {
  if (plan.family !== "investment" || plan.providerSymbol) return undefined;
  return "Sin símbolo de mercado: el valor no se actualizará automáticamente hasta asignarle uno.";
}

/** The formatted detail line (value / balance) the card shows next to the name. */
function detailOf(plan: HoldingCreationPlan): string {
  const euros = (minor: number): string =>
    formatMoneyMinor({ amountMinor: minor, currency: "EUR" });
  switch (plan.family) {
    case "stored":
    case "appreciating":
      return euros(plan.currentValueMinor);
    case "debt":
      return euros(plan.balanceMinor);
    case "investment":
      return plan.opening ? euros(plan.opening.valueMinor) : "Sin valoración de apertura";
  }
}

/**
 * The títulos × precio (+ comisión) the card shows next to the value, for an
 * investment alta with an opening (#1315). Absent otherwise.
 */
function openingOf(plan: HoldingCreationPlan): OpeningCardBreakdown | undefined {
  if (plan.family !== "investment" || !plan.opening) return undefined;
  return openingCardBreakdown(plan.opening);
}

/** Live unit price for a symbol-ful, value-only alta — or null when unquotable. */
export type QuoteUnitPrice = (
  instrument: Instrument,
  symbol: string,
) => Promise<string | null>;

const REGISTERED_SOURCES: readonly RegisteredSource[] = [
  "yahoo",
  "stooq",
  "coingecko",
  "finect",
];

function isRegisteredSource(value: string | undefined): value is RegisteredSource {
  return value !== undefined && (REGISTERED_SOURCES as readonly string[]).includes(value);
}

/**
 * The default quote seam (#1325): the same live-price prefill the «Añadir holding»
 * wizard runs when a symbol is picked, so the chat alta derives its units from the
 * exact figure the wizard would have shown. Null (provider missing, no quote)
 * degrades to an honest rejection upstream — never to an empty container.
 */
async function liveUnitPrice(
  instrument: Instrument,
  symbol: string,
): Promise<string | null> {
  const provider = defaultsFor(instrument).priceProvider;
  if (!isRegisteredSource(provider)) return null;
  const fetched = await fetchPriceNow(provider, {
    assetId: "alta-chat-preview",
    currency: "EUR",
    nowIso: new Date().toISOString(),
    symbol,
  });
  return fetched?.price ?? null;
}

/**
 * A symbol-ful investment alta declaring ONLY the cash amount (#1325): the units
 * must come from a live quote — the 1-unit encoding would revalue to one share's
 * NAV the moment the symbol's real price lands.
 */
function needsLiveQuote(
  args: HoldingCreationArgs,
  instrument: Instrument | null,
): instrument is Instrument {
  return (
    instrument !== null &&
    FAMILY_BY_INSTRUMENT[instrument] === "investment" &&
    (args.providerSymbol ?? "").trim() !== "" &&
    args.openingValueMinor !== undefined &&
    args.pricePerUnit === undefined &&
    args.units === undefined
  );
}

export async function buildHoldingCreationProposal(
  store: ProposalStore,
  args: HoldingCreationArgs,
  today: string,
  quoteUnitPrice: QuoteUnitPrice = liveUnitPrice,
): Promise<BuildResult> {
  const workspace = await store.workspace.readWorkspace();
  if (!workspace) return { ok: false, error: "Workspace no inicializado." };

  const activeMembers = workspace.members.filter((member) => !member.disabledAt);
  // v1 alta assigns the scope default (100% to the first active member in a
  // multi-member household — the wizard lets the user pick, the chat can't yet).
  // Household net worth is owner-agnostic, so the impact figure is unaffected; a
  // follow-up could let the model pass an owner for per-member attribution.
  const ownership = resolveOwnershipSplit({
    activeMembers,
    preset: "scope",
    shortfall: "complete-to-full-ownership",
  });

  let effectiveArgs = args;
  const parsedInstrument = parseInstrument(args.instrument);
  if (needsLiveQuote(args, parsedInstrument)) {
    const symbol = args.providerSymbol!.trim();
    const quoted = await quoteUnitPrice(parsedInstrument, symbol);
    if (quoted === null) {
      return {
        ok: false,
        error:
          `No hay cotización disponible ahora mismo para «${symbol}», así que no puedo ` +
          "derivar los títulos desde el importe: pásame los títulos o el precio por " +
          "unidad del documento, o crea el alta sin símbolo para registrarla por su " +
          "valor total (sin actualización automática de precio).",
      };
    }
    effectiveArgs = { ...args, pricePerUnit: quoted };
  }

  const built = buildPlan(effectiveArgs, ownership);
  if (!built.ok) return built;
  const plan = built.plan;

  const holdings = await projectHoldings(store);
  const duplicate = duplicateOf(plan, holdings);

  const netWorthBeforeMinor = await readScopeNetWorthBeforeMinor(store.agentView, today);
  const impact = holdingCreationImpact(netWorthBeforeMinor, plan);

  const providerSymbol = providerSymbolOf(plan);
  const priceTrackingWarning = priceTrackingWarningOf(plan);
  const opening = openingOf(plan);

  const proposal = await store.assistantProposals.create({ kind: "holding_creation" });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name: "declaración-del-usuario",
      provenance: "user",
      sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    },
    facts: [{ kind: "holding_creation", row: plan }],
  });

  return {
    ok: true,
    proposal: {
      draft: { proposalId: proposal.id },
      family: plan.family,
      folio: HOLDING_CREATION_FOLIO,
      holding: {
        detail: detailOf(plan),
        instrumentLabel: instrumentLabel(plan.instrument, plan.instrument),
        name: plan.name,
        ...(opening ? { opening } : {}),
        ...(providerSymbol ? { providerSymbol } : {}),
      },
      impact,
      proposalType: "holding_creation",
      ...(duplicate ? { duplicate } : {}),
      ...(built.openingMismatchWarning === undefined
        ? {}
        : { openingMismatchWarning: built.openingMismatchWarning }),
      ...(priceTrackingWarning ? { priceTrackingWarning } : {}),
    },
  };
}
