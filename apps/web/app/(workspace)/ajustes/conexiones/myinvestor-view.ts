/**
 * The pure decisions of the MyInvestor row in «Conexiones» (#1879,
 * interaction-patterns §7): what the «Sin conectar» row offers, how the code's
 * deadline is written and who the remembered password's acceptance names.
 * Client-safe: the connect island reads the deadline.
 */
import {
  MYINVESTOR_PREMIUM_LINE,
  MYINVESTOR_READ_ONLY_LINE,
  MYINVESTOR_UNAVAILABLE_LINE,
} from "@web/ajustes/myinvestor-copy";

export type MyInvestorAvailability =
  | { readonly kind: "connect" }
  /** Premium, with the link to manage it. */
  | { readonly kind: "premium"; readonly text: string }
  | { readonly kind: "line"; readonly text: string };

/**
 * The fold only when connecting can work. The relay goes first: without it nobody
 * can connect from this server, so a premium nudge would promise what upgrading
 * does not give. Then write access, then the plan.
 */
export function myInvestorAvailability(input: {
  relayConfigured: boolean;
  readOnly: boolean;
  premium: boolean;
}): MyInvestorAvailability {
  if (!input.relayConfigured) return { kind: "line", text: MYINVESTOR_UNAVAILABLE_LINE };
  if (input.readOnly) return { kind: "line", text: MYINVESTOR_READ_ONLY_LINE };
  if (!input.premium) return { kind: "premium", text: MYINVESTOR_PREMIUM_LINE };
  return { kind: "connect" };
}

/** «12:05»: until what time the SMS code counts, in the reader's clock. */
export function myInvestorCodeDeadline(expiresAt: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(expiresAt));
}

/** Who accepted the risk of the remembered password, as the row says it. */
export function myInvestorPasswordAcceptedBy(
  acceptedBy: string | null,
  viewerEmail: string | null,
): string {
  return acceptedBy === null || acceptedBy === viewerEmail
    ? "La aceptaste tú."
    : `La aceptó ${acceptedBy}.`;
}
