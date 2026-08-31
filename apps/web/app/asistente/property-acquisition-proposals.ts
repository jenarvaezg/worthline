/**
 * Property-acquisition proposal builder (#1563, hija de #1437).
 *
 * The date and the price of an acquisition are the ALLOWED side of the
 * unvalidated-evidence frontier (#1248): a single dated fact that is verified at a
 * glance — a deed, a note, the user's own Excel — and never a figure that needs
 * research. So the assistant may prepare it, the human eye validates it in the
 * preview, and the write itself goes through the deterministic command.
 *
 * What it is NOT is its sibling `property-valuation-proposals`. That one ADDS one
 * more tasación; this one MOVES the anchor that decides FROM WHEN the property
 * exists in the history (`historical-snapshot.ts` gates on the first appraisal), and
 * therefore whether the mortgage it secures shows up at all — the failure that
 * filed #1437, where a flat bought in 2004 read as bought the day it was typed and
 * 266 snapshots lost their debt.
 *
 * It writes NOTHING. It reads the property's live anchors, refuses everything that
 * is not that single fact, projects the resulting curve, persists the fact as a
 * draft, and returns the preview. The confirm action applies it.
 */

import { createHash } from "node:crypto";
import type {
  AssistantProposal,
  AssistantProposalStore,
  WorthlineStore,
} from "@worthline/db";
import {
  type AcquisitionEditPreview,
  buildAcquisitionEditPreview,
  formatMoneyMinorExact,
} from "@worthline/domain";

import { isIsoDay } from "./attachment-extraction-contract";
import { formatIsoDayEs } from "./iso-day-es";
import {
  PROPERTY_ACQUISITION_FOLIO,
  type PropertyAcquisitionProposal,
} from "./property-acquisition-proposal-contract";

type ProposalStore = Pick<WorthlineStore, "assets"> & {
  assistantProposals: AssistantProposalStore;
};
type AssetReads = Pick<WorthlineStore, "assets">;

/**
 * Where the acquisition is edited by hand. Named as the user navigates it and with
 * no id in it (#1318): this sentence reaches the model, and an internal id is
 * something it can neither use nor hand to a person.
 */
const FICHA_ROUTE =
  "en /patrimonio, abriendo el inmueble y editando su «Adquisición» (fecha y valor)";

/**
 * What the model may pass, and NOTHING else — in particular no `summary`.
 *
 * Every sibling lane lets it write the card's headline; this one does not, because
 * the headline it would replace is already complete and comes from the store: the
 * property's own name, the date and the value. A model-written sentence next to a
 * Confirmar button is the most valuable string in the product for a prompt
 * injection to own (`proposal-summary.ts` says why), so a lane that does not need
 * one does not offer one.
 */
export interface PropertyAcquisitionArgs {
  /** Internal asset id, already resolved from the public `wl_hld_…`. */
  assetId: string;
  acquisitionDate: string;
  acquisitionValueMinor: number;
}

export interface ParsedPropertyAcquisition {
  assetId: string;
  valuationDate: string;
  valueMinor: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && isIsoDay(value);
}

/** Cents-precise es-ES money — an acquisition price is exact to the cent. */
function money(amountMinor: number, currency: string): string {
  return formatMoneyMinorExact({ amountMinor, currency });
}

/**
 * The trust boundary for the model's arguments.
 *
 * Money is integer minor units and a non-integer is REJECTED, never rounded: the
 * user's figure is «150.253,03 €», so `150253.03` arriving here is the
 * euros-for-cents mistake, and rounding it would write a price nobody read. A
 * future date is refused because an acquisition is something that HAPPENED.
 */
export function parsePropertyAcquisitionInput(raw: unknown, today: string) {
  if (!isRecord(raw)) {
    return { ok: false as const, error: "Falta una adquisición válida." };
  }
  if (typeof raw.assetId !== "string" || !raw.assetId.trim()) {
    return { ok: false as const, error: "Falta el inmueble cuya adquisición mover." };
  }
  if (!isCalendarDate(raw.acquisitionDate)) {
    return {
      ok: false as const,
      error: "Falta la fecha de adquisición (YYYY-MM-DD) o no es una fecha real.",
    };
  }
  if (raw.acquisitionDate > today) {
    return {
      ok: false as const,
      error: "Una adquisición ya ocurrida no puede tener fecha futura.",
    };
  }
  if (
    !Number.isSafeInteger(raw.acquisitionValueMinor) ||
    (raw.acquisitionValueMinor as number) <= 0
  ) {
    return {
      ok: false as const,
      error:
        "El valor en la fecha de compra va en CÉNTIMOS enteros y positivos (150.253,03 € son 15025303). No redondeo un importe con decimales: comprueba la cifra.",
    };
  }
  return {
    ok: true as const,
    row: {
      assetId: raw.assetId.trim(),
      valuationDate: raw.acquisitionDate,
      valueMinor: raw.acquisitionValueMinor as number,
    } satisfies ParsedPropertyAcquisition,
  };
}

/** The single acquisition fact a `property_acquisition` proposal carries. */
export function acquisitionFromProposal(proposal: AssistantProposal) {
  if (proposal.kind !== "property_acquisition") return null;
  const facts = proposal.documents
    .flatMap((document) => document.facts)
    .filter((fact) => fact.kind === "property_acquisition");
  return facts.length === 1 ? facts[0]!.row : null;
}

export interface ProjectedPropertyAcquisition {
  ok: true;
  property: { id: string; name: string; currency: string };
  /** The live acquisition anchor this proposal moves. */
  anchor: { id: string; valuationDate: string; valueMinor: number };
  /** The two curves, valued by the engine that writes them (#1562). */
  preview: AcquisitionEditPreview;
  notes: string[];
}

/**
 * Re-read the property's live anchors and project the move. Shared by the build and
 * the confirm, so a draft armed against anchors that have since changed is
 * re-projected rather than replayed — the rule the early repayment established
 * (#1245) and the reason a stale draft fails honestly instead of writing.
 */
export async function projectPropertyAcquisitionProposal(
  store: AssetReads,
  row: Pick<ParsedPropertyAcquisition, "assetId" | "valuationDate" | "valueMinor">,
  today: string,
): Promise<ProjectedPropertyAcquisition | { ok: false; error: string }> {
  const property = (await store.assets.readAssets()).find(
    (asset) => asset.id === row.assetId && asset.type === "real_estate",
  );
  if (!property) {
    return { ok: false as const, error: "No encuentro ese inmueble en el workspace." };
  }
  const anchors = await store.assets.readValuationAnchors(row.assetId);
  const acquisition = anchors.find((anchor) => anchor.kind === "acquisition");
  if (!acquisition) {
    // A property from before #1437 whose backfill found nothing to mark. There is
    // no anchor to move, and inventing one here would be minting the very fact
    // this lane exists to correct — so it routes to the surface that owns it.
    return {
      ok: false as const,
      error: `«${property.name}» no tiene marcada un ancla de adquisición, así que no hay fecha de adquisición que mover. Se edita ${FICHA_ROUTE}.`,
    };
  }
  if (
    acquisition.valuationDate === row.valuationDate &&
    acquisition.valueMinor === row.valueMinor
  ) {
    // A no-op would be a confirmed proposal that changes nothing and a ripple over
    // every snapshot of the property for it.
    return {
      ok: false as const,
      error: `La adquisición de «${property.name}» ya está registrada así: ${formatIsoDayEs(acquisition.valuationDate)} · ${money(acquisition.valueMinor, property.currency)}.`,
    };
  }
  const others = anchors.filter((anchor) => anchor.id !== acquisition.id);
  const collision = others.find((anchor) => anchor.valuationDate === row.valuationDate);
  if (collision) {
    // One anchor per asset per date is a unique index: detected here so the answer
    // is a sentence instead of a database error at confirm time.
    return {
      ok: false as const,
      error: `«${property.name}» ya tiene una valoración con fecha ${formatIsoDayEs(row.valuationDate)}, y solo puede haber una por fecha. Si esa valoración ES la adquisición, corrígela ${FICHA_ROUTE}.`,
    };
  }

  const [annualAppreciationRate, cadence] = await Promise.all([
    store.assets.readAnnualAppreciationRate(row.assetId),
    store.assets.readValuationCadence(row.assetId),
  ]);
  // The SAME engine the ficha's ceremony previews with and the ripple writes with
  // (#1562, ADR 0070 §4): both curves valued point by point, the roles named, and
  // interior samples of the redrawn stretch included — without them a price-only
  // change shows one row moving while twenty-two years move unseen. A second
  // hand-rolled curve here is exactly the two-engines-without-a-careo of #1438,
  // and it would also have quietly ignored the asset's valuation cadence.
  //
  // The acquisition rides in as a market appraisal on both sides because that is
  // what the write enforces: `updateValuationAnchorAndRipple` forces
  // `adjustsPriorCurve: true` on this anchor for every route (#1563), so a legacy
  // row demoted by the old form is repaired rather than preserved.
  const preview = buildAcquisitionEditPreview({
    annualAppreciationRate,
    cadence,
    current: {
      valuationDate: acquisition.valuationDate,
      valueMinor: acquisition.valueMinor,
    },
    currentValueMinor: property.currentValue.amountMinor,
    edited: { valuationDate: row.valuationDate, valueMinor: row.valueMinor },
    otherAnchors: others,
    today,
  });

  // The from-date of the rewrite comes from that same preview, so the sentence and
  // the curve cannot disagree: moving an acquisition FORWARD rewrites the tramo it
  // is leaving behind too, which is why it is the earlier of the two dates.
  const rippleFrom = preview.fromDateKey;
  const earliestOther = others
    .map((anchor) => anchor.valuationDate)
    .sort()
    .at(0);
  const notes = [
    `Se recalcula el valor del inmueble desde el ${formatIsoDayEs(rippleFrom)}: worthline vuelve a interpolar la curva entre la adquisición y la valoración siguiente.`,
    ...(acquisition.valuationDate === row.valuationDate
      ? []
      : [
          `El histórico del inmueble empezará el ${formatIsoDayEs(row.valuationDate)} en vez del ${formatIsoDayEs(acquisition.valuationDate)}.`,
        ]),
    ...(earliestOther !== undefined && earliestOther < row.valuationDate
      ? [
          `Ojo: «${property.name}» tiene una valoración anterior a esa fecha (${formatIsoDayEs(earliestOther)}), así que seguirá apareciendo en el histórico desde ella.`,
        ]
      : []),
  ];

  return {
    anchor: {
      id: acquisition.id,
      valuationDate: acquisition.valuationDate,
      valueMinor: acquisition.valueMinor,
    },
    notes,
    preview,
    ok: true as const,
    property: {
      currency: property.currency,
      id: property.id,
      name: property.name,
    },
  };
}

export async function buildPropertyAcquisitionProposal(
  store: ProposalStore,
  raw: unknown,
  today: string,
): Promise<
  { ok: true; proposal: PropertyAcquisitionProposal } | { ok: false; error: string }
> {
  const parsed = parsePropertyAcquisitionInput(raw, today);
  if (!parsed.ok) return parsed;
  const projected = await projectPropertyAcquisitionProposal(store, parsed.row, today);
  if (!projected.ok) return projected;

  const { anchor, property } = projected;
  const row = {
    assetId: parsed.row.assetId,
    valuationDate: parsed.row.valuationDate,
    valueMinor: parsed.row.valueMinor,
  };
  const proposal = await store.assistantProposals.create({
    kind: "property_acquisition",
  });
  await store.assistantProposals.appendDocument(proposal.id, {
    // Chat-declared, like the early repayment (#1245): the document is the user's
    // own sentence, and the provenance mark of a capture it may have been read off
    // dies in the preview (PRD #1241, decision 4).
    document: {
      name: "declaración-del-usuario",
      provenance: "user",
      sha256: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
    },
    facts: [{ kind: "property_acquisition", row }],
  });

  const euros = (amountMinor: number) => money(amountMinor, property.currency);
  return {
    ok: true,
    proposal: {
      draft: { proposalId: proposal.id },
      folio: PROPERTY_ACQUISITION_FOLIO,
      notes: projected.notes,
      points: projected.preview.points,
      property: { id: property.id, name: property.name },
      proposalType: "property_acquisition",
      rows: [
        {
          after: formatIsoDayEs(row.valuationDate),
          before: formatIsoDayEs(anchor.valuationDate),
          label: "Fecha de adquisición",
        },
        {
          after: euros(row.valueMinor),
          before: euros(anchor.valueMinor),
          label: "Valor en la fecha de compra",
        },
      ],
      summary: `Adquisición de «${property.name}»: ${formatIsoDayEs(row.valuationDate)} · ${euros(row.valueMinor)}`,
    },
  };
}
