/**
 * Operation proposal builder (#1374). Closes the gap the real session named: «añádeme
 * esta compra», with the aportación confirmation attached, is the most ordinary
 * request there is over a manual portfolio — and there was no lane for it. The
 * inventory had a batch reconcile, an alta, a correction and a statement import, so
 * the model improvised with the reconcile, whose schema demands each row's current
 * `value`, and filled that mandatory field with a snapshot of the portfolio.
 *
 * This writes NOTHING. It resolves the observed fact into the terms the ledger will
 * record ({@link resolveOperationTerms}), checks them against live data
 * ({@link projectOperationWrite}), persists the fact as a draft proposal, and returns
 * the preview. The confirm action applies it through the operations engine.
 *
 * Four frontiers, all in code and not in the tool's prose (ADR 0067): the holding must
 * be a MANUAL investment (a sync-owned position is the source's to write), the
 * currencies must agree (no rate is ever invented), the document's ISIN may not
 * contradict the holding's, and the same operation is never written twice —
 * re-uploading the same receipt next week must not double the units.
 *
 * Since #1466 the fact reaches here through either of two doors — a validated document
 * or the user's own message, read by worthline ({@link OperationFactSource}) — and every
 * one of those frontiers applies unchanged to both, which is the whole reason the typed
 * lane hands over an {@link ExtractedHoldingEvent}. Two things belong to the typed door
 * alone: the currency, taken from the holding when the message marked none and SAID on
 * the card, and the declared-total witness, checked against the book and never written
 * (#1422).
 */

import { createHash } from "node:crypto";
import type {
  AssistantProposal,
  AssistantProposalStore,
  InvestmentOperationPlan,
  WorthlineStore,
} from "@worthline/db";
import {
  addUnits,
  compareUnits,
  type DecimalString,
  formatUnits,
  multiplyToMinor,
  netUnitsFromOperations,
  normalizeDecimal,
  subtractUnits,
} from "@worthline/domain";

import type { ExtractedHoldingEvent } from "./attachment-extraction-contract";
import {
  connectedSourceValueRejection,
  readConnectedSourceOwners,
} from "./connected-source-write-guard";
import { formatIsoDayEs } from "./iso-day-es";
import type { OperationKindClaim } from "./operation-document-frontier";
import type { OperationProposal } from "./operation-proposal-contract";
import {
  OPERATION_DICTATED_CAPTION,
  OPERATION_DOCUMENT_CAPTION,
  OPERATION_FOLIO,
  OPERATION_IMPACT_CAPTION,
  operationCurrencyAssumedNote,
  operationDeclaredTotalMismatch,
  operationDerivedAmountNote,
  operationDestinationLine,
  operationDictatedLine,
  operationDocumentLine,
  operationFactLine,
  operationKindLabel,
} from "./operation-proposal-copy";
import { type OperationTerms, resolveOperationTerms } from "./operation-terms";
import { readScopeNetWorthBeforeMinor } from "./proposal-net-worth";
import { boundProposalSummary } from "./proposal-summary";
import {
  holdingEventFromTyped,
  TYPED_OPERATION_DOCUMENT_NAME,
  type TypedHoldingEvent,
} from "./typed-holding-event";

type OperationStore = OperationProjectionStore & {
  assistantProposals: AssistantProposalStore;
};

/** The reads the live-data check needs — shared by the build and the confirm. */
export type OperationProjectionStore = Pick<WorthlineStore, "assets" | "operations"> & {
  agentView: WorthlineStore["agentView"];
};

/**
 * Where the fact came from — the two doors of the lane, and never the model's prose.
 * A validated extraction, or the operation worthline read in the user's own message.
 */
export type OperationFactSource =
  | { from: "document"; event: ExtractedHoldingEvent }
  | { from: "message"; typed: TypedHoldingEvent };

export interface OperationArgs {
  /** Internal asset id, already resolved from the public `wl_hld_…`. */
  assetId: string;
  /** The `wl_hld_…` echoed back to the card. */
  publicHoldingId: string;
  kind: OperationKindClaim;
  /** The fact one of the two frontiers resolved. Never the model's prose. */
  source: OperationFactSource;
  summary?: string;
}

/** What is about to be written, once the observed fact has been resolved. */
export interface OperationWrite {
  kind: OperationKindClaim;
  terms: OperationTerms;
  /** The ISIN the document prints, when it prints one. */
  documentIsin?: string;
}

/**
 * The route offered when the target is not a manual investment holding. It does NOT
 * claim to know which of the two things went wrong — the read that answers this is a
 * list of investments, so «no existe» and «existe pero es una cuenta» arrive
 * identically — and saying «esa posición no es una inversión» about an id that names
 * nothing would misdiagnose it. Both ways out are named instead.
 */
const NOT_AN_INVESTMENT =
  "No encuentro esa posición entre las inversiones con participaciones de la cartera: o no " +
  "existe, o es de otra familia (una cuenta, un inmueble, una deuda). Una operación fechada " +
  "solo tiene sentido sobre un fondo, un ETF, una acción, un índice, un plan de pensiones o " +
  "una cripto: busca la posición por su nombre para confirmar cuál es, y si de verdad no " +
  "está en la cartera, dala de alta antes de anotarle la operación. Si lo que quieres es " +
  "corregir su saldo o su valor, ésa es otra propuesta.";

export interface ProjectedOperation {
  ok: true;
  holding: { id: string; name: string; currency: string; isin?: string };
  unitsBefore: DecimalString;
  unitsAfter: DecimalString;
}

/** The ledger kind an observed operation is written as (an aportación is a buy). */
export function ledgerOperationKind(kind: OperationKindClaim): "buy" | "sell" {
  return kind === "sell" ? "sell" : "buy";
}

/**
 * Check the resolved write against the LIVE holding and its position, and report the
 * participaciones before → after. Shared by the build and the confirm — and it takes
 * already-resolved {@link OperationTerms} rather than the document, so the confirm
 * re-checks the very figures it is about to persist instead of re-reading a fact it no
 * longer has.
 */
export async function projectOperationWrite(
  store: OperationProjectionStore,
  assetId: string,
  write: OperationWrite,
): Promise<ProjectedOperation | { ok: false; error: string }> {
  const investments = await store.assets.readInvestmentAssetsWithMeta();
  const holding = investments.find((item) => item.id === assetId);
  if (!holding) return { ok: false as const, error: NOT_AN_INVESTMENT };

  // The connected-source frontier, enforced in code (#1326): a sync-owned position's
  // units come from the mirrored positions, so a hand-written operation would be
  // overwritten by the next sync — and until then it would double-count.
  const owner = (await readConnectedSourceOwners(store.agentView)).get(assetId);
  if (owner) {
    return {
      ok: false as const,
      error: connectedSourceValueRejection(owner, holding.name),
    };
  }

  const { terms } = write;
  if (terms.currency.toUpperCase() !== holding.currency.toUpperCase()) {
    return {
      ok: false as const,
      error:
        `La operación está en ${terms.currency} y «${holding.name}» se lleva en ` +
        `${holding.currency}: no convierto divisas por mi cuenta, así que no puedo anotar la ` +
        "operación aquí. Comprueba si es de otra posición.",
    };
  }

  // The identity contradiction (#1331/#1366's lesson): an ISIN printed on the paper
  // that disagrees with the one registered on the holding means the paper is about a
  // DIFFERENT instrument, and this lane's whole reason to exist is that a jump of
  // holding used to be invisible. A holding with no ISIN registered contradicts
  // nothing — the card prints both lines and the user sees what is being matched.
  const documentIsin = write.documentIsin?.toUpperCase();
  if (documentIsin && holding.isin && holding.isin.toUpperCase() !== documentIsin) {
    return {
      ok: false as const,
      error:
        `La operación es del ISIN ${write.documentIsin} y «${holding.name}» tiene registrado ` +
        `${holding.isin}: son instrumentos distintos, así que no anoto la operación ahí. Busca ` +
        "la posición de ese ISIN en la cartera, y si no existe, dala de alta.",
    };
  }

  const operations = await store.operations.readOperations(assetId);
  const kind = ledgerOperationKind(write.kind);
  // The unique index the ledger does NOT have: nothing stops two identical operations,
  // so the duplicate is detected HERE and the answer is a sentence instead of a
  // silently doubled position when the same receipt is uploaded twice.
  const duplicate = operations.some(
    (operation) =>
      operation.executedAt.slice(0, 10) === terms.executedAt &&
      operation.kind === kind &&
      // Through the decimal seam, never as strings: «5.920» and «5.92» are the same
      // quantity, and a string compare would let the second upload of one receipt
      // double the position — precisely what this guard exists to stop.
      compareUnits(operation.units, terms.units) === 0,
  );
  if (duplicate) {
    return {
      ok: false as const,
      error:
        `Esa operación ya está anotada: «${holding.name}» tiene una ${operationKindLabel(write.kind)} ` +
        `del ${formatIsoDayEs(terms.executedAt)} por ${formatUnits(terms.units)} participaciones. ` +
        "No la duplico ni sumo importes; si la cifra registrada es otra, se corrige en las " +
        "operaciones de esa posición, dentro de Patrimonio.",
    };
  }

  const unitsBefore = netUnitsFromOperations(operations);
  const unitsAfter =
    kind === "sell"
      ? subtractUnits(unitsBefore, terms.units)
      : addUnits(unitsBefore, terms.units);
  if (kind === "sell" && Number(unitsAfter) < 0) {
    return {
      ok: false as const,
      error:
        `«${holding.name}» tiene ${formatUnits(unitsBefore)} participaciones y esta venta saca ` +
        `${formatUnits(terms.units)}: no puedo anotar una venta que deje la posición en ` +
        "negativo. Comprueba si falta registrar alguna compra anterior, o si la venta es de otra " +
        "posición.",
    };
  }

  return {
    holding: {
      currency: holding.currency,
      id: holding.id,
      name: holding.name,
      ...(holding.isin === undefined ? {} : { isin: holding.isin }),
    },
    ok: true as const,
    unitsAfter,
    unitsBefore,
  };
}

/** The single operation plan an `investment_operation` proposal carries. */
export function operationPlanFromProposal(
  proposal: AssistantProposal,
): InvestmentOperationPlan | null {
  if (proposal.kind !== "investment_operation") return null;
  const facts = proposal.documents
    .flatMap((document) => document.facts)
    .filter((fact) => fact.kind === "investment_operation");
  return facts.length === 1 ? facts[0]!.row : null;
}

/**
 * The persisted plan read back as the write it describes — what the confirm re-checks
 * against live data. The plan IS the resolved terms, so nothing is recomputed here and
 * no synthetic document is rebuilt: the figures that get checked are the figures that
 * get written.
 */
export function operationWriteFromPlan(plan: InvestmentOperationPlan): OperationWrite {
  return {
    kind: plan.kind,
    terms: {
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      executedAt: plan.executedAt,
      notes: [],
      pricePerUnit: plan.pricePerUnit,
      units: plan.units,
      ...(plan.feesMinor === undefined ? {} : { feesMinor: plan.feesMinor }),
    },
    ...(plan.isin === undefined ? {} : { documentIsin: plan.isin }),
  };
}

export async function buildOperationProposal(
  store: OperationStore,
  args: OperationArgs,
  today: string,
): Promise<{ ok: true; proposal: OperationProposal } | { ok: false; error: string }> {
  const fact = await resolveOperationFact(store, args);
  const { dictated, event } = fact;
  const resolved = resolveOperationTerms(event);
  if (!resolved.ok) return resolved;
  const terms = resolved.terms;

  if (terms.executedAt > today) {
    return {
      ok: false,
      error:
        dictated === null
          ? "Ese justificante lleva fecha futura, y una operación observada no puede estar por " +
            "ocurrir. Comprueba la fecha del documento."
          : "Esa operación lleva fecha futura, y no anoto un hecho que aún no ha ocurrido. " +
            "Comprueba el día que me has dicho.",
    };
  }

  const write: OperationWrite = {
    kind: args.kind,
    terms,
    ...(event.isin === undefined ? {} : { documentIsin: event.isin }),
  };
  const projected = await projectOperationWrite(store, args.assetId, write);
  if (!projected.ok) return projected;
  const { holding } = projected;

  // The witness (#1422): a total the user declared is CHECKED against the book and
  // never written. It is optional — most messages state none — and when it does not
  // hold, both figures are named, because the discrepancy is as likely to be an
  // operation missing from the ledger as a typo in the message.
  const declaredTotalUnits = dictated?.declaredTotalUnits;
  if (
    declaredTotalUnits !== undefined &&
    compareUnits(normalizeDecimal(declaredTotalUnits), projected.unitsAfter) !== 0
  ) {
    return {
      ok: false,
      error: operationDeclaredTotalMismatch({
        declaredTotalUnits,
        holdingName: holding.name,
        unitsAfter: projected.unitsAfter,
        unitsBefore: projected.unitsBefore,
      }),
    };
  }

  const plan: InvestmentOperationPlan = {
    amountMinor: terms.amountMinor,
    assetId: holding.id,
    currency: terms.currency,
    executedAt: terms.executedAt,
    holding: args.publicHoldingId,
    kind: ledgerOperationKind(args.kind),
    pricePerUnit: terms.pricePerUnit,
    units: terms.units,
    ...(terms.feesMinor === undefined ? {} : { feesMinor: terms.feesMinor }),
    ...(event.isin === undefined ? {} : { isin: event.isin }),
  };

  const proposal = await store.assistantProposals.create({
    kind: "investment_operation",
  });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      // Provenance: `agent` when the fact was READ by worthline off a document, `user`
      // when the person dictated it. The distinction is the frontier itself, so it is
      // recorded rather than flattened — the traspaso's dictated lane marks it the same
      // way (#1482).
      name:
        dictated === null ? "justificante-de-operación" : TYPED_OPERATION_DOCUMENT_NAME,
      provenance: dictated === null ? "agent" : "user",
      sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    },
    facts: [{ kind: "investment_operation", row: plan }],
  });

  const netWorthBeforeMinor = await readScopeNetWorthBeforeMinor(store.agentView, today);
  // What the LEDGER will value the operation at — `participaciones × precio`, i.e. the
  // amount net of the commission — and not the gross figure the document states. The
  // fee is a cost, not position value, so a gross delta overstates the change by it.
  const positionMinor = multiplyToMinor(terms.units, terms.pricePerUnit);
  const deltaMinor = plan.kind === "sell" ? -positionMinor : positionMinor;

  return {
    ok: true,
    proposal: {
      document: {
        caption:
          dictated === null ? OPERATION_DOCUMENT_CAPTION : OPERATION_DICTATED_CAPTION,
        fact: operationFactLine({ ...terms, kind: args.kind }),
        line:
          dictated === null
            ? operationDocumentLine({
                label: event.label,
                ...(event.isin === undefined ? {} : { isin: event.isin }),
              })
            : operationDictatedLine(dictated, terms.currency),
      },
      draft: { proposalId: proposal.id },
      folio: OPERATION_FOLIO,
      holding: {
        destination: operationDestinationLine(holding),
        id: args.publicHoldingId,
        name: holding.name,
      },
      impact: {
        afterMinor:
          netWorthBeforeMinor === null ? null : netWorthBeforeMinor + deltaMinor,
        beforeMinor: netWorthBeforeMinor,
        deltaMinor,
      },
      impactCaption: OPERATION_IMPACT_CAPTION,
      kind: args.kind,
      notes: dictatedNotes(fact, terms, holding.name).concat(terms.notes),
      position: {
        unitsAfter: formatUnits(projected.unitsAfter),
        unitsBefore: formatUnits(projected.unitsBefore),
      },
      proposalType: "investment_operation",
      summary: boundProposalSummary(
        args.summary,
        `${capitalize(operationKindLabel(args.kind))} de ${formatUnits(terms.units)} participaciones en «${holding.name}»`,
      ),
    },
  };
}

/** The fact this build works from, with the typed door's own two answers alongside. */
interface ResolvedOperationFact {
  event: ExtractedHoldingEvent;
  /** What the user typed, when the fact came through the message door. */
  dictated: TypedHoldingEvent | null;
  /** The currency taken from the HOLDING because the message marked none. */
  assumedCurrency: string | null;
}

/**
 * The event the chain builds from, whichever door the fact came through.
 *
 * The one asymmetry is the currency, and it is the reason this reads the holding before
 * the projection does: «por 312,55» with no mark is read in the holding's own currency
 * (the guard downstream already refuses anything else, and the card says which one it
 * was), and a holding that does not exist yields no currency at all — the placeholder
 * then reaches {@link projectOperationWrite}, which answers with the route for an id
 * that names nothing rather than with a currency complaint.
 */
async function resolveOperationFact(
  store: OperationProjectionStore,
  args: OperationArgs,
): Promise<ResolvedOperationFact> {
  if (args.source.from === "document") {
    return { assumedCurrency: null, dictated: null, event: args.source.event };
  }
  const typed = args.source.typed;
  const currency =
    typed.currency ?? (await holdingCurrency(store, args.assetId)) ?? FALLBACK_CURRENCY;
  return {
    assumedCurrency: typed.currency === null ? currency : null,
    dictated: typed,
    event: holdingEventFromTyped(typed, currency),
  };
}

/**
 * The currency used when the message marked none AND the holding has none to lend —
 * which happens only when the id names nothing, because every investment holding is
 * created with one. It is deliberately NOT «assume EUR» (#1401's sin): the placeholder
 * exists so the call reaches {@link projectOperationWrite}, which answers with the route
 * for an id that names no investment. A currency this value ever reached the ledger with
 * would first have to pass that projection's own currency check against the holding.
 */
const FALLBACK_CURRENCY = "EUR";

/**
 * The currency of the holding the operation points at, or null when no investment has
 * that id. Read only for a dictated operation, so the document lane costs exactly what
 * it did before.
 */
async function holdingCurrency(
  store: OperationProjectionStore,
  assetId: string,
): Promise<string | null> {
  const investments = await store.assets.readInvestmentAssetsWithMeta();
  return investments.find((item) => item.id === assetId)?.currency ?? null;
}

/**
 * What the card has to say about a DICTATED operation before anything else: the importe
 * that was multiplied out of two written figures, and the currency that came from the
 * holding rather than from the message. Both are readings the person can only check if
 * they are told (#1401, #1418).
 */
function dictatedNotes(
  fact: ResolvedOperationFact,
  terms: OperationTerms,
  holdingName: string,
): string[] {
  const { assumedCurrency, dictated } = fact;
  const notes: string[] = [];
  if (
    dictated !== null &&
    dictated.amount === undefined &&
    dictated.units !== undefined &&
    dictated.pricePerUnit !== undefined
  ) {
    notes.push(
      operationDerivedAmountNote({
        amountMinor: terms.amountMinor,
        currency: terms.currency,
        pricePerUnit: dictated.pricePerUnit,
        units: dictated.units,
      }),
    );
  }
  if (assumedCurrency !== null) {
    notes.push(operationCurrencyAssumedNote(assumedCurrency, holdingName));
  }
  return notes;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
