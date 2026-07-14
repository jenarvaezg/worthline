import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import ErrorPage from "./error";

describe("error boundary page", () => {
  test("shows a worthline-styled recovery path when a route fails", () => {
    const html = renderToStaticMarkup(
      <ErrorPage error={new Error("boom")} unstable_retry={() => {}} />,
    );

    expect(html).toContain("worthline");
    expect(html).toContain("No pudimos cargar esta vista");
    expect(html).toContain("Reintentar");
  });

  test("stays on the paper register: a system error band, not the panel card (#910)", () => {
    const html = renderToStaticMarkup(
      <ErrorPage error={new Error("boom")} unstable_retry={() => {}} />,
    );

    // The recovery block is a paper section with the red system band, and the
    // fault is announced to assistive tech.
    expect(html).toContain("errorRecovery");
    expect(html).toContain("errorBand");
    expect(html).toContain('role="alert"');
    // Never the summary-panel card.
    expect(html).not.toContain("summaryBand");
  });
});
