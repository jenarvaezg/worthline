import { describe, expect, it } from "vitest";

import { chatAsOf } from "./chat-clock";

const TODAY = /^\d{4}-\d{2}-\d{2}$/;

describe("chatAsOf", () => {
  it("pins demo targets to the demo clock", () => {
    expect(chatAsOf({ kind: "demo", persona: "joven", now: "2026-06-19" })).toBe(
      "2026-06-19",
    );
  });

  it("resolves the unpinned demo clock (now: '') to a real date-key, never ''", () => {
    // Production demo targets carry now: "" (store-resolver.ts) — the store
    // opens at today via demoAsOfDateKey, so the tool must value at today too.
    const asOf = chatAsOf({ kind: "demo", persona: "joven", now: "" });
    expect(asOf).toMatch(TODAY);
  });

  it("uses today for live targets", () => {
    expect(chatAsOf({ kind: "local" })).toMatch(TODAY);
  });
});
