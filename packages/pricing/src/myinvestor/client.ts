/**
 * The MyInvestor client (#1877, ADR 0114): one object per connection and sync,
 * bound to the connection's `device_id` and to a transport, which in production is
 * the Cloudflare relay (`createRelayTransport`). It never touches the database nor
 * reads env; every failure comes back as a typed {@link MyInvestorError} value.
 */

import type { MyInvestorResult } from "./errors";
import { DEFAULT_RETRY_DELAYS_MS, type ExchangeContext } from "./exchange";
import { createMyInvestorReader, type MyInvestorReader } from "./reader";
import {
  type CodeSent,
  type CodeSubmission,
  type LoginOutcome,
  login,
  loginWithKnownDevice,
  type MyInvestorCredentials,
  type MyInvestorTokens,
  refresh,
  type SignatureChallenge,
  startCode,
  submitCode,
} from "./session";
import type { MyInvestorTransport } from "./transport";

export interface MyInvestorClientOptions {
  readonly transport: MyInvestorTransport;
  /** The device MyInvestor trusts after the SMS; stored with the connection. */
  readonly deviceId: string;
  /** Waits between retries; injected so tests never wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** One wait per retry of a network or WAF failure; default 2 s, 4 s, 8 s. */
  readonly retryDelaysMs?: readonly number[];
}

export interface MyInvestorClient {
  /** Connecting: tokens, or the signature request of a device MyInvestor does not know. */
  login(credentials: MyInvestorCredentials): Promise<MyInvestorResult<LoginOutcome>>;
  /** The daily sync: a known device gets tokens; a signature request is `sms_required`. */
  loginWithKnownDevice(
    credentials: MyInvestorCredentials,
  ): Promise<MyInvestorResult<MyInvestorTokens>>;
  /** The login repeated with `x-signature-id` once `submitCode` succeeded. */
  signedLogin(
    credentials: MyInvestorCredentials,
    signatureRequestId: string,
  ): Promise<MyInvestorResult<MyInvestorTokens>>;
  refresh(refreshToken: string): Promise<MyInvestorResult<MyInvestorTokens>>;
  /** First step of the SMS: sends it. Never retried. */
  startCode(challenge: SignatureChallenge): Promise<MyInvestorResult<CodeSent>>;
  /** Second step of the SMS: validates the code. */
  submitCode(submission: CodeSubmission): Promise<MyInvestorResult<null>>;
  /** The reads, with this session. */
  reader(tokens: MyInvestorTokens): MyInvestorReader;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMyInvestorClient(
  options: MyInvestorClientOptions,
): MyInvestorClient {
  const context: ExchangeContext = {
    transport: options.transport,
    sleep: options.sleep ?? wait,
    retryDelaysMs: options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
  };
  const { deviceId } = options;

  return {
    login: (credentials) => login(context, deviceId, credentials),
    loginWithKnownDevice: (credentials) =>
      loginWithKnownDevice(context, deviceId, credentials),
    signedLogin: (credentials, signatureRequestId) =>
      loginWithKnownDevice(context, deviceId, credentials, signatureRequestId),
    refresh: (refreshToken) => refresh(context, deviceId, refreshToken),
    startCode: (challenge) => startCode(context, deviceId, challenge),
    submitCode: (submission) => submitCode(context, deviceId, submission),
    reader: (tokens) => createMyInvestorReader(context, deviceId, tokens),
  };
}
