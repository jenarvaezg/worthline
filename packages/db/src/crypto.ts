/**
 * Secret crypto seam (S6 #387, ADR 0030 — extends ADR 0016 for the hosted
 * deployment). Connected-source secrets (`credentials_json`, `token_json` — a
 * trade-capable Binance signing secret among them) are encrypted at rest before
 * they reach Turso, so the cloud database holds only ciphertext. The
 * connected-source store reads/writes those columns through `seal` / `open`.
 *
 * AES-256-GCM with a random 12-byte IV per call (so the same plaintext seals to
 * distinct ciphertext) and the GCM auth tag (so tampering fails to open). The
 * env key is hashed to exactly 32 bytes (so any string works), but it MUST be a
 * high-entropy random secret — e.g. `openssl rand -base64 32` — not a passphrase:
 * SHA-256 is a key-derivation step, not a password-stretching one.
 *
 * Two graceful passthroughs keep local/dev and migration seamless:
 *   - no key configured ⇒ `seal`/`open` are the identity (local single-user mode
 *     keeps secrets in plaintext, as ADR 0016 always allowed locally);
 *   - a value without the `wlsec1:` prefix is returned verbatim by `open`, so a
 *     row written before encryption (or an imported `{}` placeholder) still reads.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "wlsec1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The env var holding the encryption key (any string; set at deploy). */
export const ENCRYPTION_KEY_ENV = "WORTHLINE_ENCRYPTION_KEY";

/** Normalize any key material to a 32-byte AES key. */
function keyFrom(material: string): Buffer {
  return createHash("sha256").update(material, "utf8").digest();
}

export interface SecretCrypto {
  /** Encrypt a secret for storage; identity when no key is configured. */
  seal(plaintext: string): string;
  /** Decrypt a sealed secret; identity for an unsealed (legacy/plaintext) value. */
  open(value: string): string;
}

/** Build a {@link SecretCrypto} bound to `keyMaterial` (undefined ⇒ passthrough). */
export function makeSecretCrypto(keyMaterial: string | undefined): SecretCrypto {
  const key = keyMaterial ? keyFrom(keyMaterial) : null;

  return {
    seal(plaintext) {
      if (!key) return plaintext;
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
    },
    open(value) {
      if (!value.startsWith(PREFIX)) return value;
      if (!key) {
        throw new Error(`Cannot open a sealed secret: ${ENCRYPTION_KEY_ENV} is not set.`);
      }
      const blob = Buffer.from(value.slice(PREFIX.length), "base64");
      const iv = blob.subarray(0, IV_BYTES);
      const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}

/** Seal a secret with the env-configured key (passthrough when unset). */
export function sealSecret(plaintext: string): string {
  return makeSecretCrypto(process.env[ENCRYPTION_KEY_ENV]).seal(plaintext);
}

/** Open a secret with the env-configured key (passthrough for legacy plaintext). */
export function openSecret(value: string): string {
  return makeSecretCrypto(process.env[ENCRYPTION_KEY_ENV]).open(value);
}
