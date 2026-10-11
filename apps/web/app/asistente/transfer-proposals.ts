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
 *   model's arguments ({@link ../typed-transfer} carries that whole argument) — or,
 *   since #1799, from the bank's confirmation worthline validated
 *   ({@link ../transfer-document-source}), and then the draft says so: provenance
 *   `agent`, the file's name, and a caption that names it.
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
 * - **The two funds are the paper's** (#1800): when the figures came off a confirmation
 *   that prints each fund's ISIN or DGS code, both holdings are checked against them
 *   ({@link ../transfer-identity}), at build and again at confirm.
 *
 * What it does NOT ask the user for: the two VLs. Nobody dictates them. A leg whose
 * participaciones the message DID state derives its own (#1544) and needs no price at
 * all; for the rest, the VL comes from the app's own price for that holding — the same
 * figure the screen prefills — and the card says which VL it used and where it is from
 * ({@link transferPriceProvenanceNote}). A leg that needs a price and has none fails
 * closed, naming the holding, and offers both ways out: state the participaciones, or
 * use the screen where the VL is a field.
 */

import { createHash } from "node:crypto";
import { mapDomainViolation } from "@web/intake";
import type {
  AssistantProposal,
  AssistantProposalStore,
  InvestmentTransferPlan,
  WorthlineStore,
} from "@worthline/db";
import type {
  CurrencyCode,
  DecimalString,
  SecurityId,
  TransferPortion,
} from "@worthline/domain";
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
import {
  type PrintedFund,
  type TransferIdentityRefusal,
  transferIdentityContradiction,
  transferIdentityRefusal,
} from "./transfer-identity";
import type {
  TransferProposal,
  TransferProposalSide,
} from "./transfer-proposal-contract";
import {
  TRANSFER_DICTATED_CAPTION,
  TRANSFER_FOLIO,
  TRANSFER_IMPACT_CAPTION,
  TRANSFER_NEUTRALITY_NOTE,
  transferDictatedLine,
  transferDocumentCaption,
  transferEarlierMessageCaption,
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
  /**
   * The traspaso worthline READ — in the user's own message, or off a validated
   * confirmation (#1799). Never the model's args.
   */
  transfer: TypedTransfer;
  /** Where {@link transfer} was read. Absent means the turn's own message. */
  source?: TransferSource;
  summary?: string;
}

/**
 * Where the figures of a traspaso were read, which is what the card says under them and
 * what the draft records as its provenance. Two doors, one builder — the operation's
 * shape (#1374, #1466).
 */
export type TransferSource =
  | {
      from: "message";
      /**
       * The earlier user message those figures were read from, when it was not the
       * turn's own (#1798): «sí, procede» reaches back to them, and the card says so.
       */
      earlierMessage?: string;
    }
  | {
      /** A confirmation worthline extracted and validated (#1795, #1799). */
      from: "document";
      /** The file it came in: the card names it, and so does the draft. */
      fileName: string;
      /** The currency the paper prints the importe in. */
      currency: string;
      /**
       * The two funds the paper names, with the identifier each prints — what the two
       * holdings the model chose are checked against (#1800).
       */
      funds: { origin: PrintedFund; destination: PrintedFund };
    };

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
  /**
   * Frozen at draft time, so the confirm writes the VL the card showed — and absent
   * when the portion DECLARES its participaciones, because then the VL is derived from
   * the two figures the user wrote and there is no app price in the arithmetic (#1544).
   */
  originPricePerUnit?: DecimalString | undefined;
  destinationPricePerUnit?: DecimalString | undefined;
  /** The participaciones that arrived, when they were stated rather than divided. */
  destinationUnits?: DecimalString | undefined;
  /** The identifier the paper printed for each fund, re-checked here (#1800). */
  originSecurityId?: SecurityId | undefined;
  destinationSecurityId?: SecurityId | undefined;
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

  // The identity contradiction, through the operation's own piece (#1800): a holding
  // that registers another identifier than the paper's is another instrument. The
  // build already refused it with the holdings that DO carry it; what reaches here is
  // the confirm, after a ficha edit in between.
  const contradiction =
    transferIdentityContradiction("origin", write.originSecurityId, origin) ??
    transferIdentityContradiction(
      "destination",
      write.destinationSecurityId,
      destination,
    );
  if (contradiction) return { error: contradiction, ok: false };

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
  const alreadyThere = originOperations.find(
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
        `${formatIsoDayEs(dateKey)} hacia «${destination.name}» (${formatUnits(alreadyThere.units)} ` +
        "participaciones), así que no lo duplico. Para corregir las participaciones que entraron, " +
        "usa la ficha de la posición. Si de " +
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
      destinationUnits: write.destinationUnits,
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
    destinationUnits: plan.destinationUnits,
    executedAt: plan.executedAt,
    originAssetId: plan.originAssetId,
    originPricePerUnit: plan.originPricePerUnit,
    portion: plan.portion,
    originSecurityId: plan.originSecurityId,
    destinationSecurityId: plan.destinationSecurityId,
  };
}

export async function buildTransferProposal(
  store: TransferStore,
  args: TransferArgs,
  today: string,
): Promise<
  | { ok: true; proposal: TransferProposal }
  | {
      ok: false;
      error: string;
      /** The typed answer, when the refusal is more than its sentence (#1800). */
      refusal?: TransferIdentityRefusal;
    }
> {
  const { destinationUnits, executedAt, portion } = args.transfer;
  if (executedAt > today) {
    return {
      error:
        "Esa fecha está en el futuro, y un traspaso que registro es uno que ya ha ocurrido. " +
        "Dime el día en que lo hiciste.",
      ok: false,
    };
  }

  // The two funds are the paper's (#1800), judged before any price is read: a wrong
  // holding with no VL would otherwise be refused for its missing price, and the
  // person told to type participaciones for a fund the traspaso never touched.
  if (args.source?.from === "document") {
    const refusal = await transferIdentityRefusal(store, {
      destination: {
        assetId: args.destinationAssetId,
        printed: args.source.funds.destination,
      },
      origin: { assetId: args.originAssetId, printed: args.source.funds.origin },
    });
    if (refusal) return { error: refusal.message, ok: false, refusal };
  }

  // The VLs the arithmetic still needs, and only those: a leg that DECLARES its
  // participaciones derives its own (#1544), so a holding with no price at all no
  // longer blocks a traspaso the user stated fully. The refusal has to name WHICH
  // holding has no price — «no tengo precio» about an unnamed one is a dead end. The
  // same goes for the arriving leg when a pasted suscripción stated its
  // participaciones (#1794): its VL is derived, and the destination's price is neither
  // read nor missed.
  const prices = await readTransferPrices(store, args, {
    destination: destinationUnits === undefined,
    origin: portion.kind !== "units",
  });
  if (!prices.ok) return prices;

  // What the user's figures STATE, frozen in the draft: a VL only for a leg whose
  // participaciones were not stated, and the arriving participaciones when they were.
  const stated = {
    ...(prices.origin === null ? {} : { originPricePerUnit: prices.origin.pricePerUnit }),
    ...(prices.destination === null
      ? {}
      : { destinationPricePerUnit: prices.destination.pricePerUnit }),
    ...(destinationUnits === undefined ? {} : { destinationUnits }),
    // And what the paper printed about WHICH funds, so the confirm re-checks it (#1800).
    ...printedSecurityIds(args.source),
  };

  const projected = await projectTransferWrite(store, {
    destinationAssetId: args.destinationAssetId,
    executedAt,
    originAssetId: args.originAssetId,
    portion,
    ...stated,
  });
  if (!projected.ok) return projected;

  const { destination, origin, pair } = projected;
  const currency = origin.currency;
  const source: TransferSource = args.source ?? { from: "message" };
  // A paper's importe is in the paper's currency, and the pair is written in the
  // holdings': no rate is ever invented (ADR 0072), so a confirmation in another one is
  // refused rather than read as if it were the same money.
  if (
    source.from === "document" &&
    source.currency.toUpperCase() !== currency.toUpperCase()
  ) {
    return {
      error:
        `El justificante está en ${source.currency} y «${origin.name}» se lleva en ` +
        `${currency}: no convierto divisas por mi cuenta, así que este traspaso regístralo ` +
        "desde «Traspasar» en la ficha de la posición de origen.",
      ok: false,
    };
  }

  const plan: InvestmentTransferPlan = {
    currency,
    destinationAssetId: destination.assetId,
    destinationHolding: args.destinationHolding,
    executedAt,
    originAssetId: origin.assetId,
    originHolding: args.originHolding,
    portion,
    ...stated,
  };

  const proposal = await store.assistantProposals.create({ kind: "investment_transfer" });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      // Provenance `agent` and the file's own name when worthline READ the figures off a
      // validated confirmation (#1799), as the operation records its justificante.
      // Provenance `user` otherwise: what backs this write is the user's OWN message,
      // read by worthline (#1418's rule) — there is no document, and naming one would
      // put a file's name on a write no file grounds.
      ...(source.from === "document"
        ? { name: source.fileName, provenance: "agent" as const }
        : { name: TRANSFER_DICTATED_DOCUMENT_NAME, provenance: "user" as const }),
      sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    },
    facts: [{ kind: "investment_transfer", row: plan }],
  });

  const netWorthBeforeMinor = await readScopeNetWorthBeforeMinor(store.agentView, today);
  // What the LEDGER will hold right after the pair: each half's units at the VL its own
  // ROW will carry — read off the pair, so a derived VL (#1544) is measured as honestly
  // as a quoted one. Around zero by construction — a traspaso moves capital, it does
  // not create it — and NOT exactly zero, because the two halves are valued at two
  // different VLs and cut at six decimals.
  const deltaMinor =
    multiplyToMinor(pair.incoming.units, pair.incoming.pricePerUnit) -
    multiplyToMinor(pair.out.units, pair.out.pricePerUnit);

  return {
    ok: true,
    proposal: {
      destination: side({
        direction: "in",
        amountMinor: pair.incomingAmountMinor,
        currency,
        // The VL of the ROW, not of the read: in the participaciones reading it is the
        // derived figure, and the card exists to make that derivation checkable.
        pricePerUnit: pair.incoming.pricePerUnit,
        projected: destination,
        units: pair.incoming.units,
      }),
      dictated: transferDictatedLine({
        currency,
        executedAt,
        portion,
        ...(destinationUnits === undefined ? {} : { destinationUnits }),
      }),
      sourceCaption: transferSourceCaption(source),
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
        // One note per leg whose VL came from the APP's price. A leg that declared its
        // participaciones has nothing to caveat — its VL was derived from the two
        // figures the user wrote — which is the whole point of #1544: the warning
        // existed because the model asked for the unstable datum.
        //
        // The DESTINATION's note therefore survives this lane on purpose: a dictated
        // traspaso states one unit count, and a message with two is refused as
        // ambiguous (`typed-transfer.ts`) and routed to the screen, which has a field
        // per leg. So the arriving half is still divided at the app's price, and still
        // says so — unless a pasted suscripción stated it (#1794), and then it is the
        // ORIGIN that is divided and says so instead.
        ...[
          prices.origin === null
            ? null
            : transferPriceProvenanceNote({
                executedAt,
                name: origin.name,
                side: "origin",
                ...prices.origin,
              }),
          prices.destination === null
            ? null
            : transferPriceProvenanceNote({
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
        pricePerUnit: pair.out.pricePerUnit,
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

/** The identifier each fund's paper printed, when the figures came off a paper. */
function printedSecurityIds(
  source: TransferSource | undefined,
): Pick<TransferWrite, "originSecurityId" | "destinationSecurityId"> {
  if (source?.from !== "document") return {};
  const { destination, origin } = source.funds;
  return {
    ...(origin.securityId ? { originSecurityId: origin.securityId } : {}),
    ...(destination.securityId ? { destinationSecurityId: destination.securityId } : {}),
  };
}

/** The caption under the echo: the file, an earlier message, or the turn's own. */
function transferSourceCaption(source: TransferSource): string {
  if (source.from === "document") return transferDocumentCaption(source.fileName);
  return source.earlierMessage === undefined
    ? TRANSFER_DICTATED_CAPTION
    : transferEarlierMessageCaption(source.earlierMessage);
}

/**
 * The VLs the arithmetic still needs, or the refusal that names the holding without one.
 *
 * It does NOT re-read the portfolio to name them: each side's row already came back
 * from `readTransferSidePrice`, and «no existe» is
 * {@link projectTransferWrite}'s answer to give — running its checks here in a second
 * copy is how the two would eventually disagree about what a valid side is.
 */
async function readTransferPrices(
  store: TransferProjectionStore,
  args: TransferArgs,
  /**
   * Whether each side's VL is still part of the arithmetic. False for a side whose
   * participaciones were stated — the origin's by the message (#1544), the
   * destination's by a pasted suscripción (#1794): that price is then neither read for
   * the plan nor missed when the holding has none.
   */
  needs: { origin: boolean; destination: boolean },
): Promise<
  | { ok: true; origin: TransferSidePrice | null; destination: TransferSidePrice | null }
  | { ok: false; error: string }
> {
  const unread = Promise.resolve({ name: null, price: null });
  const [origin, destination] = await Promise.all([
    needs.origin ? readTransferSidePrice(store, args.originAssetId) : unread,
    needs.destination ? readTransferSidePrice(store, args.destinationAssetId) : unread,
  ]);

  const originMissing = needs.origin && origin.price === null;
  const destinationMissing = needs.destination && destination.price === null;
  if (originMissing || destinationMissing) {
    const without = [
      ...(originMissing ? [origin.name ?? "la inversión de origen"] : []),
      ...(destinationMissing ? [destination.name ?? "la inversión de destino"] : []),
    ];
    return {
      error:
        `No tengo valor liquidativo de ${without.map((name) => `«${name}»`).join(" ni de ")}, ` +
        "y sin él no puedo saber cuántas participaciones se mueven. Dime las " +
        "participaciones que salieron junto al importe («37,203 participaciones, 739,22 €») " +
        "y el valor liquidativo lo calculo yo; o regístralo desde «Traspasar» en la ficha de " +
        "la posición de origen, donde cada cifra tiene su campo.",
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
