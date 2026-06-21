/**
 * Connected-source secret-at-rest tests (S6 #387, ADR 0030). The store seals
 * `credentials_json` / `token_json` on write and opens them on read, so the
 * database holds only ciphertext while callers (the refreshers) still see
 * plaintext. A value written before encryption (no key) reads back through a
 * later key as plaintext, so enabling encryption never strands existing rows.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorthlineStore, openLibsqlClient } from "./index";

const KEY = "test-secret-key";

afterEach(() => {
  delete process.env.WORTHLINE_ENCRYPTION_KEY;
});

async function freshStore(): Promise<{
  store: Awaited<ReturnType<typeof createWorthlineStore>>;
  dbPath: string;
}> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wl-secret-")), "w.sqlite");
  const store = await createWorthlineStore({ databasePath: dbPath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "individual",
  });
  return { store, dbPath };
}

describe("connected source secret encryption", () => {
  it("stores credentials + token as ciphertext at rest, returns plaintext on read", async () => {
    process.env.WORTHLINE_ENCRYPTION_KEY = KEY;
    const { store, dbPath } = await freshStore();
    const creds = JSON.stringify({ apiKey: "AK", apiSecret: "SK" });
    const tokenJson = JSON.stringify({ token: "T" });

    const { sourceId } = await store.connectedSources.connect({
      adapter: "binance",
      label: "Binance",
      credentialsJson: creds,
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
    });
    await store.connectedSources.saveToken(sourceId, tokenJson);

    // Through the store API: plaintext (what the refreshers consume).
    const source = await store.connectedSources.readSource(sourceId);
    expect(source?.credentialsJson).toBe(creds);
    expect(source?.tokenJson).toBe(tokenJson);
    const listed = await store.connectedSources.listSources();
    expect(listed[0]?.credentialsJson).toBe(creds);
    store.close();

    // At rest: ciphertext, never the plaintext secret.
    const raw = openLibsqlClient(dbPath);
    const result = await raw.execute(
      "SELECT credentials_json, token_json FROM connected_sources",
    );
    raw.close();
    const rawCreds = result.rows[0]?.credentials_json as string;
    const rawToken = result.rows[0]?.token_json as string;
    expect(rawCreds.startsWith("wlsec1:")).toBe(true);
    expect(rawCreds).not.toContain("AK");
    expect(rawToken.startsWith("wlsec1:")).toBe(true);
  });

  it("opens credentials written before encryption (legacy plaintext) once a key is set", async () => {
    const { store, dbPath } = await freshStore();
    const creds = JSON.stringify({ apiKey: "legacy" });

    // Connected with NO key configured → stored as plaintext.
    const { sourceId } = await store.connectedSources.connect({
      adapter: "binance",
      label: "Binance",
      credentialsJson: creds,
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
    });
    store.close();

    const raw = openLibsqlClient(dbPath);
    const before = await raw.execute("SELECT credentials_json FROM connected_sources");
    raw.close();
    expect(before.rows[0]?.credentials_json).toBe(creds); // plaintext at rest

    // Later a key is configured; the legacy row still reads back as plaintext.
    process.env.WORTHLINE_ENCRYPTION_KEY = KEY;
    const reopened = await createWorthlineStore({ databasePath: dbPath });
    const source = await reopened.connectedSources.readSource(sourceId);
    expect(source?.credentialsJson).toBe(creds);
    reopened.close();
  });
});
