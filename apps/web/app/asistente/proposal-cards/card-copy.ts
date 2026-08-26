/**
 * The wording and money formatting several cards share.
 *
 * Pure and free of JSX on purpose: these are the sentences a card prints, so they are
 * readable in a test without rendering a card (ADR 0088).
 */

import { formatMoneyMinor } from "@worthline/domain";

export function formatPositionMoney(amountMinor: number): string {
  return formatMoneyMinor({ amountMinor, currency: "EUR" });
}

/**
 * What a card says about a fund the confirm will leave OUT because its identifier
 * names more than one holding (#1366). The chat has nowhere to ask "which of the
 * two is it", and confirming would let the file overwrite the wrong broker's
 * history — so the fund is left out, the card points at the surface where the
 * choice exists, and it prints NONE of the fund's figures: they all belong to the
 * first candidate, the very default this fix exists to stop passing off as the
 * answer.
 */
export function ambiguousFundNote(isin: string, claimants: number): string {
  return `${isin} está en ${claimants} de tus inversiones: se queda fuera — elige cuál en Importar extracto.`;
}

export function proposalResultMessage(
  result: { status: string; message?: string; included?: number; created?: number },
  appliedMessage: string,
): string {
  if (result.status === "applied") return appliedMessage;
  return result.message ?? "No se pudo aplicar la propuesta.";
}
