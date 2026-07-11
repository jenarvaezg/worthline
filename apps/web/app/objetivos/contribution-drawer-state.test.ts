import { describe, expect, it } from "vitest";

import { contributionDrawerUrl } from "./contribution-drawer-state";

describe("contributionDrawerUrl", () => {
  it("mirrors drawer state while preserving the rest of the URL", () => {
    expect(contributionDrawerUrl("/objetivos?scope=m1", "plan:2026-07-01")).toBe(
      "/objetivos?scope=m1&reconcile=plan%3A2026-07-01#contributionDrawer",
    );
    expect(
      contributionDrawerUrl(
        "/objetivos?scope=m1&reconcile=plan%3A2026-07-01#contributionDrawer",
        null,
      ),
    ).toBe("/objetivos?scope=m1");
  });
});
