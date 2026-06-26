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
});
