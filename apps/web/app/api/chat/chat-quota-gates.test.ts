import { FREE_ASSISTANT_MONTHLY_QUOTA } from "@web/asistente/courtesy-quota";
import { GLOBAL_DAILY_TOKEN_FUSE } from "@web/asistente/token-budget";
import { VISION_CALL_LIMITS } from "@web/asistente/vision-call-budget";
import {
  PAYWALL_ATTACHMENT_MESSAGE,
  PAYWALL_COURTESY_MESSAGE,
  PAYWALL_GLOBAL_FUSE_MESSAGE,
  PAYWALL_TOKEN_BUDGET_MESSAGE,
  PAYWALL_VISION_BUDGET_MESSAGE,
  PAYWALL_VISION_FUSE_MESSAGE,
} from "@web/entitlements/paywall-copy";
import type { StoreTarget } from "@web/store-resolver";
import type { EntitlementPlan } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  chatRateLimitReached,
  openTurnSpendDoors,
  type TurnSpendReaders,
  visionMeterFor,
} from "./chat-quota-gates";

/**
 * The five spend doors, exercised without a request, a store, a provider or a model.
 *
 * That is the whole point of the seam (#1697): before it, asserting «the courtesy
 * paywall wins over the vision fuse» meant booting the entire handler with a mock
 * language model, and the route test grew to 3 000 lines because there was no other
 * way in. Here a door is a function call and the cascade's ORDER is asserted directly
 * — which matters, because the order is the part that only lived in comments.
 */

const NOW = "2026-08-31T10:00:00.000Z";

const AUTHENTICATED: StoreTarget = {
  dbUrl: "libsql://ws1",
  kind: "authenticated",
  token: "t",
  workspaceId: "ws1",
};
const DEMO: StoreTarget = { kind: "demo", now: NOW, persona: "familia" };
const LOCAL: StoreTarget = { kind: "local" };

function image(name = "captura.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function sheet(): File {
  return new File([new Uint8Array([1])], "cartera.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/**
 * Readers that say «nothing spent, plan premium» unless a test overrides one. A door
 * that fires here fired because of what the test set, never because of a default.
 */
function readers(overrides: Partial<TurnSpendReaders> = {}): TurnSpendReaders {
  return {
    countAssistantCourtesyUse: async () => 0,
    readAiTokenUsage: async () => ({ globalTokens: 0, workspaceTokens: 0 }),
    readEffectivePlan: async () => "premium" as EntitlementPlan,
    readVisionCallUsage: async () => ({ globalCalls: 0, scopeCalls: 0 }),
    ...overrides,
  };
}

describe("openTurnSpendDoors · every door on its own", () => {
  test("lets an ordinary premium turn through and reports what it derived", async () => {
    expect(
      await openTurnSpendDoors(
        { attachment: null, ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers(),
      ),
    ).toEqual({ ingestionAllowed: true, kind: "open", visionMeter: null });
  });

  test("a free workspace may talk, but not have a document read for it", async () => {
    const free = readers({ readEffectivePlan: async () => "free" });
    expect(
      await openTurnSpendDoors(
        { attachment: null, ip: null, nowIso: NOW, target: AUTHENTICATED },
        free,
      ),
    ).toMatchObject({ ingestionAllowed: false, kind: "open" });
    expect(
      await openTurnSpendDoors(
        { attachment: image(), ip: null, nowIso: NOW, target: AUTHENTICATED },
        free,
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_ATTACHMENT_MESSAGE });
  });

  test("the shared token fuse stops every authenticated caller", async () => {
    expect(
      await openTurnSpendDoors(
        { attachment: null, ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers({
          readAiTokenUsage: async () => ({
            globalTokens: GLOBAL_DAILY_TOKEN_FUSE,
            workspaceTokens: 0,
          }),
        }),
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_GLOBAL_FUSE_MESSAGE });
  });

  test("the workspace token budget bites the paid plans only", async () => {
    const spent = { globalTokens: 0, workspaceTokens: 5_000_000 };
    expect(
      await openTurnSpendDoors(
        { attachment: null, ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers({ readAiTokenUsage: async () => spent }),
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_TOKEN_BUDGET_MESSAGE });
    // A free workspace is bounded by the courtesy quota, never by tokens (S2/S3).
    expect(
      await openTurnSpendDoors(
        { attachment: null, ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers({
          readAiTokenUsage: async () => spent,
          readEffectivePlan: async () => "free",
        }),
      ),
    ).toMatchObject({ kind: "open" });
  });

  test("the monthly courtesy quota bounds the free plan", async () => {
    // Increment-then-check, mirroring the ADR 0051 rate limit: the Nth turn still
    // passes and the (N+1)th is the first refused.
    const free = (used: number) =>
      readers({
        countAssistantCourtesyUse: async () => used,
        readEffectivePlan: async () => "free",
      });
    expect(
      await openTurnSpendDoors(
        { attachment: null, ip: null, nowIso: NOW, target: AUTHENTICATED },
        free(FREE_ASSISTANT_MONTHLY_QUOTA),
      ),
    ).toMatchObject({ kind: "open" });
    expect(
      await openTurnSpendDoors(
        { attachment: null, ip: null, nowIso: NOW, target: AUTHENTICATED },
        free(FREE_ASSISTANT_MONTHLY_QUOTA + 1),
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_COURTESY_MESSAGE });
  });

  test("an oversized upload is refused, not paywalled", async () => {
    const huge = new File([new Uint8Array(1)], "grande.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: 5 * 1024 * 1024 });
    expect(
      await openTurnSpendDoors(
        { attachment: huge, ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers(),
      ),
    ).toEqual({ error: "attachment_too_large", kind: "refused", status: 413 });
  });

  test("the vision fuse and the scope's own allowance each have their own copy", async () => {
    expect(
      await openTurnSpendDoors(
        { attachment: image(), ip: "1.2.3.4", nowIso: NOW, target: DEMO },
        readers({
          readVisionCallUsage: async () => ({
            globalCalls: VISION_CALL_LIMITS.global,
            scopeCalls: 0,
          }),
        }),
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_VISION_FUSE_MESSAGE });
    expect(
      await openTurnSpendDoors(
        { attachment: image(), ip: "1.2.3.4", nowIso: NOW, target: DEMO },
        readers({
          readVisionCallUsage: async () => ({
            globalCalls: 0,
            scopeCalls: VISION_CALL_LIMITS.demo,
          }),
        }),
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_VISION_BUDGET_MESSAGE });
  });

  test("nothing metered reads as nothing spent (local dev)", async () => {
    // A null read is unmetered, and the pure predicates must never fire on it.
    expect(
      await openTurnSpendDoors(
        { attachment: image(), ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers({
          countAssistantCourtesyUse: async () => null,
          readAiTokenUsage: async () => null,
          readVisionCallUsage: async () => null,
        }),
      ),
    ).toMatchObject({ kind: "open" });
  });
});

describe("openTurnSpendDoors · the ORDER between the doors", () => {
  test("the attachment paywall speaks before the token fuse", async () => {
    // A free workspace with a blown shared fuse and a document: what it can act on is
    // that free workspaces do not get documents read, not that everyone is paused.
    expect(
      await openTurnSpendDoors(
        { attachment: image(), ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers({
          readAiTokenUsage: async () => ({
            globalTokens: GLOBAL_DAILY_TOKEN_FUSE,
            workspaceTokens: 0,
          }),
          readEffectivePlan: async () => "free",
        }),
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_ATTACHMENT_MESSAGE });
  });

  test("the shared fuse speaks before the workspace's own budget", async () => {
    expect(
      await openTurnSpendDoors(
        { attachment: null, ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers({
          readAiTokenUsage: async () => ({
            globalTokens: GLOBAL_DAILY_TOKEN_FUSE,
            workspaceTokens: 5_000_000,
          }),
        }),
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_GLOBAL_FUSE_MESSAGE });
  });

  test("the paywalls speak before the 413", async () => {
    // The caller has already spent their allowance: telling them about the file size
    // would send them back with a smaller file to the very same wall.
    const huge = image();
    Object.defineProperty(huge, "size", { value: 5 * 1024 * 1024 });
    expect(
      await openTurnSpendDoors(
        { attachment: huge, ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers({
          readAiTokenUsage: async () => ({ globalTokens: 0, workspaceTokens: 5_000_000 }),
        }),
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_TOKEN_BUDGET_MESSAGE });
    // And a free workspace never reaches the 413 at all: no plan of its can have a
    // document read, so the ingestion paywall answers first whatever the file weighs.
    expect(
      await openTurnSpendDoors(
        { attachment: huge, ip: null, nowIso: NOW, target: AUTHENTICATED },
        readers({ readEffectivePlan: async () => "free" }),
      ),
    ).toEqual({ kind: "paywall", message: PAYWALL_ATTACHMENT_MESSAGE });
  });

  test("the 413 speaks before the vision fuse: a file too big costs no reading", async () => {
    const huge = image();
    Object.defineProperty(huge, "size", { value: 5 * 1024 * 1024 });
    expect(
      await openTurnSpendDoors(
        { attachment: huge, ip: "1.2.3.4", nowIso: NOW, target: DEMO },
        readers({
          readVisionCallUsage: async () => ({
            globalCalls: VISION_CALL_LIMITS.global,
            scopeCalls: 0,
          }),
        }),
      ),
    ).toEqual({ error: "attachment_too_large", kind: "refused", status: 413 });
  });
});

describe("visionMeterFor", () => {
  test("charges an image to the caller's own scope", async () => {
    expect(
      visionMeterFor({ attachment: image(), ip: null, target: AUTHENTICATED }),
    ).toMatchObject({ dailyLimit: VISION_CALL_LIMITS.workspace, mode: "count" });
  });

  test("never charges a spreadsheet, which reaches no model", () => {
    expect(
      visionMeterFor({ attachment: sheet(), ip: null, target: AUTHENTICATED }),
    ).toBeNull();
  });

  test("never charges local dev, where the developer owns the key", () => {
    expect(visionMeterFor({ attachment: image(), ip: null, target: LOCAL })).toBeNull();
  });

  test("nothing to meter with no attachment", () => {
    expect(
      visionMeterFor({ attachment: null, ip: null, target: AUTHENTICATED }),
    ).toBeNull();
  });
});

describe("chatRateLimitReached", () => {
  test("stops the caller over their own window", async () => {
    expect(
      await chatRateLimitReached(
        { ip: "1.2.3.4", nowIso: NOW, target: AUTHENTICATED },
        async () => 10_000,
      ),
    ).toBe(true);
  });

  test("lets a caller inside their window through", async () => {
    expect(
      await chatRateLimitReached(
        { ip: "1.2.3.4", nowIso: NOW, target: AUTHENTICATED },
        async () => 1,
      ),
    ).toBe(false);
  });

  test("a demo visitor answers to the shared hourly budget as well", async () => {
    // Two keys are counted for a demo turn — the visitor's and the global one — and
    // going over EITHER stops the turn (#1184, ADR 0051).
    const keys: string[] = [];
    expect(
      await chatRateLimitReached(
        { ip: "1.2.3.4", nowIso: NOW, target: DEMO },
        async (key) => {
          keys.push(key);
          return 1;
        },
      ),
    ).toBe(false);
    expect(keys).toHaveLength(2);
  });

  test("an unmetered count never rate-limits (local dev)", async () => {
    expect(
      await chatRateLimitReached(
        { ip: null, nowIso: NOW, target: LOCAL },
        async () => null,
      ),
    ).toBe(false);
  });
});
