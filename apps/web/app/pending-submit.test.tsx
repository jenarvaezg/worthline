import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { PendingSubmit } from "./pending-submit";

/**
 * #607: the scope tabs reuse PendingSubmit but must NOT relabel on submit (a
 * scope tab keeps its name, just disables + aria-busy). So `pendingLabel` is
 * optional — when omitted the button keeps its children in every state.
 */
describe("PendingSubmit (#607)", () => {
  test("renders a submit button with its children and className when pendingLabel is omitted", () => {
    const html = renderToStaticMarkup(
      <PendingSubmit className="scopeTabBtn active">Jose</PendingSubmit>,
    );
    expect(html).toContain('type="submit"');
    expect(html).toContain("scopeTabBtn active");
    expect(html).toContain("Jose");
  });
});
