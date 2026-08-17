import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_ALLOWLIST } from "./provider-pool";
import { MODEL_PROMPT_CAPACITY, turnPromptBudget } from "./turn-prompt-budget";

describe("turnPromptBudget (#1408)", () => {
  it("da a cada modelo del pool una ficha de capacidad", () => {
    // The invariant that keeps the budget honest: admitting a model without reading
    // its published capacity would silently hand it the floors.
    for (const entry of DEFAULT_PROVIDER_ALLOWLIST) {
      const capacity = MODEL_PROMPT_CAPACITY[`${entry.provider}/${entry.modelId}`];
      expect(capacity, `${entry.provider}/${entry.modelId} sin ficha`).toBeDefined();
      expect(capacity!.source).not.toBe("");
      expect(capacity!.inputTokens ?? capacity!.tokensPerMinute).toBeGreaterThan(0);
    }
  });

  it("le da a flash-lite un presupuesto que contiene un documento recitado", () => {
    const budget = turnPromptBudget({
      provider: "google",
      modelId: "gemini-3.1-flash-lite",
    });

    // The recitation that closed the reported conversation was ~20 000 characters
    // against a 16 000 ceiling. It now fits ten times over.
    expect(budget.proseChars).toBeGreaterThanOrEqual(200_000);
    expect(budget.attachmentChars).toBe(256_000);
  });

  it("deja al fallback en el suelo, porque es lo que su minuto permite", () => {
    // 30 000 tokens per minute across up to six steps is ~5 000 tokens per request,
    // and the turn floor alone exceeds that. This entry lands on the floors by
    // arithmetic: it can serve short turns, and its 429 fails over for the rest.
    const budget = turnPromptBudget({ provider: "cerebras", modelId: "gpt-oss-120b" });

    expect(budget.proseChars).toBe(8_000);
    expect(budget.attachmentChars).toBe(16_000);
  });

  it("un modelo nuevo del MISMO proveedor hereda su ficha, no el suelo", () => {
    // A version bump must not silently turn the assistant into one that forgets
    // attachments — that is the failure #1408 is about, arriving through the door
    // of a config change instead of a ceiling.
    const budget = turnPromptBudget({ provider: "google", modelId: "gemini-9-ultra" });

    expect(budget.proseChars).toBe(200_000);
    expect(budget.attachmentChars).toBe(256_000);
  });

  it("un proveedor desconocido sí recibe el suelo, nunca un presupuesto inventado", () => {
    const budget = turnPromptBudget({ provider: "acme", modelId: "acme-1" });

    expect(budget.proseChars).toBe(8_000);
    expect(budget.attachmentChars).toBe(16_000);
  });

  it("mantiene el techo del cuaderno muy por debajo del de la conversación", () => {
    // What #1408 asked for explicitly: `MAX_CONTEXT_CHARS` (12 000 — what a
    // spreadsheet hands the model to describe) used to be 75 % of the whole prose
    // ceiling, so describing a document faithfully was enough to end the thread.
    const budget = turnPromptBudget({
      provider: "google",
      modelId: "gemini-3.1-flash-lite",
    });

    expect(12_000 / budget.proseChars).toBeLessThan(0.1);
  });
});
