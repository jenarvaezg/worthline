import { describe, expect, it } from "vitest";

import { parseFireConfigFormStrict } from "./fire";

/** A FIRE form with all required fields valid; override per test. */
function fireForm(overrides: Record<string, string> = {}): FormData {
  const base: Record<string, string> = {
    monthlySpending: "2000",
    safeWithdrawalRate: "4",
    expectedRealReturn: "7",
  };
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    form.set(key, value);
  }
  return form;
}

describe("parseFireConfigFormStrict — the age is not typed (#1415)", () => {
  it("never produces a currentAge, even if the form still posts one", () => {
    // The age is derived from the member's birth date at read time. A typed age
    // froze: 62 entered in 2025 was still 62 in 2026. A stray field (an old cached
    // page, a hand-crafted POST) must not resurrect the stale scalar.
    const result = parseFireConfigFormStrict(fireForm({ currentAge: "62" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.currentAge).toBeUndefined();
    }
  });

  it("still parses the target retirement age, which is a choice and not a fact", () => {
    const result = parseFireConfigFormStrict(fireForm({ targetRetirementAge: "67" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.targetRetirementAge).toBe(67);
    }
  });
});

describe("parseFireConfigFormStrict — monthlySavingsCapacity (#425)", () => {
  it("parses a positive monthly savings capacity into minor units", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ monthlySavingsCapacity: "1200" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.monthlySavingsCapacityMinor).toBe(120_000);
    }
  });

  it("accepts zero (you are simply not saving right now)", () => {
    const result = parseFireConfigFormStrict(fireForm({ monthlySavingsCapacity: "0" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.monthlySavingsCapacityMinor).toBe(0);
    }
  });

  it("omits the field when left blank, so a suggestion can fill it later", () => {
    const result = parseFireConfigFormStrict(fireForm());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.monthlySavingsCapacityMinor).toBeUndefined();
    }
  });

  it("ignores garbage input instead of failing the whole config", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ monthlySavingsCapacity: "no es un número" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.monthlySavingsCapacityMinor).toBeUndefined();
    }
  });
});

describe("parseFireConfigFormStrict — leanMultiplier/fatMultiplier (#513)", () => {
  it("blank inputs leave multipliers undefined (defaults used)", () => {
    const result = parseFireConfigFormStrict(fireForm());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.leanMultiplier).toBeUndefined();
      expect(result.command.fatMultiplier).toBeUndefined();
    }
  });

  it("parses valid lean/fat pair", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "0.6", fatMultiplier: "2.0" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.leanMultiplier).toBeCloseTo(0.6);
      expect(result.command.fatMultiplier).toBeCloseTo(2.0);
    }
  });

  it("rejects lean >= fat (out-of-order)", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "2.0", fatMultiplier: "0.5" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Lean.*Fat|Fat.*Lean/i);
    }
  });

  it("rejects lean == fat", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "1.0", fatMultiplier: "1.0" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects fat > 10 (unreasonable)", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "0.7", fatMultiplier: "11" }),
    );
    expect(result.ok).toBe(false);
  });

  it("garbage lean input → treated as absent, fat alone triggers validation with default lean", () => {
    // fat=0.5 with lean defaulting to 0.7 → 0.5 < 0.7, so lean >= fat → error
    const result = parseFireConfigFormStrict(
      fireForm({ leanMultiplier: "not-a-number", fatMultiplier: "0.5" }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("parseFireConfigFormStrict — the immobilized declaration (#1460)", () => {
  /** Lo que el formulario manda de verdad: el `hidden` primero, la casilla después. */
  function withCheckbox(checked: boolean): FormData {
    const form = fireForm();
    form.set("countImmobilized", "off");
    if (checked) {
      form.append("countImmobilized", "on");
    }
    return form;
  }

  it("a checked box declares that the brick counts", () => {
    const result = parseFireConfigFormStrict(withCheckbox(true));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.immobilizedCountsAsFireCapital).toBe(true);
    }
  });

  it("an unchecked box declares that it does not — that is the whole point of the hidden pair", () => {
    const result = parseFireConfigFormStrict(withCheckbox(false));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.immobilizedCountsAsFireCapital).toBe(false);
    }
  });

  it("a form that does not carry the field at all keeps the default: it counts", () => {
    // El agujero clásico de las casillas: «desmarcada» y «este formulario no habla del
    // tema» mandan lo mismo (nada). Sin esta distinción, cualquier formulario que
    // olvidara el campo declararía el ladrillo de un usuario fuera de su FIRE.
    const result = parseFireConfigFormStrict(fireForm());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.immobilizedCountsAsFireCapital).toBe(true);
    }
  });
});

describe("parseFireConfigFormStrict — el perfil de jubilación ordinaria (#1428)", () => {
  it("el umbral de edad ordinaria es un dato del usuario, con defecto neutro 65", () => {
    expect(parseFireConfigFormStrict(fireForm())).toMatchObject({
      command: { ordinaryRetirementAge: 65 },
      ok: true,
    });
    expect(
      parseFireConfigFormStrict(fireForm({ ordinaryRetirementAge: "70" })),
    ).toMatchObject({ command: { ordinaryRetirementAge: 70 }, ok: true });
  });

  it("la edad hasta la que debe durar el capital es opcional y no se inventa", () => {
    const result = parseFireConfigFormStrict(fireForm());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.lifeExpectancyAge).toBeUndefined();
    }
  });

  it("la acepta cuando se declara", () => {
    expect(
      parseFireConfigFormStrict(
        fireForm({ lifeExpectancyAge: "90", targetRetirementAge: "67" }),
      ),
    ).toMatchObject({ command: { lifeExpectancyAge: 90 }, ok: true });
  });

  it("rechaza una edad final anterior a la de jubilación: no habría años que repartir", () => {
    const result = parseFireConfigFormStrict(
      fireForm({ lifeExpectancyAge: "60", targetRetirementAge: "67" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("posterior a tu edad objetivo");
    }
  });

  it("rechaza una edad final imposible", () => {
    expect(parseFireConfigFormStrict(fireForm({ lifeExpectancyAge: "200" })).ok).toBe(
      false,
    );
  });

  it("guarda la declaración del plan cuando se elige", () => {
    expect(
      parseFireConfigFormStrict(fireForm({ retirementPlan: "ordinary" })),
    ).toMatchObject({ command: { retirementPlan: "ordinary" }, ok: true });
    expect(
      parseFireConfigFormStrict(fireForm({ retirementPlan: "early" })),
    ).toMatchObject({ command: { retirementPlan: "early" }, ok: true });
  });

  it("«sin decidir» no es una declaración, y un valor desconocido tampoco tumba el guardado", () => {
    for (const value of ["", "jubilado", "ORDINARY"]) {
      const result = parseFireConfigFormStrict(fireForm({ retirementPlan: value }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.command.retirementPlan).toBeUndefined();
      }
    }
  });
});
