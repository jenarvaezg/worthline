/**
 * Who may run a manual capture from /historico.
 *
 * The rule under test is a security boundary, not a display preference: the page
 * asks it to decide whether to RENDER the button, and the action asks it again to
 * decide whether to RUN the write. If those two could disagree, a hosted deploy
 * would either show a button that 403s or accept a POST its own page refuses —
 * so both read this one function, and the variants are pinned here exhaustively.
 *
 * Local mode is the ONLY allowed target. Not the demo (read-only, and no store to
 * write — `blockedWriteMessage` already refuses it in every mutating action), and
 * not a hosted workspace (ADR 0037's twice-daily cron is already its writer, and
 * a second on-demand path would stamp whatever the price cache held at the click
 * into a day the cron will later overwrite).
 */

import type { StoreTarget } from "@web/store-resolver";
import { describe, expect, test } from "vitest";

import {
  LOCAL_CAPTURE_ONLY_MESSAGE,
  localCaptureAllowed,
  localCaptureRefusal,
} from "./local-capture";

const HOSTED: StoreTarget = {
  kind: "authenticated",
  workspaceId: "ws_1",
  dbUrl: "libsql://example.turso.io",
  token: "jwt",
};

describe("localCaptureRefusal", () => {
  test("the local no-auth store may capture", () => {
    expect(localCaptureRefusal({ kind: "local" })).toBeNull();
    expect(localCaptureAllowed({ kind: "local" })).toBe(true);
  });

  test("a hosted workspace may not: the cron is already its writer", () => {
    expect(localCaptureRefusal(HOSTED)).toBe(LOCAL_CAPTURE_ONLY_MESSAGE);
    expect(localCaptureAllowed(HOSTED)).toBe(false);
  });

  test("an impersonating admin may not either — it is a hosted workspace", () => {
    expect(
      localCaptureRefusal({ ...HOSTED, impersonatedEmail: "admin@worthline.app" }),
    ).toBe(LOCAL_CAPTURE_ONLY_MESSAGE);
  });

  test("the demo may not", () => {
    expect(
      localCaptureRefusal({
        kind: "demo",
        persona: "joven",
        now: "2026-06-18T10:00:00.000Z",
      }),
    ).toBe(LOCAL_CAPTURE_ONLY_MESSAGE);
  });

  test("a request with no principal may not", () => {
    expect(localCaptureRefusal({ kind: "unauthenticated" })).toBe(
      LOCAL_CAPTURE_ONLY_MESSAGE,
    );
  });

  test("the refusal is one Spanish sentence naming the mode that allows it", () => {
    expect(LOCAL_CAPTURE_ONLY_MESSAGE).toBe(
      "La captura manual solo existe en el modo local, donde no hay captura programada.",
    );
  });

  test("every non-local target is refused with the SAME message", () => {
    // One message, so the wording cannot drift between the page and the action.
    const refusals = [
      HOSTED,
      { ...HOSTED, impersonatedEmail: "admin@worthline.app" },
      { kind: "demo", persona: "familia", now: "2026-06-18T10:00:00.000Z" },
      { kind: "unauthenticated" },
    ] satisfies StoreTarget[];

    expect(new Set(refusals.map(localCaptureRefusal))).toEqual(
      new Set([LOCAL_CAPTURE_ONLY_MESSAGE]),
    );
  });
});
