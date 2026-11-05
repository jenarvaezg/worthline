/**
 * The error map of the MyInvestor connector (ADR 0114, decision 7). Every failure
 * of the client comes back as a {@link MyInvestorError} value, never as a thrown
 * error nor as raw text: the sync slice (#1884) turns each kind into its action and
 * the attempt log (#1885) records it as it is, so it carries no amount, ISIN, id or
 * body. `code` is at most MyInvestor's own error code (`UNAUTHORIZED`,
 * `SECURITY_001`) or a word of ours.
 */

export type MyInvestorErrorKind =
  /** Wrong password, or MyInvestor demands a new one. The stored password goes; never retried. */
  | "password_rejected"
  /** A login refused with no stated reason, `403 SECURITY_001 «Captcha required»` included. A 24-hour pause. */
  | "rejected_no_reason"
  /** Network, timeout, 5xx or the Imperva WAF, after the retries of the same call. */
  | "network_or_waf"
  /** The `device_id` is no longer trusted (or a read wants a signature): the phone must verify again. */
  | "sms_required"
  /** The SMS code was wrong or expired. */
  | "code_rejected"
  /** The access token expired and could not be renewed: a new login is needed. */
  | "session_expired"
  /** The relay refused the request (secret, target): a deploy misconfiguration. */
  | "relay_rejected"
  /** MyInvestor answered something the client does not understand. */
  | "unexpected_response";

/** The data each call touches, as the attempt log names the failing step (decision 8). */
export type MyInvestorStep =
  | "login"
  | "refresh"
  | "sms"
  | "cash"
  | "positions"
  | "orders"
  | "plans"
  | "contributions";

export interface MyInvestorError {
  readonly kind: MyInvestorErrorKind;
  readonly step: MyInvestorStep;
  /** The last HTTP status seen; `null` when nothing answered. */
  readonly httpStatus: number | null;
  /** MyInvestor's error code or a word of ours; never free text. */
  readonly code: string | null;
  /** Requests sent for this call, retries included. */
  readonly attempts: number;
  /** The reader's call that failed, by its method name; never a path, which carries ids. */
  readonly call?: string;
  /** MyInvestor's type of the account the call was about, when it was about one. */
  readonly accountType?: string | null;
}

export type MyInvestorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MyInvestorError };

export function succeed<T>(value: T): MyInvestorResult<T> {
  return { ok: true, value };
}

export function fail<T>(error: MyInvestorError): MyInvestorResult<T> {
  return { ok: false, error };
}

/** Error codes MyInvestor sends are upper snake case; anything else is not kept. */
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

export function safeCode(value: unknown): string | null {
  return typeof value === "string" && CODE.test(value) ? value : null;
}

/** `errCode` that means the password itself is wrong or must change (myinvestor-cli `auth.py`). */
export const PASSWORD_ERR_CODES: ReadonlySet<string> = new Set([
  "UNAUTHORIZED",
  "UPDATE_PASSWORD_REQUIRED",
]);
