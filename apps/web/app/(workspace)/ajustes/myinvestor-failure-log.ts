/**
 * A MyInvestor call that failed, written to the server log (#1876). The user reads
 * one friendly sentence; without this line nobody can tell which call failed, nor
 * how — a 5xx retried four times and a schema MyInvestor changed both end in «No
 * hemos podido leer tus productos».
 *
 * Only the typed error goes out: its kind, the step, the HTTP status, MyInvestor's
 * code (already reduced to a safe token by the client) and the attempts. Never the
 * customer, the device, a path with an account id, nor a body.
 */
import type { MyInvestorError } from "@worthline/pricing";

export type MyInvestorServerLog = (
  message: string,
  detail: Record<string, unknown>,
) => void;

export function logMyInvestorFailure(
  where: string,
  error: MyInvestorError,
  log: MyInvestorServerLog = console.error,
): void {
  log(`[myinvestor] ${where} failed`, {
    attempts: error.attempts,
    code: error.code,
    httpStatus: error.httpStatus,
    kind: error.kind,
    step: error.step,
  });
}
