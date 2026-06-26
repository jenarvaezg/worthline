import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import NotFound from "./not-found";

describe("not found page", () => {
  test("keeps users inside the worthline shell with a route back to the dashboard", () => {
    const html = renderToStaticMarkup(<NotFound />);

    expect(html).toContain("worthline");
    expect(html).toContain("No encontramos esta página");
    expect(html).toContain('href="/"');
  });
});
