import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { NavPendingIndicator } from "./view-transition-link";

/**
 * Topbar loading feedback (#607). The pure indicator that `useLinkStatus()`
 * feeds: a section link must paint an in-flight marker the moment a (slow)
 * navigation is pending, and nothing once it has settled. Kept as a pure
 * `{ pending }` component (interaction-patterns: logic in testable modules) so
 * the wiring hook stays a thin shell.
 */
describe("NavPendingIndicator (#607)", () => {
  test("renders an aria-hidden indicator while the navigation is pending", () => {
    const html = renderToStaticMarkup(<NavPendingIndicator pending={true} />);
    expect(html).toContain("navPending");
    expect(html).toContain('aria-hidden="true"');
  });

  test("renders nothing once the navigation has settled", () => {
    expect(renderToStaticMarkup(<NavPendingIndicator pending={false} />)).toBe("");
  });
});
