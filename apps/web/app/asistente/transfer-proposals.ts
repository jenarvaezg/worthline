/**
 * Traspaso proposal builder (#1482, S5 of PRD #1393). Closes the last hole of the PRD:
 * «he traspasado 1.018,67 € del fondo A al fondo B» dictado al chat produce UN traspaso
 * — no una venta más una compra.
 *
 * What it writes: nothing. It resolves the traspaso the user dictated
 * ({@link ../typed-transfer}) against live data, runs the very arithmetic the write gate
 * runs (`planTransfer`), persists the INTENT as a draft proposal, and returns the
 * preview. The confirm action applies it through `recordTransferAndRipple` — the ONE
 * gate that mints a pair (#1479), the same one the screen of #1480 submits to. So the
 * two routes cannot disagree about what a traspaso is: same pair, same `transferId`,
 * same inherited cost, same single date.
 *
 * The frontiers, all in code and not in the tool's prose (ADR 0067):
 *
 * - **The figures come from the USER's message, parsed by worthline**, never from the
 *   model's arguments ({@link ../typed-transfer} carries that whole argument).
 * - **Both holdings must be MANUAL investments of this workspace.** A sync-owned
 *   position is the source's to write, and the gate THROWS on one — so it is refused
 *   here, with a sentence, before anything is persisted.
 * - **Both must keep the same currency**: the inherited cost is an amount in the
 *   origin's currency written onto the destination's row, and no rate is ever invented.
 * - **Origin ≠ destination**, and the origin must actually hold the importe on that
 *   date — refused, never clamped (the gate's rule, mirrored here so the refusal is a
 *   message instead of a 500).
 * - **The same traspaso is never written twice**: a pair already sitting on the origin
 *   at that date, towards that same destination, is reported and not doubled.
 *
 * What it does NOT ask the user for: the two VLs. Nobody dictates them, so each side's
 * comes from the app's own price for that holding — the same figure the screen prefills
 * — and the card says which VL it used and where it is from
 * ({@link transferPriceProvenanceNote}). A holding with no price at all fails closed
 * and routes to the screen, where the VL is a field.
 */

import { createHash } from "node:crypto";
import { mapDomainViolation } from "@web/intake";
import type {
  AssistantProposal,
  AssistantProposalStore,
  InvestmentTransferPlan,
  WorthlineStore,
} from "@worthline/db";
import type { CurrencyCode, DecimalString, TransferPortion } from "@worthline/domain";
import {
  addUnits,
  derivePosition,
  formatUnits,
  multiplyToMinor,
  operationsUpTo,
  planTransfer,
  selectInvestmentPrice,
  subtractUnits,
  type TransferPair,
} from "@worthline/domain";

import {
  connectedSourceValueRejection,
  readConnectedSourceOwners,
} from "./connected-source-write-guard";
import { formatIsoDayEs } from "./iso-day-es";
import { readScopeNetWorthBeforeMinor } from "./proposal-net-worth";
import { boundProposalSummary } from "./proposal-summary";
import type {
  TransferProposal,
  TransferProposalSide,
} from "./transfer-proposal-contract";
import {
  TRANSFER_FOLIO,
  TRANSFER_IMPACT_CAPTION,
  TRANSFER_NEUTRALITY_NOTE,
  transferDictatedLine,
  transferHalfLine,
  transferInheritedCostLine,
  transferPriceProvenanceNote,
  transferSideLine,
} from "./transfer-proposal-copy";
import type { TypedTransfer } from "./typed-transfer";

/** The reads the live-data check needs — shared by the build and the confirm. */
export type TransferProjectionStore = Pick<WorthlineStore, "assets" | "operations"> & {
  agentView: WorthlineStore["agentView"];
};

type TransferStore = TransferProjectionStore & {
  assistantProposals: AssistantProposalStore;
};

export interface TransferArgs {
  /** Internal asset ids, already resolved from the public `wl_hld_…`. */
  originAssetId: string;
  destinationAssetId: string;
  /** The `wl_hld_…` pair echoed back to the card. */
  originHolding: string;
  destinationHolding: string;
  /** The traspaso worthline read in the user's own message. Never the model's args. */
  transfer: TypedTransfer;
  summary?: string;
}

/**
 * The route offered when a side of the traspaso is not a manual investment with
 * participaciones. Like the operation lane's, it does not claim to know WHICH of the
 * two things went wrong — the read that answers this is a list of investments, so «no
 * existe» and «existe pero es una cuenta» arrive identically.
 */
const NOT_AN_INVESTMENT =
  "no la encuentro entre las inversiones con participaciones de la cartera: o no existe, " +
  "o es de otra familia (una cuenta, un inmueble, una deuda). Un traspaso mueve " +
  "participaciones entre productos que tienen participaciones, así que dala de alta " +
  "antes de traspasar a ella.";

/** The VL one side of the pair is valued at, and where that figure came from. */
interface TransferSidePrice {
  pricePerUnit: DecimalString;
  /** The day the price is from, when the app knows it. */
  priceDate?: string;
  /** True when it is a price the user typed on the ficha, not a quoted one. */
  manual: boolean;
}

/**
 * One side of the traspaso as the projection resolved it. Deliberately without the VL:
 * the projection is HANDED the two prices (they are frozen in the draft), so echoing
 * them back would be a second copy of a figure that already has one home.
 */
interface ProjectedSide {
  assetId: string;
  name: string;
  currency: string;
  unitsBefore: DecimalString;
  unitsAfter: DecimalString;
}

export interface ProjectedTransfer {
  ok: true;
  origin: ProjectedSide;
  destination: ProjectedSide;
  pair: TransferPair;
}

/**
 * What the confirm re-checks: the intent, exactly as the draft persisted it.
 *
 * No currency field, deliberately: the currency is a fact of the two ledgers, read
 * behind {@link projectTransferWrite} and refused when they disagree — the same
 * subtraction `RecordTransferCommand` makes for the same reason, so no caller can
 * declare a currency the book does not hold.
 */
export interface TransferWrite {
  originAssetId: string;
  destinationAssetId: string;
  executedAt: string;
  portion: TransferPortion;
  /** Frozen at draft time, so the confirm writes the VL the card showed. */
  originPricePerUnit: DecimalString;
  destinationPricePerUnit: DecimalString;
}

/**
 * Check the traspaso against the LIVE holdings and the origin's ledger AS OF the
 * transfer date, and report both sides' participaciones before → after.
 *
 * Shared by the build and the confirm, and it takes the already-resolved VLs rather
 * than re-reading the price: between arming a card and confirming it the cron may have
 * fetched a new quote, and re-deriving the participaciones from it would write figures
 * the user never agreed to. What the re-run IS for is the ledger — an operation on the
 * origin in the meantime can make the same importe no longer fit.
 */
export async function projectTransferWrite(
  store: TransferProjectionStore,
  write: TransferWrite,
): Promise<ProjectedTransfer | { ok: false; error: string }> {
  if (write.originAssetId === write.destinationAssetId) {
    return { error: mapDomainViolation({ code: "transfer_same_holding" }), ok: false };
  }

  const investments = await store.assets.readInvestmentAssetsWithMeta();
  const origin = investments.find((item) => item.id === write.originAssetId);
  const destination = investments.find((item) => item.id === write.destinationAssetId);
  if (!origin) {
    return { error: `La inversión de origen: ${NOT_AN_INVESTMENT}`, ok: false };
  }
  if (!destination) {
    return { error: `La inversión de destino: ${NOT_AN_INVESTMENT}`, ok: false };
  }

  // The connected-source frontier, in code (#1326) and on BOTH sides: the gate throws
  // on a sync-owned holding, whose position its own sync re-rolls, so a hand-written
  // half would be overwritten on the next one.
  const owners = await readConnectedSourceOwners(store.agentView);
  for (const side of [origin, destination]) {
    const owner = owners.get(side.id);
    if (owner) {
      return { error: connectedSourceValueRejection(owner, side.name), ok: false };
    }
  }

  if (origin.currency.toUpperCase() !== destination.currency.toUpperCase()) {
    return {
      error: mapDomainViolation({
        code: "transfer_currency_mismatch",
        destination: destination.currency as CurrencyCode,
        origin: origin.currency as CurrencyCode,
      }),
      ok: false,
    };
  }

  const dateKey = write.executedAt.slice(0, 10);
  const originOperations = operationsUpTo(
    await store.operations.readOperations(write.originAssetId),
    dateKey,
  );
  const destinationOperations = operationsUpTo(
    await store.operations.readOperations(write.destinationAssetId),
    dateKey,
  );

  // The replay check comes FIRST, before any figure is judged — the ordering the
  // screen's action already had to learn (#1394). A ledger that already holds this
  // traspaso is one where the position has ALREADY shrunk by it, so the very same
  // importe would come back refused as exceeding it, and the person would be told to
  // lower a figure that was right. Keyed on the date and the counterpart, which is what
  // a repeat looks like without re-deriving the participaciones.
  const counterparts = await store.operations.readTransferCounterparts(
    write.originAssetId,
  );
  const alreadyThere = originOperations.some(
    (operation) =>
      operation.kind === "transfer_out" &&
      operation.executedAt.slice(0, 10) === dateKey &&
      operation.transferId !== undefined &&
      counterparts.get(operation.transferId)?.assetId === write.destinationAssetId,
  );
  if (alreadyThere) {
    return {
      error:
        `Ese traspaso ya está anotado: «${origin.name}» tiene una salida por traspaso del ` +
        `${formatIsoDayEs(dateKey)} hacia «${destination.name}», así que no lo duplico. Si de ` +
        "verdad hiciste dos ese día, el segundo se registra desde «Traspasar» en la ficha de " +
        "la posición de origen.",
      ok: false,
    };
  }

  const originPosition = derivePosition(originOperations, {
    assetId: write.originAssetId,
    currency: origin.currency as CurrencyCode,
  });
  const destinationPosition = derivePosition(destinationOperations, {
    assetId: write.destinationAssetId,
    currency: destination.currency as CurrencyCode,
  });

  const plan = planTransfer(
    {
      currency: origin.currency as CurrencyCode,
      destinationAssetId: write.destinationAssetId,
      destinationPricePerUnit: write.destinationPricePerUnit,
      executedAt: write.executedAt,
      inOperationId: "preview_in",
      originAssetId: write.originAssetId,
      originPricePerUnit: write.originPricePerUnit,
      outOperationId: "preview_out",
      portion: write.portion,
      transferId: "preview",
    },
    {
      costBasisMinor: originPosition.costBasis.amountMinor,
      unitsHeld: originPosition.currentUnits,
    },
  );
  if (!plan.ok) {
    return { error: mapDomainViolation(plan.violations[0]), ok: false };
  }

  return {
    destination: {
      assetId: destination.id,
      currency: destination.currency,
      name: destination.name,
      unitsAfter: addUnits(destinationPosition.currentUnits, plan.value.incoming.units),
      unitsBefore: destinationPosition.currentUnits,
    },
    ok: true,
    origin: {
      assetId: origin.id,
      currency: origin.currency,
      name: origin.name,
      unitsAfter: subtractUnits(originPosition.currentUnits, plan.value.out.units),
      unitsBefore: originPosition.currentUnits,
    },
    pair: plan.value,
  };
}

/**
 * One side's VL and the name to refuse by: the app's own price for that holding,
 * through the SAME selection rule as every other valuation (ADR 0006, cached beats
 * manual) so the participaciones the card derives match the ones the ficha would show.
 *
 * A `null` price means the holding has none usable — a hand-created plan nobody has
 * priced yet. The lane then fails closed rather than inventing a VL: there is no honest
 * figure, and the screen of #1480 has a field for it. The NAME rides along from the same
 * read the price came out of, so the refusal can say which holding without a second
 * query for a fact this row already carries.
 */
export async function readTransferSidePrice(
  store: Pick<TransferProjectionStore, "assets" | "operations">,
  assetId: string,
): Promise<{ name: string | null; price: TransferSidePrice | null }> {
  const [asset, cache] = await Promise.all([
    store.assets.readInvestmentAssetById(assetId),
    store.operations.readPriceCache(assetId),
  ]);
  const selected = selectInvestmentPrice({
    cachedPrice: cache?.price,
    manualPrice: asset?.manualPricePerUnit,
  });
  const name = asset?.name ?? null;
  if (!selected) return { name, price: null };
  return {
    name,
    price: {
      manual: selected.source === "manual",
      pricePerUnit: selected.pricePerUnit,
      ...(selected.source === "cached" && cache?.priceDate
        ? { priceDate: cache.priceDate.slice(0, 10) }
        : {}),
    },
  };
}

/** The single traspaso plan an `investment_transfer` proposal carries. */
export function transferPlanFromProposal(
  proposal: AssistantProposal,
): InvestmentTransferPlan | null {
  if (proposal.kind !== "investment_transfer") return null;
  const facts = proposal.documents
    .flatMap((document) => document.facts)
    .filter((fact) => fact.kind === "investment_transfer");
  return facts.length === 1 ? facts[0]!.row : null;
}

/** The persisted plan read back as the write it describes — what the confirm re-checks. */
export function transferWriteFromPlan(plan: InvestmentTransferPlan): TransferWrite {
  return {
    destinationAssetId: plan.destinationAssetId,
    destinationPricePerUnit: plan.destinationPricePerUnit,
    executedAt: plan.executedAt,
    originAssetId: plan.originAssetId,
    originPricePerUnit: plan.originPricePerUnit,
    portion: plan.portion,
  };
}

export async function buildTransferProposal(
  store: TransferStore,
  args: TransferArgs,
  today: string,
): Promise<{ ok: true; proposal: TransferProposal } | { ok: false; error: string }> {
  const { executedAt, portion } = args.transfer;
  if (executedAt > today) {
    return {
      error:
        "Esa fecha está en el futuro, y un traspaso que registro es uno que ya ha ocurrido. " +
        "Dime el día en que lo hiciste.",
      ok: false,
    };
  }

  // The two VLs first: without them there is no arithmetic to preview, and the refusal
  // has to name WHICH holding has no price — «no tengo precio» about an unnamed one is
  // a dead end.
  const prices = await readTransferPrices(store, args);
  if (!prices.ok) return prices;

  const projected = await projectTransferWrite(store, {
    destinationAssetId: args.destinationAssetId,
    destinationPricePerUnit: prices.destination.pricePerUnit,
    executedAt,
    originAssetId: args.originAssetId,
    originPricePerUnit: prices.origin.pricePerUnit,
    portion,
  });
  if (!projected.ok) return projected;

  const { destination, origin, pair } = projected;
  const currency = origin.currency;

  const plan: InvestmentTransferPlan = {
    currency,
    destinationAssetId: destination.assetId,
    destinationHolding: args.destinationHolding,
    destinationPricePerUnit: prices.destination.pricePerUnit,
    executedAt,
    originAssetId: origin.assetId,
    originHolding: args.originHolding,
    originPricePerUnit: prices.origin.pricePerUnit,
    portion,
  };

  const proposal = await store.assistantProposals.create({ kind: "investment_transfer" });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      // Provenance `user`: what backs this write is the user's OWN message, read by
      // worthline (#1418's rule) — there is no document, and naming one would put a
      // file's name on a write no file grounds.
      name: TRANSFER_DICTATED_DOCUMENT_NAME,
      provenance: "user",
      sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    },
    facts: [{ kind: "investment_transfer", row: plan }],
  });

  const netWorthBeforeMinor = await readScopeNetWorthBeforeMinor(store.agentView, today);
  // What the LEDGER will hold right after the pair: the destination's new units at its
  // own VL, minus the origin's departing units at its own. Around zero by construction
  // — a traspaso moves capital, it does not create it — and NOT exactly zero, because
  // the two halves are valued at two different VLs and cut at six decimals.
  const deltaMinor =
    multiplyToMinor(pair.incoming.units, prices.destination.pricePerUnit) -
    multiplyToMinor(pair.out.units, prices.origin.pricePerUnit);

  return {
    ok: true,
    proposal: {
      destination: side({
        direction: "in",
        amountMinor: pair.incomingAmountMinor,
        currency,
        pricePerUnit: prices.destination.pricePerUnit,
        projected: destination,
        units: pair.incoming.units,
      }),
      dictated: transferDictatedLine({ currency, executedAt, portion }),
      draft: { proposalId: proposal.id },
      folio: TRANSFER_FOLIO,
      impact: {
        afterMinor:
          netWorthBeforeMinor === null ? null : netWorthBeforeMinor + deltaMinor,
        beforeMinor: netWorthBeforeMinor,
        deltaMinor,
      },
      impactCaption: TRANSFER_IMPACT_CAPTION,
      inheritedCost: transferInheritedCostLine(pair.inheritedCostMinor, currency),
      notes: [
        TRANSFER_NEUTRALITY_NOTE,
        ...[
          transferPriceProvenanceNote({
            executedAt,
            name: origin.name,
            side: "origin",
            ...prices.origin,
          }),
          transferPriceProvenanceNote({
            executedAt,
            name: destination.name,
            side: "destination",
            ...prices.destination,
          }),
        ].filter((note): note is string => note !== null),
      ],
      origin: side({
        direction: "out",
        amountMinor: pair.outgoingAmountMinor,
        currency,
        pricePerUnit: prices.origin.pricePerUnit,
        projected: origin,
        units: pair.out.units,
      }),
      proposalType: "investment_transfer",
      summary: boundProposalSummary(
        args.summary,
        `Traspaso de ${formatUnits(pair.out.units)} participaciones de «${origin.name}» a «${destination.name}»`,
      ),
    },
  };
}

/**
 * The document name recorded for a traspaso read off the chat. Fixed by the app, like
 * the typed balance series' (#1418): what backs these figures is the user's message.
 */
export const TRANSFER_DICTATED_DOCUMENT_NAME = "traspaso-dictado-en-el-chat";

/**
 * Both VLs, or the refusal that names the holding without one.
 *
 * It does NOT re-read the portfolio to name them: each side's row already came back
 * from `readTransferSidePrice`, and «no existe» is
 * {@link projectTransferWrite}'s answer to give — running its checks here in a second
 * copy is how the two would eventually disagree about what a valid side is.
 */
async function readTransferPrices(
  store: TransferProjectionStore,
  args: TransferArgs,
): Promise<
  | { ok: true; origin: TransferSidePrice; destination: TransferSidePrice }
  | { ok: false; error: string }
> {
  const [origin, destination] = await Promise.all([
    readTransferSidePrice(store, args.originAssetId),
    readTransferSidePrice(store, args.destinationAssetId),
  ]);

  if (origin.price === null || destination.price === null) {
    const without = [
      ...(origin.price === null ? [origin.name ?? "la inversión de origen"] : []),
      ...(destination.price === null
        ? [destination.name ?? "la inversión de destino"]
        : []),
    ];
    return {
      error:
        `No tengo valor liquidativo de ${without.map((name) => `«${name}»`).join(" ni de ")}, ` +
        "y sin él no puedo saber cuántas participaciones se mueven. Regístralo desde " +
        "«Traspasar» en la ficha de la posición de origen, donde los dos VL son campos que " +
        "puedes teclear.",
      ok: false,
    };
  }

  return { destination: destination.price, ok: true, origin: origin.price };
}

/** One side of the card, assembled from the projection and the copy module. */
function side(input: {
  direction: "out" | "in";
  projected: ProjectedSide;
  units: DecimalString;
  pricePerUnit: DecimalString;
  amountMinor: number;
  currency: string;
}): TransferProposalSide {
  return {
    movementLine: transferHalfLine({
      amountMinor: input.amountMinor,
      currency: input.currency,
      pricePerUnit: input.pricePerUnit,
      units: input.units,
    }),
    positionLine: transferSideLine({
      direction: input.direction,
      name: input.projected.name,
      unitsAfter: input.projected.unitsAfter,
      unitsBefore: input.projected.unitsBefore,
    }),
  };
}
