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
  OPERATION_FOLIO,
  OPERATION_IMPACT_CAPTION,
  operationDestinationLine,
  operationDocumentLine,
  operationFactLine,
  operationKindLabel,
} from "./operation-proposal-copy";
import { type OperationTerms, resolveOperationTerms } from "./operation-terms";
import { readScopeNetWorthBeforeMinor } from "./proposal-net-worth";
import { boundProposalSummary } from "./proposal-summary";

type OperationStore = OperationProjectionStore & {
  assistantProposals: AssistantProposalStore;
};

/** The reads the live-data check needs — shared by the build and the confirm. */
export type OperationProjectionStore = Pick<WorthlineStore, "assets" | "operations"> & {
  agentView: WorthlineStore["agentView"];
};

export interface OperationArgs {
  /** Internal asset id, already resolved from the public `wl_hld_…`. */
  assetId: string;
  /** The `wl_hld_…` echoed back to the card. */
  publicHoldingId: string;
  kind: OperationKindClaim;
  /** The validated fact the document frontier resolved. Never the model's prose. */
  event: ExtractedHoldingEvent;
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
        `El justificante está en ${terms.currency} y «${holding.name}» se lleva en ` +
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
        `El documento es del ISIN ${write.documentIsin} y «${holding.name}» tiene registrado ` +
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
        `«${holding.name}» tiene ${formatUnits(unitsBefore)} participaciones y el justificante ` +
        `vende ${formatUnits(terms.units)}: no puedo anotar una venta que deje la posición en ` +
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
  const resolved = resolveOperationTerms(args.event);
  if (!resolved.ok) return resolved;
  const terms = resolved.terms;

  if (terms.executedAt > today) {
    return {
      ok: false,
      error:
        "Ese justificante lleva fecha futura, y una operación observada no puede estar por " +
        "ocurrir. Comprueba la fecha del documento.",
    };
  }

  const write: OperationWrite = {
    kind: args.kind,
    terms,
    ...(args.event.isin === undefined ? {} : { documentIsin: args.event.isin }),
  };
  const projected = await projectOperationWrite(store, args.assetId, write);
  if (!projected.ok) return projected;
  const { holding } = projected;

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
    ...(args.event.isin === undefined ? {} : { isin: args.event.isin }),
  };

  const proposal = await store.assistantProposals.create({
    kind: "investment_operation",
  });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      // Provenance `agent`: the fact reaching the ledger was read by worthline from a
      // document, not declared by the user, and that is the frontier this lane rests on.
      name: "justificante-de-operación",
      provenance: "agent",
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
        fact: operationFactLine({ ...terms, kind: args.kind }),
        line: operationDocumentLine({
          label: args.event.label,
          ...(args.event.isin === undefined ? {} : { isin: args.event.isin }),
        }),
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
      notes: terms.notes,
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
