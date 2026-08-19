import { describe, expect, it } from "vitest";
import { fireDrawsFromTier, splitFireCapital } from "./fire-capital-split";

describe("splitFireCapital", () => {
  it("splits the eligible pool into sellable and immobilized sides", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, housing: 300_000 },
      debtByTierMinor: {},
    });

    expect(split.sellable.amountMinor).toBe(100_000);
    expect(split.immobilized.amountMinor).toBe(300_000);
  });

  it("groups cash, market and term-locked as sellable; illiquid and housing as immobilized", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: {
        cash: 1_000,
        market: 2_000,
        "term-locked": 4_000,
        illiquid: 8_000,
        housing: 16_000,
      },
      debtByTierMinor: {},
    });

    expect(split.sellable.grossMinor).toBe(7_000);
    expect(split.immobilized.grossMinor).toBe(24_000);
    expect(split.sellable.tiers).toEqual(["cash", "market", "term-locked"]);
    expect(split.immobilized.tiers).toEqual(["illiquid", "housing"]);
  });

  it("lists only the tiers that actually carry capital, ladder-ordered", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { "term-locked": 10_556, market: 143_370, housing: 370_000 },
      debtByTierMinor: {},
    });

    expect(split.sellable.tiers).toEqual(["market", "term-locked"]);
    expect(split.immobilized.tiers).toEqual(["housing"]);
  });

  // ── The rule this module exists for: a mortgage cannot eat the market cash.
  it("nets a housing-secured debt inside the immobilized side, leaving the sellable side untouched", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 143_370, "term-locked": 10_556, housing: 370_000 },
      debtByTierMinor: { housing: 68_628 },
    });

    expect(split.sellable.amountMinor).toBe(153_926);
    expect(split.sellable.debtMinor).toBe(0);
    expect(split.immobilized.amountMinor).toBe(301_372);
    expect(split.immobilized.debtMinor).toBe(68_628);
  });

  it("nets an unassociated debt against the sellable side (it lands on the cash rung)", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, housing: 200_000 },
      debtByTierMinor: { cash: 30_000 },
    });

    expect(split.sellable.amountMinor).toBe(70_000);
    expect(split.immobilized.amountMinor).toBe(200_000);
  });

  // ── Underwater: a debt bigger than its own side really does eat the other one.
  it("spills an underwater side onto the other rather than reporting negative capital", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, housing: 50_000 },
      debtByTierMinor: { housing: 80_000 },
    });

    expect(split.immobilized.amountMinor).toBe(0);
    expect(split.sellable.amountMinor).toBe(70_000);
    // The absorbing side records it, so the row can say why it fell short.
    expect(split.sellable.absorbedDebtMinor).toBe(30_000);
    expect(split.immobilized.absorbedDebtMinor).toBe(0);
  });

  it("records the spill the other way round too — an unsecured loan eating the brick", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 20_000, housing: 300_000 },
      debtByTierMinor: { cash: 50_000 },
    });

    expect(split.sellable.amountMinor).toBe(0);
    expect(split.immobilized.amountMinor).toBe(270_000);
    expect(split.immobilized.absorbedDebtMinor).toBe(30_000);
  });

  it("names a rung carrying negative eligible value instead of dropping it", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, illiquid: -20_000, housing: 300_000 },
      debtByTierMinor: {},
    });

    expect(split.immobilized.grossMinor).toBe(280_000);
    expect(split.immobilized.tiers).toEqual(["illiquid", "housing"]);
  });

  it("clamps both sides to zero when the whole scope is underwater", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 50_000 },
      debtByTierMinor: { cash: 200_000 },
    });

    expect(split.sellable.amountMinor).toBe(0);
    expect(split.immobilized.amountMinor).toBe(0);
  });

  // ── Goal reservation: a dated goal is paid by selling, so it comes off the
  //    sellable side first — the split must still add up to what the page shows.
  it("takes the goal reservation off the sellable side first", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, housing: 300_000 },
      debtByTierMinor: {},
      reservedForGoalsMinor: 40_000,
    });

    expect(split.sellable.amountMinor).toBe(60_000);
    expect(split.sellable.reservedMinor).toBe(40_000);
    expect(split.immobilized.amountMinor).toBe(300_000);
    expect(split.immobilized.reservedMinor).toBe(0);
  });

  it("spills a reservation bigger than the sellable side onto the immobilized side", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 20_000, housing: 300_000 },
      debtByTierMinor: {},
      reservedForGoalsMinor: 50_000,
    });

    expect(split.sellable.amountMinor).toBe(0);
    expect(split.sellable.reservedMinor).toBe(20_000);
    expect(split.immobilized.amountMinor).toBe(270_000);
    expect(split.immobilized.reservedMinor).toBe(30_000);
  });

  it("never reserves more than the pool holds", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 20_000 },
      debtByTierMinor: {},
      reservedForGoalsMinor: 999_000,
    });

    expect(split.sellable.amountMinor).toBe(0);
    expect(split.immobilized.amountMinor).toBe(0);
    expect(split.sellable.reservedMinor).toBe(20_000);
  });

  it("is empty-safe", () => {
    const split = splitFireCapital({ eligibleByTierMinor: {}, debtByTierMinor: {} });

    expect(split.sellable).toEqual({
      absorbedDebtMinor: 0,
      amountMinor: 0,
      grossMinor: 0,
      debtMinor: 0,
      reservedMinor: 0,
      tiers: [],
    });
    expect(split.immobilized.tiers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// La declaración del usuario sobre el inmovilizado (#1460): el mismo reparto, con
// una respuesta distinta a «¿qué mide FIRE aquí?».
// ---------------------------------------------------------------------------

describe("splitFireCapital under the immobilized declaration", () => {
  const pool = {
    eligibleByTierMinor: { market: 100_000, housing: 300_000 },
    debtByTierMinor: {},
  };

  it("counts both sides by default, so no stored config changed when the field appeared", () => {
    const split = splitFireCapital(pool);

    expect(split.countsImmobilized).toBe(true);
    expect(split.drawableMinor).toBe(400_000);
  });

  it("draws from the sellable side alone when the brick is declared out", () => {
    const split = splitFireCapital({ ...pool, countsImmobilized: false });

    expect(split.drawableMinor).toBe(100_000);
    // El reparto no cambia: la fila del inmovilizado conserva su cifra para poder
    // imprimirse apagada en vez de desaparecer.
    expect(split.immobilized.amountMinor).toBe(300_000);
  });

  it("clamps a goal reservation to the capital FIRE is actually drawing from", () => {
    const split = splitFireCapital({
      ...pool,
      countsImmobilized: false,
      reservedForGoalsMinor: 250_000,
    });

    expect(split.sellable.reservedMinor).toBe(100_000);
    expect(split.immobilized.reservedMinor).toBe(0);
    expect(split.drawableMinor).toBe(0);
  });

  it("still spills an underwater side's debt onto the other one", () => {
    const split = splitFireCapital({
      eligibleByTierMinor: { market: 100_000, housing: 300_000 },
      debtByTierMinor: { housing: 340_000 },
      countsImmobilized: false,
    });

    expect(split.sellable.absorbedDebtMinor).toBe(40_000);
    expect(split.drawableMinor).toBe(60_000);
  });
});

describe("fireDrawsFromTier", () => {
  it("draws from every rung while the brick counts", () => {
    expect(fireDrawsFromTier("housing", true)).toBe(true);
    expect(fireDrawsFromTier("illiquid", true)).toBe(true);
    expect(fireDrawsFromTier("market", true)).toBe(true);
  });

  it("drops exactly the immobilized rungs when it does not", () => {
    expect(fireDrawsFromTier("housing", false)).toBe(false);
    expect(fireDrawsFromTier("illiquid", false)).toBe(false);
    expect(fireDrawsFromTier("cash", false)).toBe(true);
    expect(fireDrawsFromTier("market", false)).toBe(true);
    expect(fireDrawsFromTier("term-locked", false)).toBe(true);
  });
});
