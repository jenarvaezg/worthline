import { describe, expect, it } from "vitest";

import { buildChatSystemPrompt } from "./system-prompt";

describe("buildChatSystemPrompt", () => {
  it("embeds the screen context so the model knows what the user is looking at", () => {
    const prompt = buildChatSystemPrompt({
      route: "/patrimonio",
      section: "patrimonio",
      holdingId: null,
      view: { exp: "equity" },
    });

    expect(prompt).toContain("/patrimonio");
    expect(prompt).toContain('"exp": "equity"');
  });

  it("works without a screen context and pins the core rules", () => {
    const prompt = buildChatSystemPrompt(null);

    // The non-negotiables: Spanish default, no invented facts, read-only.
    expect(prompt).toMatch(/español/i);
    expect(prompt).toMatch(/no inventes/i);
    expect(prompt).toMatch(/solo lectura|no puedes modificar/i);
  });
});
