/**
 * Connecting MyInvestor from «Conexiones» (#1879, ADR 0114 decisions 1, 3 and 6;
 * ADR 0115 decision 1), as functions over ports: the store, a client bound to a
 * device, the clock. The server actions only wire them and choose the terminal.
 *
 * The login has up to two steps:
 *   1. username and password. A device MyInvestor already trusts gets tokens and
 *      the connection is made; an unknown one gets a signature request, the SMS is
 *      sent, and the half-done login is kept as a PENDING STEP in the database —
 *      sealed, five minutes, tied to the workspace's MyInvestor connection — never
 *      in a cookie.
 *   2. the code. With it MyInvestor trusts the device, and the connection keeps its
 *      `deviceId`.
 *
 * What the connection keeps is the opt-in of decision 1: only the device without
 * the box; with it, also the username, the password and who accepted when. The
 * pending step holds the credentials only when the box was ticked: without it
 * there is nothing to keep, so nothing is kept.
 *
 * This slice only makes the connection. When it ends with a session in hand, the
 * first start's read (#1880) runs through {@link MyInvestorFlowDeps.afterConnect}.
 */
import type { WorthlineStore } from "@web/store";
import type {
  MyInvestorClient,
  MyInvestorErrorKind,
  MyInvestorReader,
  MyInvestorTokens,
} from "@worthline/pricing";
import {
  MYINVESTOR_ALREADY_CONNECTED,
  MYINVESTOR_CODE_REJECTED,
  MYINVESTOR_DEVICE_LAPSED,
  MYINVESTOR_LOGIN_ERRORS,
  MYINVESTOR_MAX_CODE_ATTEMPTS,
  MYINVESTOR_NOT_FOUND,
  MYINVESTOR_PENDING_EXPIRED,
  MYINVESTOR_PENDING_TTL_MINUTES,
  MYINVESTOR_SAVE_REJECTED,
  MYINVESTOR_TOO_MANY_CODES,
} from "./myinvestor-copy";
import {
  hasSavedPassword,
  type MyInvestorLoginInput,
  type MyInvestorPendingSave,
  type MyInvestorStoredCredentials,
  readMyInvestorCredentials,
  readMyInvestorPending,
  serializeMyInvestorCredentials,
  serializeMyInvestorPending,
} from "./myinvestor-credentials";

export const MYINVESTOR_ADAPTER = "myinvestor";
export const MYINVESTOR_LABEL = "MyInvestor";

/** What connecting needs of the client, and the reads of the first start (#1880). */
export type MyInvestorConnectClient = Pick<
  MyInvestorClient,
  "login" | "loginWithKnownDevice" | "signedLogin" | "startCode" | "submitCode" | "reader"
>;

export type MyInvestorFlowStore = Pick<
  WorthlineStore["connectedSources"],
  | "connectOwningSource"
  | "deletePendingLogin"
  | "listSources"
  | "readPendingLogin"
  | "readSource"
  | "startPendingLogin"
  | "reservePendingCodeAttempt"
  | "updateCredentials"
>;

export interface MyInvestorFlowDeps {
  readonly store: MyInvestorFlowStore;
  /** A client bound to `deviceId`, through the relay in production. */
  readonly clientFor: (deviceId: string) => MyInvestorConnectClient;
  /** A fresh device id for a new connection. */
  readonly newDeviceId: () => string;
  /** The request's instant, ISO. */
  readonly now: string;
  /** Who would accept the risk statement: the session's email, null when local. */
  readonly acceptedBy: string | null;
  /**
   * The first start's read (#1880), when the connection ends with a session in hand:
   * a known device, or the code with the password remembered. Its failure never
   * undoes the connection; the fold then offers to read again.
   */
  readonly afterConnect?: (input: {
    sourceId: string;
    reader: MyInvestorReader;
  }) => Promise<unknown>;
}

/** Where the form is after a step. `connected` ends it; the action redirects. */
export type MyInvestorStep =
  | { readonly step: "credentials"; readonly error: string | null }
  | {
      readonly step: "sms";
      readonly pendingId: string;
      /** When the code stops counting, ISO: the form shows the time, not a countdown. */
      readonly expiresAt: string;
      /** Where MyInvestor sent it, masked by MyInvestor; null when it does not say. */
      readonly destination: string | null;
      readonly error: string | null;
    }
  | { readonly step: "connected"; readonly savedPassword: boolean };

export type MyInvestorResultMessage = { ok: true } | { ok: false; error: string };

/** The message of a refused login: every one of them says nothing was saved. */
function loginErrorMessage(kind: MyInvestorErrorKind): string {
  switch (kind) {
    case "password_rejected":
      return MYINVESTOR_LOGIN_ERRORS.password_rejected;
    case "rejected_no_reason":
      return MYINVESTOR_LOGIN_ERRORS.rejected_no_reason;
    case "network_or_waf":
      return MYINVESTOR_LOGIN_ERRORS.network_or_waf;
    default:
      return MYINVESTOR_LOGIN_ERRORS.unexpected;
  }
}

function credentialsStep(error: string): MyInvestorStep {
  return { error, step: "credentials" };
}

async function existingConnection(store: MyInvestorFlowStore) {
  return (await store.listSources()).find(
    (source) => source.adapter === MYINVESTOR_ADAPTER,
  );
}

function pendingExpiry(now: string): string {
  return new Date(
    Date.parse(now) + MYINVESTOR_PENDING_TTL_MINUTES * 60_000,
  ).toISOString();
}

async function connect(
  deps: MyInvestorFlowDeps,
  credentials: MyInvestorStoredCredentials,
  session: { client: MyInvestorConnectClient; tokens: MyInvestorTokens } | null,
): Promise<MyInvestorStep> {
  const connected = await deps.store.connectOwningSource({
    adapter: MYINVESTOR_ADAPTER,
    credentialsJson: serializeMyInvestorCredentials(credentials),
    label: MYINVESTOR_LABEL,
  });
  // Another login of this workspace finished first: this one keeps nothing.
  if (!connected) return credentialsStep(MYINVESTOR_ALREADY_CONNECTED);
  if (session && deps.afterConnect) {
    await deps.afterConnect({
      reader: session.client.reader(session.tokens),
      sourceId: connected.sourceId,
    });
  }
  return { savedPassword: hasSavedPassword(credentials), step: "connected" };
}

function credentialsToKeep(
  deviceId: string,
  save: MyInvestorPendingSave | null,
  now: string,
): MyInvestorStoredCredentials {
  return save
    ? {
        acceptance: { acceptedAt: now, acceptedBy: save.acceptedBy },
        customerId: save.customerId,
        deviceId,
        password: save.password,
      }
    : { deviceId };
}

/** Step 1: username and password, and the box. */
export async function startMyInvestorConnect(
  deps: MyInvestorFlowDeps,
  input: MyInvestorLoginInput,
): Promise<MyInvestorStep> {
  // Refused before MyInvestor is asked: a second login is a login for nothing.
  if (await existingConnection(deps.store)) {
    return credentialsStep(MYINVESTOR_ALREADY_CONNECTED);
  }

  const deviceId = deps.newDeviceId();
  const client = deps.clientFor(deviceId);
  const credentials = { customerId: input.customerId, password: input.password };
  const save: MyInvestorPendingSave | null = input.save
    ? { ...credentials, acceptedBy: deps.acceptedBy }
    : null;

  const login = await client.login(credentials);
  if (!login.ok) return credentialsStep(loginErrorMessage(login.error.kind));

  if (login.value.kind === "tokens") {
    return connect(deps, credentialsToKeep(deviceId, save, deps.now), {
      client,
      tokens: login.value.tokens,
    });
  }

  const sent = await client.startCode(login.value.challenge);
  if (!sent.ok) return credentialsStep(loginErrorMessage(sent.error.kind));

  const expiresAt = pendingExpiry(deps.now);
  const { id } = await deps.store.startPendingLogin({
    adapter: MYINVESTOR_ADAPTER,
    expiresAt,
    payloadJson: serializeMyInvestorPending({
      deviceId,
      requestId: login.value.challenge.requestId,
      save,
      signatureId: sent.value.signatureId,
    }),
  });
  return {
    destination: sent.value.destination,
    error: null,
    expiresAt,
    pendingId: id,
    step: "sms",
  };
}

/** Step 2: the code. A wrong one may be retried with the same step until it expires. */
export async function submitMyInvestorCode(
  deps: MyInvestorFlowDeps,
  input: { pendingId: string; code: string },
): Promise<MyInvestorStep> {
  const row = await deps.store.readPendingLogin(input.pendingId);
  const pending = row ? readMyInvestorPending(row.payloadJson) : null;
  if (!row || !pending || Date.parse(deps.now) > Date.parse(row.expiresAt)) {
    if (row) await deps.store.deletePendingLogin(row.id);
    return credentialsStep(MYINVESTOR_PENDING_EXPIRED);
  }

  const smsStep = (error: string): MyInvestorStep => ({
    destination: null,
    error,
    expiresAt: row.expiresAt,
    pendingId: row.id,
    step: "sms",
  });

  if (await existingConnection(deps.store)) {
    await deps.store.deletePendingLogin(row.id);
    return credentialsStep(MYINVESTOR_ALREADY_CONNECTED);
  }

  // A wrong code may be retried with the same step, but not forever, and the cap
  // is ours: guessing never rests only on MyInvestor's limits. The attempt is
  // reserved BEFORE MyInvestor is asked, in one update, so codes sent at once
  // cannot all count as the first.
  const attempt = await deps.store.reservePendingCodeAttempt(
    row.id,
    MYINVESTOR_MAX_CODE_ATTEMPTS,
  );
  if (attempt === null) {
    await deps.store.deletePendingLogin(row.id);
    return credentialsStep(MYINVESTOR_TOO_MANY_CODES);
  }

  const client = deps.clientFor(pending.deviceId);
  const validated = await client.submitCode({
    code: input.code,
    requestId: pending.requestId,
    signatureId: pending.signatureId,
  });
  if (!validated.ok) {
    if (validated.error.kind !== "code_rejected") {
      return smsStep(loginErrorMessage(validated.error.kind));
    }
    if (attempt >= MYINVESTOR_MAX_CODE_ATTEMPTS) {
      await deps.store.deletePendingLogin(row.id);
      return credentialsStep(MYINVESTOR_TOO_MANY_CODES);
    }
    return smsStep(MYINVESTOR_CODE_REJECTED);
  }

  // With the credentials in hand (the opt-in), the login is finished with the
  // signature, which proves both the device and the password before they are kept.
  let session: { client: MyInvestorConnectClient; tokens: MyInvestorTokens } | null =
    null;
  if (pending.save) {
    const signed = await client.signedLogin(
      { customerId: pending.save.customerId, password: pending.save.password },
      pending.requestId,
    );
    if (!signed.ok) {
      await deps.store.deletePendingLogin(row.id);
      return credentialsStep(loginErrorMessage(signed.error.kind));
    }
    session = { client, tokens: signed.value };
  }

  await deps.store.deletePendingLogin(row.id);
  return connect(
    deps,
    credentialsToKeep(pending.deviceId, pending.save, deps.now),
    session,
  );
}

async function readConnection(store: MyInvestorFlowStore, sourceId: string) {
  const source = await store.readSource(sourceId);
  if (!source || source.adapter !== MYINVESTOR_ADAPTER) return null;
  const credentials = readMyInvestorCredentials(source.credentialsJson);
  return credentials ? { credentials, source } : null;
}

/**
 * Remember the password on a connected row (decision 1). It is checked with
 * MyInvestor on the device it already trusts, so no SMS is sent; only an accepted
 * password is written, with who accepted the risk and when.
 */
export async function saveMyInvestorPassword(
  deps: MyInvestorFlowDeps,
  input: { sourceId: string; customerId: string; password: string },
): Promise<MyInvestorResultMessage> {
  const connection = await readConnection(deps.store, input.sourceId);
  if (!connection) return { error: MYINVESTOR_NOT_FOUND, ok: false };

  const { deviceId } = connection.credentials;
  const login = await deps.clientFor(deviceId).loginWithKnownDevice({
    customerId: input.customerId,
    password: input.password,
  });
  if (!login.ok) {
    switch (login.error.kind) {
      case "password_rejected":
        return { error: MYINVESTOR_SAVE_REJECTED, ok: false };
      case "sms_required":
        return { error: MYINVESTOR_DEVICE_LAPSED, ok: false };
      default:
        return { error: loginErrorMessage(login.error.kind), ok: false };
    }
  }

  await deps.store.updateCredentials(
    input.sourceId,
    serializeMyInvestorCredentials({
      acceptance: { acceptedAt: deps.now, acceptedBy: deps.acceptedBy },
      customerId: input.customerId,
      deviceId,
      password: input.password,
    }),
  );
  return { ok: true };
}

/** «Dejar de guardarla»: the password goes at once, the device stays. */
export async function forgetMyInvestorPassword(
  deps: Pick<MyInvestorFlowDeps, "store">,
  sourceId: string,
): Promise<MyInvestorResultMessage> {
  const connection = await readConnection(deps.store, sourceId);
  if (!connection) return { error: MYINVESTOR_NOT_FOUND, ok: false };
  await deps.store.updateCredentials(
    sourceId,
    serializeMyInvestorCredentials({ deviceId: connection.credentials.deviceId }),
  );
  return { ok: true };
}
