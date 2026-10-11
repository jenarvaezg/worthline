/**
 * The second source of `propose_transfer` (#1799): the traspaso confirmation worthline
 * itself read and validated (#1795). The sibling of `operation-document-frontier.ts`,
 * built the same way and for the same reason: whoever holds the bank's notice hands it
 * over and asks for the traspaso, so the figures are already in a document worthline
 * read — and re-reading them off the model's prose, or asking the person to type them
 * again, is the wall #1793 hit.
 *
 * What the paper decides, and only the paper: the fecha de operación, the gross importe
 * and the participaciones of the half it CONFIRMS (`confirms`). The model still decides
 * the two holdings, and nothing else.
 *
 * - **A reembolso** confirms the half that LEFT: its participaciones are the origin's,
 *   stated, so the origin's VL is derived from the two figures the bank printed (#1544)
 *   and no app price enters that leg.
 * - **A suscripción** confirms the half that ARRIVED: its participaciones are the
 *   destination's, declared as such, and the origin is divided at its own price — which
 *   the card already says where it came from.
 * - **A commission** is not written half from the chat: the importe that left and the
 *   one that arrived differ, and only «Traspasar» has a field for each — the same route
 *   the pasted block takes (#1794).
 *
 * Pure and I/O-free: attachments in, the traspaso the lane builds from — or the refusal
 * that routes the person — out.
 */

import { multiplyToMinor, normalizeDecimal } from "@worthline/domain";
import type { ValidatedAttachment } from "./attachment-chat";
import {
  type ExtractedTransfer,
  extractedSecurityId,
} from "./attachment-extraction-contract";
import { formatDocumentMoney } from "./document-figures";
import { type ProposalRefusal, userRefusal } from "./proposal-refusal";
import type { PrintedFund } from "./transfer-identity";
import type { TypedTransfer } from "./typed-transfer";

/** The last traspaso confirmation the model was handed, with the file it came in. */
export interface TransferDocument {
  fileName: string;
  transfer: ExtractedTransfer;
}

/**
 * The last validated `transfer` document in the turn's context — the same window the
 * model was shown, and the same «last one wins» as the operation's justificante.
 */
export function transferDocumentInContext(
  attachments: readonly ValidatedAttachment[],
): TransferDocument | null {
  for (let index = attachments.length - 1; index >= 0; index -= 1) {
    const { document, fileName } = attachments[index]!;
    if (document.documentType === "transfer") {
      return { fileName, transfer: document.transfer };
    }
  }
  return null;
}

export type TransferDocumentReading =
  | {
      ok: true;
      transfer: TypedTransfer;
      /** The currency the paper prints its importe in: the lane refuses another one. */
      currency: string;
      /**
       * The two funds as the paper names them, each with the identifier it prints: what
       * the lane checks the model's two holdings against (#1800).
       */
      funds: { origin: PrintedFund; destination: PrintedFund };
    }
  | { ok: false; refusal: ProposalRefusal };

/** The traspaso a validated confirmation states, in the shape the lane builds from. */
export function transferFromDocument(
  document: TransferDocument,
): TransferDocumentReading {
  const { transfer } = document;
  // Zero is not a commission: the bank prints «0,00 €» on every traspaso, charged or not.
  if (transfer.fees !== undefined && transfer.fees.amount !== 0) {
    return {
      ok: false,
      refusal: userRefusal(
        "transfer_fee_in_document",
        `El justificante «${document.fileName}» trae una comisión de ` +
          `${formatDocumentMoney(minorOf(transfer.fees.amount), transfer.fees.currency)}, y un ` +
          "traspaso con comisión no lo anoto a medias desde el chat: regístralo desde " +
          "«Traspasar» en la ficha de la posición de origen, que tiene un campo para cada cifra.",
      ),
    };
  }

  const amountMinor = minorOf(transfer.amount);
  const executedAt = transfer.date;
  const units =
    transfer.units === undefined ? undefined : normalizeDecimal(String(transfer.units));
  const read = (typed: TypedTransfer): TransferDocumentReading => ({
    currency: transfer.currency,
    funds: {
      destination: printedFund(transfer.destination),
      origin: printedFund(transfer.origin),
    },
    ok: true,
    transfer: typed,
  });

  if (units === undefined) {
    return read({ executedAt, portion: { amountMinor, kind: "amount" } });
  }
  if (transfer.confirms === "subscription") {
    return read({
      destinationUnits: units,
      executedAt,
      portion: { amountMinor, kind: "amount" },
    });
  }
  return read({ executedAt, portion: { amountMinor, kind: "units", units } });
}

/** One side as the paper prints it: the name, and the identifier when it has one. */
function printedFund(fund: ExtractedTransfer["origin"]): PrintedFund {
  const securityId = extractedSecurityId(fund);
  return { name: fund.name, ...(securityId === null ? {} : { securityId }) };
}

/** A major-unit figure the paper printed, as exact integer cents. */
function minorOf(amount: number): number {
  return Math.abs(multiplyToMinor(String(amount), "1"));
}
