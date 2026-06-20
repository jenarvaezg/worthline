import { describe, expect, it } from "vitest";

import { DEMO_PERSONA_COOKIE_NAME, demoContextFromTarget } from "@web/demo/demo-context";

describe("demoContextFromTarget", () => {
  it("is enabled for a demo target, carrying its persona and pinned clock", () => {
    const ctx = demoContextFromTarget({
      kind: "demo",
      persona: "inversor",
      now: "2026-06-19T00:00:00.000Z",
    });
    expect(ctx.enabled).toBe(true);
    expect(ctx.persona).toBe("inversor");
    expect(ctx.now).toBe("2026-06-19T00:00:00.000Z");
  });

  it("is disabled for non-demo targets, defaulting to the familia persona", () => {
    for (const target of [
      { kind: "local" } as const,
      { kind: "unauthenticated" } as const,
      {
        kind: "authenticated" as const,
        workspaceId: "ws",
        dbUrl: "libsql://x",
        token: "t",
      },
    ]) {
      const ctx = demoContextFromTarget(target);
      expect(ctx.enabled).toBe(false);
      expect(ctx.persona).toBe("familia");
      expect(ctx.now).toBe("");
    }
  });

  it("exposes the persona cookie name (mirrors wl_scope)", () => {
    expect(DEMO_PERSONA_COOKIE_NAME).toBe("wl_demo_persona");
  });
});
