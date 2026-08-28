/**
 * The message parts the ceremony-guard tests share (#1468, #1525).
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

/** The alert call that really reached the control plane — the ONE success shape. */
export function raisedAlertPart(): Part {
  return toolPart("tool-raise_maintainer_alert", {
    output: { alertId: "wl_alr_1", alertStatus: "open", created: true, status: "raised" },
    state: "output-available",
    toolCallId: "call-3",
  });
}

/**
 * The call the admission gate REFUSED (#1347) — the answer Jorge's turn got and
 * narrated as success (#1525). Any non-`raised` answer has this shape as far as the
 * guard is concerned; this is the one from the transcript.
 */
export function refusedAlertPart(): Part {
  return toolPart("tool-raise_maintainer_alert", {
    output: {
      error: "maintainer_alert_without_discrepancy",
      message: "Esta alerta solo sirve para un descuadre de CIFRAS de worthline",
    },
    state: "output-available",
    toolCallId: "call-4",
  });
}

/** The call whose stream died before it answered: worthline may well have written it. */
export function inFlightAlertPart(): Part {
  return toolPart("tool-raise_maintainer_alert", {
    state: "input-available",
    toolCallId: "call-5",
  });
}
