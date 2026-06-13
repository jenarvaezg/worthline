import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import CompositionRangeControls from "./composition-range-controls";

describe("CompositionRangeControls", () => {
  test("renders a pill per available range and marks the selected one", () => {
    const markup = renderToStaticMarkup(
      <CompositionRangeControls
        options={[
          { href: "/?range=1y#composicion", range: "1y" },
          { href: "/#composicion", range: "all" },
        ]}
        selected="all"
      />,
    );

    expect(markup).toContain("1A");
    expect(markup).toContain("Todo");
    expect(markup).toContain('href="/?range=1y#composicion"');
    // The selected range (Todo) is the active/current pill.
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('class="active"');
  });

  test("hides itself when only one range is available (history under a year)", () => {
    const markup = renderToStaticMarkup(
      <CompositionRangeControls options={[{ href: "/", range: "all" }]} selected="all" />,
    );

    expect(markup).toBe("");
  });
});
