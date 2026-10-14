/**
 * The chat refuses a viewer (#1843, ADR 0112): a turn writes drafts into the
 * workspace and spends AI quota, and a viewer may do neither in the owner's
 * workspace. The refusal comes right after the authentication check — before the
 * providers are resolved, the rate limit counted, any quota read or written, or
 * the store opened.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@web/read-store-target", () => ({ readStoreTarget: vi.fn() }));
vi.mock("@web/asistente/chat-model", () => ({ resolveChatModels: vi.fn(() => []) }));
vi.mock("@web/asistente/rate-limit-store", () => ({ countChatRequest: vi.fn() }));
vi.mock("@web/entitlements/read-effective-plan", () => ({ readEffectivePlan: vi.fn() }));
vi.mock("@web/asistente/courtesy-quota-store", () => ({
  countAssistantCourtesyUse: vi.fn(),
}));
vi.mock("@web/asistente/token-budget-store", () => ({
  readAiTokenUsage: vi.fn(),
  recordAiTokenUsage: vi.fn(),
}));
vi.mock("@web/asistente/vision-call-budget-store", () => ({
  readVisionCallUsage: vi.fn(),
  recordVisionCalls: vi.fn(),
}));
vi.mock("@web/store", () => ({ withStore: vi.fn() }));

import { resolveChatModels } from "@web/asistente/chat-model";
import { countAssistantCourtesyUse } from "@web/asistente/courtesy-quota-store";
import { countChatRequest } from "@web/asistente/rate-limit-store";
import { readAiTokenUsage, recordAiTokenUsage } from "@web/asistente/token-budget-store";
import {
  readVisionCallUsage,
  recordVisionCalls,
} from "@web/asistente/vision-call-budget-store";
import { readEffectivePlan } from "@web/entitlements/read-effective-plan";
import { readStoreTarget } from "@web/read-store-target";
import { withStore } from "@web/store";

import { POST } from "./route";

const VIEWER = {
  kind: "authenticated" as const,
  workspaceId: "ws-jorge",
  dbUrl: "libsql://wl-jorge.turso.io",
  token: "read-only-jorge",
  sharedByEmail: "jorge@example.com",
};

function chatPost(): Request {
  return new Request("http://127.0.0.1:3001/api/chat", {
    body: JSON.stringify({
      messages: [
        { id: "m1", parts: [{ text: "¿Cuánto tengo?", type: "text" }], role: "user" },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readStoreTarget).mockResolvedValue(VIEWER);
});

describe("POST /api/chat · viewer (#1843)", () => {
  test("answers 403 read_only before providers, rate limit, quotas or store", async () => {
    const response = await POST(chatPost());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "read_only" });

    for (const untouched of [
      resolveChatModels,
      countChatRequest,
      readEffectivePlan,
      countAssistantCourtesyUse,
      readAiTokenUsage,
      recordAiTokenUsage,
      readVisionCallUsage,
      recordVisionCalls,
      withStore,
    ]) {
      expect(untouched).not.toHaveBeenCalled();
    }
  });
});
