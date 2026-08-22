/**
 * Reconstruction correction builder (#1053, PRD #1048 S5). The "Reconstruir
 * historia" depth of the correction proposal: a document-driven dated balance
 * series (extracted from a debt statement or amortization schedule, now also from
 * a PDF via S4) is reconstructed as a chain of re-baselines (ADR 0056) and
 * reconciled to the live anchor. It persists a `correction` proposal carrying the
 * RAW observed series + before-values; it writes no financial fact — the confirm
 * re-projects the (possibly point-edited) series and applies it as ONE atomic
 * batch. Presented on the SAME superficie C as the anchor-only depth (#1051).
 *
 * The reconstruction MATH is the proven `projectBalanceHistoryProposal` seam
 * (#696/#983); this module only reshapes it into a superficie-C correction card
 * and persists the reconstruct plan under the correction proposal kind.
 */

import { createHash } from "node:crypto";
import { parseBalanceHistoryRows } from "@web/patrimonio/import-balance-history";
import type {
  AssistantProposal,
  AssistantProposalStore,
  DatedBalanceObservation,
  ReconstructPointAmendment,
  WorthlineStore,
} from "@worthline/db";
import type { CorrectionGuarantee } from "./anchor-correction-gate";
import { projectBalanceHistoryProposal } from "./balance-history-proposals";
import {
  CORRECTION_FOLIO,
  type CorrectionSeriesPoint,
  type ReconstructionCorrectionProposal,
} from "./correction-proposal-contract";
import { boundProposalSummary } from "./proposal-summary";
import {
  amendedReconstructionSeries,
  effectiveReconstructionRows,
  normalizeReconstructionAmendments,
  type ReconstructionAmendmentOperation,
} from "./reconstruction-amendment";

type ProposalStore = Pick<WorthlineStore, "liabilities"> & {
  assistantProposals: AssistantProposalStore;
};

export interface ReconstructionArgs {
  /** Internal liability id, already resolved from the public wl_hld_… id. */
  liabilityId: string;
  /** The wl_hld_… id echoed back to the card and stored in the plan. */
  publicHoldingId: string;
  rows: unknown;
  summary?: string;
  documentName?: string;
  /** Point-level amendments to apply over `rows` (#1423). */
  amendments?: readonly ReconstructPointAmendment[];
  /** The superseded draft this proposal amends (#1423). */
  amendedFrom?: string;
}

export type ReconstructionBuildResult =
  | { ok: true; proposal: ReconstructionCorrectionProposal }
  | { ok: false; error: string };

/** Lo que el asistente quitó de la serie, dicho en la propia fila de la tarjeta. */
const AMENDED_EXCLUSION_REASON = "Excluido a tu petición";

/**
 * Map one projected preview row to a superficie-C series point. Only "accepted"
 * rows are included in the endpoint; "excluded"/"skipped" rows are shown folded
 * with their reason and never move the reconciliation.
 *
 * `corrected` son las fechas cuyo importe enmendó el asistente por encargo del
 * usuario (#1423): la fila lo dice igual que si él lo hubiera teclado en la
 * tarjeta, porque en los dos casos la cifra ya no es la del documento.
 */
function toSeriesPoint(
  preview: {
    date: string;
    balanceMinor: number;
    status: "accepted" | "excluded" | "skipped";
    reason?: string;
    driftMinor: number | null;
  },
  corrected: ReadonlySet<string>,
): CorrectionSeriesPoint {
  return {
    balanceMinor: preview.balanceMinor,
    date: preview.date,
    driftMinor: preview.driftMinor,
    excluded: preview.status !== "accepted",
    origin: corrected.has(preview.date) ? "user" : "assistant",
    ...(preview.reason === undefined ? {} : { reason: preview.reason }),
  };
}

/**
 * Devolver a la tarjeta los puntos que la enmienda excluyó (#1423).
 *
 * No se proyectan —por eso no salen en los previews— pero SÍ se pintan, con su
 * casilla marcada: así el usuario ve qué le quitó el asistente en su nombre y
 * desmarcarlo es un clic. Una tarjeta que solo mostrase los 45 supervivientes
 * escondería la mitad de lo que acaba de pasar.
 *
 * De una fecha repetida se pinta la ÚLTIMA observación, que es la que cierra el día
 * (#1422) y la que gobernaría la curva si volviese a entrar.
 */
function withExcludedPoints(
  points: readonly CorrectionSeriesPoint[],
  observations: readonly DatedBalanceObservation[],
  excludedDates: ReadonlySet<string>,
): CorrectionSeriesPoint[] {
  if (excludedDates.size === 0) return [...points];
  const lastByDate = new Map<string, DatedBalanceObservation>();
  for (const row of observations) {
    if (excludedDates.has(row.date)) lastByDate.set(row.date, row);
  }
  return [
    ...points,
    ...[...lastByDate.values()].map(
      (row): CorrectionSeriesPoint => ({
        balanceMinor: row.balanceMinor,
        date: row.date,
        driftMinor: null,
        excluded: true,
        origin: "user",
        reason: AMENDED_EXCLUSION_REASON,
      }),
    ),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

export async function buildReconstructionProposal(
  store: ProposalStore,
  args: ReconstructionArgs,
  today: string,
): Promise<ReconstructionBuildResult> {
  const parsed = parseBalanceHistoryRows(args.rows);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const amendments = normalizeReconstructionAmendments(args.amendments);
  const projected = await projectBalanceHistoryProposal(
    store,
    args.liabilityId,
    effectiveReconstructionRows(parsed.rows, amendments),
    today,
  );
  if (!projected.ok) return { ok: false, error: projected.error };

  const excludedDates = new Set(
    amendments.filter((item) => item.excluded).map((item) => item.date),
  );
  const correctedDates = new Set(
    amendments
      .filter((item) => !item.excluded && item.balanceMinor !== undefined)
      .map((item) => item.date),
  );
  const { reconciliation } = projected;
  const anchorMinor = reconciliation.expectedMinor;
  // Persist only the observed date + balance (never an inferred parameter); the
  // confirm re-projects this raw series against live data as the revalidation.
  // Amendments (#1423) ride ALONGSIDE it, never inside it: the observed series
  // keeps saying what the document said, and both together are the effective one.
  const observations = parsed.rows.map(({ balanceMinor, date }) => ({
    balanceMinor,
    date,
  }));
  const series = withExcludedPoints(
    projected.plan.previews.map((preview) => toSeriesPoint(preview, correctedDates)),
    observations,
    excludedDates,
  );
  const proposal = await store.assistantProposals.create({ kind: "correction" });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name:
        typeof args.documentName === "string" && args.documentName.trim()
          ? args.documentName.trim().slice(0, 255)
          : "serie-de-saldos",
      provenance: "agent",
      sha256: createHash("sha256").update(JSON.stringify(observations)).digest("hex"),
    },
    facts: [
      {
        kind: "holding_correction",
        row: {
          ...(amendments.length === 0 ? {} : { amendments }),
          ...(args.amendedFrom === undefined ? {} : { amendedFrom: args.amendedFrom }),
          // before = el saldo DECLARADO que había guardado, no el testigo contra
          // el que se midió: la confirmación puede reescribirlo (#1422), así que
          // es la cifra que un undo necesita recuperar. Es la de ESTE momento; si
          // algo la mueve entre armar la propuesta y confirmarla, el undo devuelve
          // la de aquí, no la última — la misma ventana que el resto del borrador.
          before: { balanceMinor: reconciliation.anchor.declaredMinor },
          holding: args.publicHoldingId,
          liabilityId: args.liabilityId,
          mode: "reconstruct",
          observations,
        },
      },
    ],
  });

  // The pristine guarantee is the engine's own reconciliation (the reconstructed
  // curve's endpoint vs the closest known witness, within tolerance — #1422). The
  // card shows a lightweight hint as the user excludes/edits points, and the
  // confirm re-projects the edited series server-side (authoritative) before
  // applying. A "mismatch" is a warning, no longer a locked door.
  const guarantee: CorrectionGuarantee = {
    anchorMinor,
    resultingMinor: reconciliation.resultingMinor,
    state: reconciliation.matches ? "reconciled" : "mismatch",
  };

  return {
    ok: true,
    proposal: {
      anchorMinor,
      curve: projected.curve,
      draft: { proposalId: proposal.id },
      folio: CORRECTION_FOLIO,
      guarantee,
      holding: { id: args.publicHoldingId, name: projected.liability.name },
      mode: "reconstruir",
      proposalType: "correction",
      reconciliation,
      series,
      snapshotMembership: projected.snapshotMembership,
      summary: boundProposalSummary(
        args.summary,
        `Reconstrucción de «${projected.liability.name}»${
          args.amendedFrom === undefined ? "" : " (enmendada)"
        }`,
      ),
    },
  };
}

/**
 * El plan de reconstrucción que lleva una propuesta de corrección, si lo es.
 *
 * El PRIMER `holding_correction`, igual que `correctionPlanOf` en el confirmar: una
 * propuesta de corrección lleva UNO, y una enmienda prepara otra propuesta en vez de
 * apilar documentos sobre ésta. Leer aquí el último y allí el primero sería dejar dos
 * lecturas capaces de discrepar en silencio sobre qué se va a aplicar.
 */
function reconstructPlanOf(proposal: AssistantProposal) {
  const fact = proposal.documents
    .flatMap((document) => document.facts)
    .find((item) => item.kind === "holding_correction");
  const plan = fact?.kind === "holding_correction" ? fact.row : null;
  // `observations` llega de un JSON del store tipado por casting, y la enmienda lo
  // recorre: comprobarlo aquí es lo que separa «no hay propuesta que enmendar» de una
  // excepción a mitad del turno.
  return plan?.mode === "reconstruct" && Array.isArray(plan.observations) ? plan : null;
}

export const RECONSTRUCTION_AMENDMENT_UNAVAILABLE =
  "No tengo ninguna propuesta de reconstrucción abierta con ese identificador. " +
  "Si la tarjeta ya se confirmó o se descartó, hay que preparar una nueva.";

export interface ReconstructionAmendmentArgs {
  /** El id que devolvió `propose_reconstruction` (o la enmienda anterior). */
  proposalId: string;
  operations: readonly ReconstructionAmendmentOperation[];
  summary?: string;
}

/**
 * Enmendar la propuesta de reconstrucción abierta (#1423).
 *
 * Prepara una propuesta NUEVA a partir de la anterior y descarta la anterior. Las
 * dos mitades importan:
 *  - Nueva, porque la tarjeta es el resultado de una tool call y la enmienda tiene
 *    que traer su propia tarjeta con la serie enmendada. Además deja rastro: en el
 *    hilo se ve qué se propuso y qué se enmendó.
 *  - La anterior se descarta porque su tarjeta sigue viva en el hilo con su botón,
 *    y confirmarla reenviaría la serie VIEJA (el estado de sus puntos vive en el
 *    cliente). Descartándola, ese botón responde «la propuesta ya no está
 *    disponible» en vez de escribir lo que el usuario acaba de corregir. Es también
 *    la respuesta a «¿cuántas propuestas abiertas puede haber sobre la misma
 *    deuda?»: la cadena de enmiendas deja una.
 *
 * El orden no es casual: si la nueva no se puede armar, la anterior sigue en pie.
 */
export async function buildReconstructionAmendment(
  store: ProposalStore,
  args: ReconstructionAmendmentArgs,
  today: string,
): Promise<ReconstructionBuildResult> {
  const source = await store.assistantProposals.read(args.proposalId);
  if (!source || source.kind !== "correction" || source.status !== "draft") {
    return { ok: false, error: RECONSTRUCTION_AMENDMENT_UNAVAILABLE };
  }
  const plan = reconstructPlanOf(source);
  if (!plan) return { ok: false, error: RECONSTRUCTION_AMENDMENT_UNAVAILABLE };

  const amended = amendedReconstructionSeries(
    plan.observations,
    normalizeReconstructionAmendments(plan.amendments),
    args.operations,
  );
  if (!amended.ok) return amended;

  // El nombre del documento viaja con la enmienda: la propuesta nueva sigue siendo
  // sobre el mismo cuadro, y perderlo dejaría la tarjeta hablando de «serie-de-saldos».
  const documentName = source.documents[0]?.document.name;
  const built = await buildReconstructionProposal(
    store,
    {
      amendedFrom: source.id,
      amendments: amended.amendments,
      liabilityId: plan.liabilityId,
      publicHoldingId: plan.holding,
      rows: plan.observations,
      ...(documentName === undefined ? {} : { documentName }),
      ...(args.summary === undefined ? {} : { summary: args.summary }),
    },
    today,
  );
  if (!built.ok) return built;
  await store.assistantProposals.markDiscarded(source.id);
  return built;
}
