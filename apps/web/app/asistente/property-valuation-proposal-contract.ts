export interface PropertyValuationProposalDraft {
  proposalId: string;
}

export interface PropertyValuationProposal {
  proposalType: "property_valuation_anchor";
  draft: PropertyValuationProposalDraft;
  property: { id: string; name: string };
  anchor: { valuationDate: string; valueMinor: number };
  curve: Array<{ date: string; valueMinor: number }>;
  trust: { tier: "unverified"; requiresReview: true };
}

export function parsePropertyValuationProposalDraft(raw: unknown) {
  const proposalId =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)["proposalId"]
      : undefined;
  if (typeof proposalId !== "string" || !proposalId.trim()) {
    return { ok: false as const, error: "Falta la referencia de la propuesta." };
  }
  return {
    ok: true as const,
    draft: { proposalId: proposalId.trim() },
  };
}
