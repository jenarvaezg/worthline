/**
 * Signing in to MyInvestor (ADR 0114), ported from the prototype of #1866 and
 * `myinvestor-cli/auth.py`:
 *
 * - `POST /login/api/v2/auth/token` with `{customerId, password}` and the
 *   `x-device-id` of a device that already passed the SMS gives tokens with no
 *   second factor. An unknown device gets a signature request instead.
 * - The SMS goes in two steps that can live in two requests of the web app:
 *   `startCode` sends it, `submitCode` validates the code, and the login is then
 *   repeated with `x-signature-id`.
 * - `POST /login/api/v1/auth/token/refresh` with `{refreshToken}` renews the pair
 *   (MyInvestor answers 201). The access lasts 15 minutes and the refresh 30.
 */
import { z } from "zod";

import {
  fail,
  type MyInvestorResult,
  PASSWORD_ERR_CODES,
  safeCode,
  succeed,
} from "./errors";
import {
  type Answer,
  answerError,
  type ExchangeContext,
  envelopeData,
  errorCode,
  exchange,
} from "./exchange";
import { DEVICE_ID_HEADER, MYINVESTOR_PATHS, SIGNATURE_ID_HEADER } from "./protocol";

/** The second factors that are a code the user types, in the order they are tried. */
const CODE_METHODS = ["OTP_SMS", "OTP_EMAIL", "OTP_PUSH"] as const;

export interface MyInvestorCredentials {
  /** The DNI/NIE the user signs in with. */
  readonly customerId: string;
  readonly password: string;
}

export interface MyInvestorTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

/** A pending second factor: what `startCode` needs. */
export interface SignatureChallenge {
  readonly requestId: string;
  readonly methods: readonly string[];
}

export type LoginOutcome =
  | { readonly kind: "tokens"; readonly tokens: MyInvestorTokens }
  | { readonly kind: "signature"; readonly challenge: SignatureChallenge };

export interface CodeSent {
  /** Validates the code, with the challenge's `requestId`. */
  readonly signatureId: string;
  readonly method: string;
  /** Where it went, masked by MyInvestor (`+34 6** *** *00`). */
  readonly destination: string | null;
}

const tokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  isPasswordChangeRequired: z.boolean().nullish(),
});

const signatureSchema = z.object({
  signatureRequestId: z.string().min(1),
  status: z.string(),
  pendingSignatureMethods: z.array(z.union([z.string(), z.array(z.string())])).nullish(),
});

/** `payload.data` may be the object or a one-element list of it. */
function single(data: unknown): unknown {
  return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

function pendingSignature(data: unknown): SignatureChallenge | null {
  const parsed = signatureSchema.safeParse(single(data));
  if (!parsed.success || parsed.data.status !== "PENDING") return null;
  return {
    requestId: parsed.data.signatureRequestId,
    methods: (parsed.data.pendingSignatureMethods ?? []).flat(),
  };
}

function isSuccess(status: number): boolean {
  return Math.floor(status / 100) === 2;
}

/**
 * The statuses with which MyInvestor turns down a login or a refresh (400, 401, 403),
 * as opposed to an answer nobody expected.
 */
function isRejection(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

/** What a login answer means, by the error map of ADR 0114 (decision 7). */
function loginOutcome(answer: Answer): MyInvestorResult<LoginOutcome> {
  if (isSuccess(answer.status)) {
    const data = envelopeData(answer.body);
    const challenge = pendingSignature(data);
    if (challenge) return succeed({ kind: "signature", challenge });
    const tokens = tokensSchema.safeParse(data);
    if (!tokens.success)
      return fail(answerError("unexpected_response", "login", answer, null));
    if (tokens.data.isPasswordChangeRequired) {
      return fail(
        answerError("password_rejected", "login", answer, "UPDATE_PASSWORD_REQUIRED"),
      );
    }
    return succeed({
      kind: "tokens",
      tokens: {
        accessToken: tokens.data.accessToken,
        refreshToken: tokens.data.refreshToken,
      },
    });
  }
  if (isRejection(answer.status)) {
    const code = errorCode(answer.body);
    // A missing errCode is no proof of a wrong password: only the explicit ones delete it.
    return fail(
      answerError(
        code !== null && PASSWORD_ERR_CODES.has(code)
          ? "password_rejected"
          : "rejected_no_reason",
        "login",
        answer,
        code,
      ),
    );
  }
  return fail(answerError("unexpected_response", "login", answer));
}

function signedHeaders(deviceId: string, requestId?: string): Record<string, string> {
  return requestId === undefined
    ? { [DEVICE_ID_HEADER]: deviceId }
    : { [DEVICE_ID_HEADER]: deviceId, [SIGNATURE_ID_HEADER]: requestId };
}

async function loginExchange(
  context: ExchangeContext,
  deviceId: string,
  credentials: MyInvestorCredentials,
  signatureRequestId: string | undefined,
): Promise<MyInvestorResult<{ outcome: LoginOutcome; answer: Answer }>> {
  const result = await exchange(
    context,
    {
      method: "POST",
      path: MYINVESTOR_PATHS.login,
      headers: signedHeaders(deviceId, signatureRequestId),
      body: { customerId: credentials.customerId, password: credentials.password },
    },
    "login",
  );
  if (!result.ok) return result;
  const outcome = loginOutcome(result.value);
  return outcome.ok ? succeed({ outcome: outcome.value, answer: result.value }) : outcome;
}

/** The login, tokens or a signature request (connecting a new device). */
export async function login(
  context: ExchangeContext,
  deviceId: string,
  credentials: MyInvestorCredentials,
  signatureRequestId?: string,
): Promise<MyInvestorResult<LoginOutcome>> {
  const result = await loginExchange(context, deviceId, credentials, signatureRequestId);
  return result.ok ? succeed(result.value.outcome) : result;
}

/**
 * The login of a device that must already be trusted: the daily sync, or the login
 * repeated after the SMS. A signature request here is `sms_required`.
 */
export async function loginWithKnownDevice(
  context: ExchangeContext,
  deviceId: string,
  credentials: MyInvestorCredentials,
  signatureRequestId?: string,
): Promise<MyInvestorResult<MyInvestorTokens>> {
  const result = await loginExchange(context, deviceId, credentials, signatureRequestId);
  if (!result.ok) return result;
  const { outcome, answer } = result.value;
  return outcome.kind === "tokens"
    ? succeed(outcome.tokens)
    : fail(answerError("sms_required", "login", answer, null));
}

/** A new access/refresh pair. Any 2xx is good: MyInvestor answers 201. */
export async function refresh(
  context: ExchangeContext,
  deviceId: string,
  refreshToken: string,
): Promise<MyInvestorResult<MyInvestorTokens>> {
  const result = await exchange(
    context,
    {
      method: "POST",
      path: MYINVESTOR_PATHS.refresh,
      headers: { [DEVICE_ID_HEADER]: deviceId },
      body: { refreshToken },
    },
    "refresh",
  );
  if (!result.ok) return result;
  const answer = result.value;
  if (!isSuccess(answer.status)) {
    return fail(
      answerError(
        isRejection(answer.status) ? "session_expired" : "unexpected_response",
        "refresh",
        answer,
      ),
    );
  }
  const tokens = tokensSchema.safeParse(envelopeData(answer.body));
  if (!tokens.success)
    return fail(answerError("unexpected_response", "refresh", answer, null));
  return succeed({
    accessToken: tokens.data.accessToken,
    refreshToken: tokens.data.refreshToken,
  });
}

const codeSentSchema = z.object({
  signatureId: z.string().min(1),
  destination: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
});

/** Sends the code of the first code method pending. Never retried: it would send a second SMS. */
export async function startCode(
  context: ExchangeContext,
  deviceId: string,
  challenge: SignatureChallenge,
): Promise<MyInvestorResult<CodeSent>> {
  const method = CODE_METHODS.find((candidate) => challenge.methods.includes(candidate));
  if (!method) {
    return fail({
      kind: "unexpected_response",
      step: "sms",
      httpStatus: null,
      code: "no_code_method",
      attempts: 0,
    });
  }
  const result = await exchange(
    context,
    {
      method: "POST",
      path: MYINVESTOR_PATHS.signatureCode(challenge.requestId),
      query: { method },
      headers: { [DEVICE_ID_HEADER]: deviceId },
    },
    "sms",
    { retry: false },
  );
  if (!result.ok) return result;
  const answer = result.value;
  const sent = isSuccess(answer.status)
    ? codeSentSchema.safeParse(envelopeData(answer.body))
    : null;
  if (!sent?.success) return fail(answerError("unexpected_response", "sms", answer));
  return succeed({
    signatureId: sent.data.signatureId,
    method,
    destination: sent.data.destination,
  });
}

export interface CodeSubmission {
  readonly requestId: string;
  readonly signatureId: string;
  readonly code: string;
}

/** Validates the code. After it, `login` again with the `requestId` as signature. */
export async function submitCode(
  context: ExchangeContext,
  deviceId: string,
  submission: CodeSubmission,
): Promise<MyInvestorResult<null>> {
  const result = await exchange(
    context,
    {
      method: "POST",
      path: MYINVESTOR_PATHS.signatureValidation(
        submission.requestId,
        submission.signatureId,
      ),
      headers: { [DEVICE_ID_HEADER]: deviceId },
      body: { code: submission.code.trim() },
    },
    "sms",
    { retry: false },
  );
  if (!result.ok) return result;
  const answer = result.value;
  if (answer.status === 400 || answer.status === 422) {
    return fail(answerError("code_rejected", "sms", answer));
  }
  if (!isSuccess(answer.status))
    return fail(answerError("unexpected_response", "sms", answer));
  const status = signatureSchema.safeParse(single(envelopeData(answer.body)));
  if (!status.success)
    return fail(answerError("unexpected_response", "sms", answer, null));
  // Anything but COMPLETE (another factor pending, expired) does not let the login through.
  return status.data.status === "COMPLETE"
    ? succeed(null)
    : fail(answerError("code_rejected", "sms", answer, safeCode(status.data.status)));
}
