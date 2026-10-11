/**
 * What worthline found in the book for the two funds a traspaso paper names (#1793,
 * decided with Jose after the live run of #1801).
 *
 * The live run reproduced the incident on its first try: handed a validated traspaso
 * confirmation, the model searched the book by the paper's printed NAMES, found nothing
 * and told the user neither fund was there — both were, one inside a managed portfolio
 * and below the summary's cut. The identity check of #1800 could not help: it acts only
 * once the model reaches the lane. So the app matches each side by its identifier (ISIN
 * or DGS code) BEFORE the model has to, and says what it found next to the paper:
 *
 * - **one** holding → «en tu patrimonio: «Nombre» (id)»;
 * - **none** → «no está en tu patrimonio», with the route (for the destination, an alta
 *   without opening carrying that identifier, and then the traspaso);
 * - **several** → all of them by name and id, and the app does not pick.
 *
 * The ids printed here are worthline's own lookup, so they count as read (#1263): the
 * turn seeds them into its grounded ids exactly as it would a read's answer. A side whose
 * paper prints no identifier says nothing — worthline searched for nothing there.
 *
 * Pure and I/O-free: the lookup itself is {@link ./transfer-identity}'s, the one search
 * the lane's own refusals name candidates with, so the two can never disagree about
 * which holdings carry an identifier. This module only renders what it found.
 */

import type { ValidatedAttachment } from "./attachment-chat";
import {
  type ExtractedTransfer,
  extractedSecurityId,
} from "./attachment-extraction-contract";
import { securityIdLabel } from "./security-identity";
import type { CandidateHolding } from "./transfer-identity";

/**
 * The holdings that register each identifier a traspaso paper prints, keyed by
 * {@link securityIdKey}. An identifier nobody carries is present with no holdings: «no
 * está» is something worthline looked for, unlike an identifier it never searched.
 */
export type TransferBook = ReadonlyMap<string, readonly CandidateHolding[]>;

export const EMPTY_TRANSFER_BOOK: TransferBook = new Map();

/** `isin:IE00B4L5Y983`, `dgs:N5394` — one key per typed identifier. */
export function securityIdKey(id: { kind: string; value: string }): string {
  return `${id.kind}:${id.value}`;
}

type Side = "origin" | "destination";

/** Every identifier the traspaso papers in the window print, on either side. */
export function transferPaperIds(
  attachments: readonly ValidatedAttachment[],
): NonNullable<ReturnType<typeof extractedSecurityId>>[] {
  return attachments.flatMap(({ document }) =>
    document.documentType === "transfer"
      ? (["origin", "destination"] as const).flatMap((side) => {
          const id = extractedSecurityId(document.transfer[side]);
          return id === null ? [] : [id];
        })
      : [],
  );
}

/**
 * What the model reads next to the paper, per side: one sentence each, or nothing for a
 * side whose paper prints no identifier. `null` when neither side was looked up — no
 * identifier at all, or a caller that had no book to read (a fixture, an older turn).
 */
export function foundByWorthline(
  transfer: ExtractedTransfer,
  book: TransferBook,
): Partial<Record<Side, string>> | null {
  const lines = Object.fromEntries(
    (["origin", "destination"] as const).flatMap((side) => {
      const line = sideLine(side, transfer, book);
      return line === null ? [] : [[side, line]];
    }),
  ) as Partial<Record<Side, string>>;
  return Object.keys(lines).length === 0 ? null : lines;
}

/**
 * The holdings {@link foundByWorthline} names across these papers, once each: what the
 * turn counts as read (#1263), because worthline's own lookup put them in the prompt.
 */
export function transferBookHoldings(
  attachments: readonly ValidatedAttachment[],
  book: TransferBook,
): CandidateHolding[] {
  const byId = new Map<string, CandidateHolding>();
  for (const id of transferPaperIds(attachments)) {
    for (const holding of book.get(securityIdKey(id)) ?? [])
      byId.set(holding.id, holding);
  }
  return [...byId.values()];
}

/** How a line names a holding: «Nombre» (wl_hld_…). Read back by {@link holdingsNamedIn}. */
function named(holding: CandidateHolding): string {
  return `«${holding.label}» (${holding.id})`;
}

const NAMED_HOLDING = /«([^»]+)» \((wl_hld_[0-9a-f]{32})\)/gu;

/**
 * The holdings a line of {@link foundByWorthline} names, read back off its text — for a
 * reader that only has the line, such as the eval's graders reading a tool answer. One
 * format, written and read here, so the two cannot drift apart.
 */
export function holdingsNamedIn(text: string): CandidateHolding[] {
  return Array.from(text.matchAll(NAMED_HOLDING), (match) => ({
    id: match[2]!,
    label: match[1]!,
  }));
}

function sideLine(
  side: Side,
  transfer: ExtractedTransfer,
  book: TransferBook,
): string | null {
  const id = extractedSecurityId(transfer[side]);
  if (id === null) return null;
  const carriers = book.get(securityIdKey(id));
  if (carriers === undefined) return null;

  if (carriers.length === 1) return `en tu patrimonio: ${named(carriers[0]!)}`;
  if (carriers.length > 1) {
    return `varias posiciones: ${carriers.map(named).join(", ")}. Pregunta cuál es; no elijas tú.`;
  }
  // Nobody carries it. A holding registered with NO identifier could still be this fund
  // — the lane accepts it, as the operation does — so the line says how to find out
  // before it says how to create one: an alta of a fund the person already has is a
  // duplicate nobody wanted.
  const missing = `no está en tu patrimonio: ninguna posición lleva el ${securityIdLabel(id)}`;
  return side === "destination"
    ? `${missing}. Si lo tiene registrado sin él, pregúntale cuál es; si no, primero ` +
        "propose_holding sin apertura y con ese identificador; después, el traspaso."
    : `${missing}. Si lo tiene registrado sin él, pregúntale cuál es; si no, no hay de ` +
        "dónde sacar las participaciones.";
}
