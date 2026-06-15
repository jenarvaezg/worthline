/**
 * Pure helpers for the Numista connected-source flow (PRD #160 / #163). They
 * resolve the connecting member (who owns the projected holding 100 %), shape the
 * stored credentials, and format the "last sync" line. Kept free of Next.js, the
 * store, and the network so the connect/sync actions stay thin glue and these
 * decisions are unit-testable.
 *
 * The API key is a SECRET (ADR 0016): it is serialized into credentialsJson for
 * the local DB only — never logged and never placed in a redirect URL.
 */

import type { Member, OwnershipShare } from "@worthline/domain";
import type { NumistaToken } from "@worthline/pricing";

/**
 * Resolve the ownership split for a newly connected source: 100 % the connecting
 * member. That member is the cookie-scope member when it maps to an active
 * workspace member, otherwise the first active member. Returns null when there is
 * no active member to own the holding (a connect cannot proceed then).
 */
export function resolveConnectingOwnership(
  members: Member[],
  scopeMemberId: string | undefined,
): OwnershipShare[] | null {
  const active = members.filter((member) => !member.disabledAt);

  if (active.length === 0) {
    return null;
  }

  const scoped =
    scopeMemberId !== undefined
      ? active.find((member) => member.id === scopeMemberId)
      : undefined;
  const owner = scoped ?? active[0]!;

  return [{ memberId: owner.id, shareBps: 10_000 }];
}

/** Normalize the pasted API key, returning null when it is blank. */
export function normalizeApiKey(raw: FormDataEntryValue | null): string | null {
  const trimmed = String(raw ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** Serialize the Numista credentials for local storage (never logged/exported). */
export function buildCredentialsJson(apiKey: string): string {
  return JSON.stringify({ apiKey });
}

/** Read the stored API key back out of a source's credentialsJson, or null. */
export function readApiKey(credentialsJson: string): string | null {
  try {
    const parsed = JSON.parse(credentialsJson) as { apiKey?: unknown };
    return typeof parsed.apiKey === "string" && parsed.apiKey.trim() !== ""
      ? parsed.apiKey
      : null;
  } catch {
    return null;
  }
}

/** Parse a stored token JSON back into a NumistaToken, or null when absent/bad. */
export function parseNumistaToken(tokenJson: string | null): NumistaToken | null {
  if (!tokenJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(tokenJson) as Partial<NumistaToken>;

    if (
      typeof parsed.accessToken === "string" &&
      typeof parsed.expiresAtMs === "number" &&
      typeof parsed.userId === "number"
    ) {
      return {
        accessToken: parsed.accessToken,
        expiresAtMs: parsed.expiresAtMs,
        userId: parsed.userId,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/** Format an ISO last-sync stamp for the connected-source tile, or a dash. */
export function formatLastSync(lastSyncAt: string | null): string {
  if (!lastSyncAt) {
    return "Nunca";
  }

  const date = new Date(lastSyncAt);
  if (Number.isNaN(date.getTime())) {
    return "Nunca";
  }

  return date.toLocaleString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
