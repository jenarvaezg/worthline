/**
 * The proposal message parts the guard tests share (#1468).
 *
 * One factory instead of a literal per test file: every one of these payloads is
 * coupled to what `parse*Proposal` accepts, so a contract change used to mean editing
 * the same object in six places — and the copy that was NOT edited kept passing while
 * asserting nothing, which is exactly how the guard came to be tested against outputs
 * no card would ever paint.
 */

import type { UIMessage } from "ai";

type Part = UIMessage["parts"][number];

/** The output a correction lane returns when it really prepared a proposal. */
export function correctionProposalOutput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    proposalType: "correction",
    draft: { proposalId: "wl_prp_1" },
    edits: [
      { after: "5.511,96 €", before: "6.000,00 €", label: "Saldo", origin: "user" },
    ],
    folio: "1 propuesta · 1 holding · 1 lote atómico",
    guarantee: { state: "declared" },
    holding: { id: "wl_hld_1", name: "Hipoteca" },
    mode: "solo-desde-hoy",
    summary: "Corrección del saldo de la hipoteca",
    ...overrides,
  };
}

/** A tool part of any shape — `state`, `output` and `errorText` ride in `rest`. */
export function toolPart(type: string, rest: Record<string, unknown> = {}): Part {
  return {
    input: { holdingId: "wl_hld_1" },
    toolCallId: "call-1",
    type,
    ...rest,
  } as unknown as Part;
}

/** A turn's proposal call that PAINTED a card. */
export function proposalCardPart(): Part {
  return toolPart("tool-propose_correction", {
    output: correctionProposalOutput(),
    state: "output-available",
  });
}

/**
 * The call worthline REFUSED: a `propose_*` part by name, no card by output. The error
 * is the one Jorge's dictated operations hit (#1466), which is the turn that opened
 * #1468 — but any refusal has this shape.
 */
export function rejectedProposalPart(): Part {
  return toolPart("tool-propose_operation", {
    output: { error: "operation_document_required" },
    state: "output-available",
    toolCallId: "call-2",
  });
}
