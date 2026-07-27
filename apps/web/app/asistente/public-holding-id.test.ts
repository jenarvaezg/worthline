import {
  isPublicHoldingId,
  publicHoldingIdsIn,
  replacePublicHoldingIdLookalikes,
} from "@web/asistente/public-holding-id";
import { describe, expect, it } from "vitest";

const REAL = "wl_hld_c5d97d4b4a1b9d7b42f2b7a976f0d14b";
const OTHER = "wl_hld_3d4408012674258705c93c4e320f750d";

describe("isPublicHoldingId", () => {
  it("accepts the minted shape and nothing else", () => {
    expect(isPublicHoldingId(REAL)).toBe(true);
    // Uppercase hex, a short id, the bare prefix and a scope id are all not it.
    expect(isPublicHoldingId(REAL.toUpperCase())).toBe(false);
    expect(isPublicHoldingId("wl_hld_3d44")).toBe(false);
    expect(isPublicHoldingId("wl_hld_")).toBe(false);
    expect(isPublicHoldingId("wl_scp_c5d97d4b4a1b9d7b42f2b7a976f0d14b")).toBe(false);
  });

  it("rejects an id with anything around it", () => {
    expect(isPublicHoldingId(` ${REAL}`)).toBe(false);
    expect(isPublicHoldingId(`${REAL}x`)).toBe(false);
  });
});

describe("publicHoldingIdsIn", () => {
  it("finds ids at any depth, deduplicated in first-seen order", () => {
    expect(
      publicHoldingIdsIn({
        holdings: [{ id: OTHER, label: "Hipoteca" }, { id: REAL }],
        nested: { deeper: [[{ trace: { holding: REAL } }]] },
      }),
    ).toEqual([OTHER, REAL]);
  });

  it("finds an id embedded in prose, and ignores the malformed lookalike", () => {
    expect(publicHoldingIdsIn(`el holding \`${REAL}\` es tuyo`)).toEqual([REAL]);
    expect(publicHoldingIdsIn("wl_hld_mortgage_id_placeholder_need_to_find_it")).toEqual(
      [],
    );
  });

  it("survives a value no serializer would take", () => {
    const cyclic: Record<string, unknown> = { id: REAL };
    cyclic["self"] = cyclic;
    expect(() => publicHoldingIdsIn(cyclic)).not.toThrow();
  });
});

describe("replacePublicHoldingIdLookalikes", () => {
  it("replaces a well-formed id and eats its backticks", () => {
    expect(
      replacePublicHoldingIdLookalikes(`El ID es \`${REAL}\`.`, () => "«Hipoteca»"),
    ).toBe("El ID es «Hipoteca».");
  });

  it("replaces the malformed id the model sent to a write tool (#1263)", () => {
    expect(
      replacePublicHoldingIdLookalikes(
        "uso wl_hld_mortgage_id_placeholder_need_to_find_it ahora",
        () => "X",
      ),
    ).toBe("uso X ahora");
  });

  it("replaces a half-typed id, so nothing flashes while the answer streams", () => {
    expect(replacePublicHoldingIdLookalikes("el id es wl_hld_3d44", () => "X")).toBe(
      "el id es X",
    );
  });

  it("hands the replacement the bare token, without backticks", () => {
    const seen: string[] = [];
    replacePublicHoldingIdLookalikes(`\`${REAL}\` y ${OTHER}`, (token) => {
      seen.push(token);
      return "X";
    });
    expect(seen).toEqual([REAL, OTHER]);
  });

  it("leaves prose without ids untouched", () => {
    const text = "Tu patrimonio neto es 12.585 € a 19/06/2026.";
    expect(replacePublicHoldingIdLookalikes(text, () => "X")).toBe(text);
  });
});
