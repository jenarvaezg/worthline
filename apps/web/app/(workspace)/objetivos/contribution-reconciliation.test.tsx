import type {
  ContributionPlan,
  ContributionReconciliationProjection,
} from "@worthline/domain";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

// useFormStatus() suspends outside a real form-action lifecycle; the labels are
// what these assertions read.
vi.mock("@web/pending-submit", () => ({
  PendingSubmit: ({ children }: { children: ReactNode }) => children,
}));

import { ContributionReconciliation } from "./contribution-reconciliation";

const plan: ContributionPlan = { contributions: [], scopeId: "household" };

function render(projection: ContributionReconciliationProjection): string {
  return renderToStaticMarkup(
    <ContributionReconciliation
      assets={[]}
      currency="EUR"
      currentUrl="/objetivos"
      operations={[]}
      plan={plan}
      projection={projection}
      suggestedPriceByHoldingId={{}}
    />,
  );
}

describe("ContributionReconciliation · progreso cerrado (#1732)", () => {
  test("with nothing closed it says so in words, not with a giant zero", () => {
    const markup = render({ closed: [], pending: [] });

    expect(markup).toContain("Progreso cerrado");
    expect(markup).toContain("Nada cerrado todavía");
    // La cifra a 1,5 rem en mono era el remate visual de un panel sin nada que
    // contar: sin nada cerrado no hay cifra que rematar.
    expect(markup).not.toContain("<strong>0</strong>");
  });
});
