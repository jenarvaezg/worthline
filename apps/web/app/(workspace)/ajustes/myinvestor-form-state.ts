/**
 * The state the MyInvestor connect fold renders (#1879). Client-safe: the island
 * holds it with `useActionState`, and the actions return it. A finished connection
 * is not a state — it redirects, so the page re-renders with the row in the book.
 *
 * It never carries the password: a rejection refills the username only.
 */
export type MyInvestorFormState =
  | {
      readonly step: "credentials";
      readonly error: string | null;
      /** The username to refill after a refusal. */
      readonly customerId?: string;
    }
  | {
      readonly step: "sms";
      readonly pendingId: string;
      /** ISO instant the code stops counting. */
      readonly expiresAt: string;
      /** Where MyInvestor sent the code, masked by it; null when it does not say. */
      readonly destination: string | null;
      readonly error: string | null;
    };

export const MYINVESTOR_IDLE: MyInvestorFormState = { error: null, step: "credentials" };
