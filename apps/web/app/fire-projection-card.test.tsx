import type { FireProjection } from "@worthline/domain";
import { formatMoneyMinorPrivacy, projectFireFromContext } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import FireProjectionCard from "./fire-projection-card";

const euros = (amountMinor: number) =>
  formatMoneyMinorPrivacy({ amountMinor, currency: "EUR" }, false);

/** A modest scope that reaches its target in a handful of years. */
function projection(): FireProjection {
  return projectFireFromContext(
    {
      config: {
        currentAge: 63,
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.035,
        targetRetirementAge: 67,
      },
      currency: "EUR",
      effectiveRealReturn: 0.05,
      eligibleGrossMinor: 600_000_00,
      eligibleMinor: 600_000_00,
      fireNumberMinor: 685_714_29,
      realReturnUsed: 0.05,
    },
    { monthlyContributionMinor: 100_000 },
  );
}

describe("FireProjectionCard (#1426)", () => {
  test("names the dashed line instead of leaving it to be guessed", () => {
    const html = renderToStaticMarkup(
      <FireProjectionCard formatMoney={euros} projection={projection()} />,
    );

    expect(html).toContain(`Objetivo FIRE · ${euros(685_714_29)}`);
  });

  test("gives every bar its year and its figure on hover", () => {
    const chart = projection();

    const html = renderToStaticMarkup(
      <FireProjectionCard currentAge={63} formatMoney={euros} projection={chart} />,
    );

    const base = chart.scenarios.find((scenario) => scenario.label === "base")!;
    const secondYear = base.trajectory[1]!;
    expect(html).toContain(
      `<title>Año ${secondYear.year} · a los ${63 + secondYear.year} · ${euros(
        secondYear.eligibleMinor,
      )}</title>`,
    );
    // Year 0 is today, not «Año 0», and it carries no age it did not reach.
    expect(html).toContain(`<title>Hoy · a los 63 · ${euros(600_000_00)}</title>`);
  });

  test("leaves the age out of the hover label when none is configured", () => {
    const html = renderToStaticMarkup(
      <FireProjectionCard formatMoney={euros} projection={projection()} />,
    );

    expect(html).toContain(`<title>Hoy · ${euros(600_000_00)}</title>`);
  });
});
