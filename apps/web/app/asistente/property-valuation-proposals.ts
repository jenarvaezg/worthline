import type {
  AssistantProposal,
  AssistantProposalStore,
  WorthlineStore,
} from "@worthline/db";
import { valueHousingAtDate } from "@worthline/domain";

import type { PropertyValuationProposal } from "./property-valuation-proposal-contract";

type ProposalStore = Pick<WorthlineStore, "assets"> & {
  assistantProposals: AssistantProposalStore;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function parsePropertyValuationAnchorInput(raw: unknown, today: string) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false as const, error: "Falta una valoración válida." };
  }
  const input = raw as Record<string, unknown>;
  if (
    typeof input.assetId !== "string" ||
    !input.assetId.trim() ||
    typeof input.valuationDate !== "string" ||
    !isCalendarDate(input.valuationDate) ||
    input.valuationDate > today ||
    !Number.isSafeInteger(input.valueMinor) ||
    (input.valueMinor as number) <= 0
  ) {
    return {
      ok: false as const,
      error: "La propuesta requiere inmueble, fecha y valor válidos.",
    };
  }
  return {
    ok: true as const,
    row: {
      assetId: input.assetId.trim(),
      valuationDate: input.valuationDate,
      valueMinor: input.valueMinor as number,
    },
  };
}

export function valuationAnchorFromProposal(proposal: AssistantProposal) {
  if (proposal.kind !== "property_valuation_anchor") return null;
  const facts = proposal.documents
    .flatMap((document) => document.facts)
    .filter((fact) => fact.kind === "property_valuation_anchor");
  return facts.length === 1 ? facts[0]!.row : null;
}

export async function projectPropertyValuationProposal(
  store: Pick<WorthlineStore, "assets">,
  assetId: string,
  valuationDate: string,
  valueMinor: number,
  today: string,
) {
  const property = (await store.assets.readAssets()).find(
    (asset) => asset.id === assetId && asset.type === "real_estate",
  );
  if (!property) return { ok: false as const, error: "El inmueble no existe." };
  const anchors = await store.assets.readValuationAnchors(assetId);
  if (anchors.some((anchor) => anchor.valuationDate === valuationDate)) {
    return { ok: false as const, error: "Ya existe una valoración en esa fecha." };
  }
  const annualAppreciationRate = await store.assets.readAnnualAppreciationRate(assetId);
  const proposed = { adjustsPriorCurve: true, valuationDate, valueMinor };
  const dates = Array.from(
    new Set([...anchors.map((anchor) => anchor.valuationDate), valuationDate, today]),
  ).sort();
  const curve = dates.map((date) => ({
    date,
    valueMinor: valueHousingAtDate({
      anchors: [...anchors, proposed],
      annualAppreciationRate,
      currentValueMinor: property.currentValue.amountMinor,
      targetDate: date,
      today,
    }),
  }));
  return { ok: true as const, property, curve };
}

export async function buildPropertyValuationProposal(
  store: ProposalStore,
  raw: unknown,
  today: string,
) {
  const parsed = parsePropertyValuationAnchorInput(raw, today);
  if (!parsed.ok) return parsed;
  const input = raw as Record<string, unknown>;
  if (typeof input.documentSha256 !== "string" || !SHA256.test(input.documentSha256)) {
    return { ok: false as const, error: "Falta la huella SHA-256 del documento." };
  }
  const row = parsed.row;
  const projected = await projectPropertyValuationProposal(
    store,
    row.assetId,
    row.valuationDate,
    row.valueMinor,
    today,
  );
  if (!projected.ok) return projected;
  const proposal = await store.assistantProposals.create({
    kind: "property_valuation_anchor",
  });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name:
        typeof input.documentName === "string" && input.documentName.trim()
          ? input.documentName.trim().slice(0, 255)
          : "tasacion-inmueble",
      provenance: "agent",
      sha256: input.documentSha256,
    },
    facts: [{ kind: "property_valuation_anchor", row }],
  });
  return {
    ok: true as const,
    proposal: {
      proposalType: "property_valuation_anchor",
      draft: { proposalId: proposal.id },
      property: { id: projected.property.id, name: projected.property.name },
      anchor: { valuationDate: row.valuationDate, valueMinor: row.valueMinor },
      curve: projected.curve,
      trust: { tier: "unverified", requiresReview: true },
    } satisfies PropertyValuationProposal,
  };
}
