import { describe, expect, it } from "vitest";

import {
  DEFAULT_PERSONA,
  PERSONA_IDS,
  PERSONA_META,
  isPersonaId,
  parsePersonaId,
} from "@web/demo/persona";

describe("persona vocabulary", () => {
  it("lists the three demo personas", () => {
    expect([...PERSONA_IDS]).toEqual(["joven", "inversor", "familia"]);
  });

  it("defaults to familia (the richest cold-visit story)", () => {
    expect(DEFAULT_PERSONA).toBe("familia");
    expect(PERSONA_IDS).toContain(DEFAULT_PERSONA);
  });

  it("recognizes only the known persona ids", () => {
    expect(isPersonaId("familia")).toBe(true);
    expect(isPersonaId("joven")).toBe(true);
    expect(isPersonaId("inversor")).toBe(true);
    expect(isPersonaId("banana")).toBe(false);
    expect(isPersonaId("")).toBe(false);
    expect(isPersonaId(undefined)).toBe(false);
    expect(isPersonaId(42)).toBe(false);
  });

  it("parses a known persona value and falls back to familia otherwise", () => {
    expect(parsePersonaId("inversor")).toBe("inversor");
    expect(parsePersonaId("familia")).toBe("familia");
    expect(parsePersonaId("nope")).toBe("familia");
    expect(parsePersonaId(null)).toBe("familia");
    expect(parsePersonaId(undefined)).toBe("familia");
  });

  it("carries display metadata (label + pitch) for every persona", () => {
    for (const id of PERSONA_IDS) {
      const meta = PERSONA_META[id];
      expect(meta.id).toBe(id);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.pitch.length).toBeGreaterThan(0);
    }
  });
});
