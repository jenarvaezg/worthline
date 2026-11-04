/**
 * What the MyInvestor connection keeps and what its forms may send (#1879, ADR
 * 0114). Both stored shapes are sealed by the store (ADR 0030); this module only
 * gives them a schema, so a blob that does not parse is treated as absent.
 *
 * - `credentials_json`: always the `deviceId` MyInvestor trusts after the SMS. With
 *   the opt-in of decision 1, also the username, the password and who accepted
 *   the risk and when.
 * - The pending step of the two-step SMS: the device, the signature request and the
 *   code's signature id. With the box ticked, also the credentials it will keep,
 *   because the user is not asked for them again after the code.
 */
import type { MyInvestorCredentials } from "@worthline/pricing";
import { z } from "zod";
import { readStoredJson } from "./stored-json";

export interface MyInvestorAcceptance {
  /** ISO instant the box was ticked and the statement accepted. */
  readonly acceptedAt: string;
  /** The session's email; null in local single-user mode, which has no session. */
  readonly acceptedBy: string | null;
}

export type MyInvestorStoredCredentials =
  | { readonly deviceId: string }
  | (MyInvestorCredentials & {
      readonly deviceId: string;
      readonly acceptance: MyInvestorAcceptance;
    });

export interface MyInvestorPendingSave extends MyInvestorCredentials {
  readonly acceptedBy: string | null;
}

export interface MyInvestorPendingPayload {
  readonly deviceId: string;
  readonly requestId: string;
  readonly signatureId: string;
  /** Null without the opt-in: then the pending step holds no credential at all. */
  readonly save: MyInvestorPendingSave | null;
}

const text = z.string().min(1);

const acceptanceSchema = z.object({
  acceptedAt: text,
  acceptedBy: text.nullable(),
});

const credentialsSchema = z.object({
  deviceId: text,
  customerId: text.optional(),
  password: text.optional(),
  acceptance: acceptanceSchema.optional(),
});

const pendingSchema = z.object({
  deviceId: text,
  requestId: text,
  signatureId: text,
  save: z
    .object({ customerId: text, password: text, acceptedBy: text.nullable() })
    .nullable(),
});

/** Whether these credentials carry a remembered password (the opt-in). */
export function hasSavedPassword(
  credentials: MyInvestorStoredCredentials,
): credentials is Extract<MyInvestorStoredCredentials, { password: string }> {
  return "password" in credentials;
}

export function serializeMyInvestorCredentials(
  credentials: MyInvestorStoredCredentials,
): string {
  return JSON.stringify(
    hasSavedPassword(credentials)
      ? {
          acceptance: credentials.acceptance,
          customerId: credentials.customerId,
          deviceId: credentials.deviceId,
          password: credentials.password,
        }
      : { deviceId: credentials.deviceId },
  );
}

/**
 * The stored credentials, or null when the blob is not ours. A password without
 * its acceptance is not an opt-in (decision 1 records both together), so it reads
 * as the device alone.
 */
export function readMyInvestorCredentials(
  json: string,
): MyInvestorStoredCredentials | null {
  const parsed = readStoredJson(credentialsSchema, json, "myinvestor credentials");
  if (parsed === null) return null;
  const { acceptance, customerId, deviceId, password } = parsed;
  return acceptance && customerId && password
    ? { acceptance, customerId, deviceId, password }
    : { deviceId };
}

export function serializeMyInvestorPending(payload: MyInvestorPendingPayload): string {
  return JSON.stringify(payload);
}

export function readMyInvestorPending(json: string): MyInvestorPendingPayload | null {
  return readStoredJson(pendingSchema, json, "myinvestor pending step");
}

export interface MyInvestorLoginInput extends MyInvestorCredentials {
  readonly save: boolean;
}

/** The longest username or code a form may send; anything longer is not one. */
const MAX_CUSTOMER_ID = 20;
const MAX_PASSWORD = 200;

/**
 * Step 1 of the form. The username (DNI or NIE) is trimmed and upper-cased; the
 * password goes as typed, spaces included, because it is the bank's to judge.
 */
export function parseMyInvestorLogin(
  formData: FormData,
): { ok: true; value: MyInvestorLoginInput } | { ok: false; error: string } {
  const customerId = String(formData.get("customerId") ?? "")
    .trim()
    .toUpperCase();
  const password = String(formData.get("password") ?? "");
  if (!customerId || customerId.length > MAX_CUSTOMER_ID) {
    return { ok: false, error: "Escribe el DNI o NIE con el que entras en MyInvestor." };
  }
  if (!password || password.length > MAX_PASSWORD) {
    return { ok: false, error: "Escribe la contraseña de MyInvestor." };
  }
  return {
    ok: true,
    value: { customerId, password, save: formData.get("savePassword") === "on" },
  };
}

/** Step 2: the SMS code, spaces aside, or null when it is not a code. */
export function parseMyInvestorCode(formData: FormData): string | null {
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");
  return /^\d{4,10}$/.test(code) ? code : null;
}
