import { describe, expect, test } from "vitest";

import { DEMO_PERSONA_COOKIE_NAME } from "@web/demo/demo-context";
import { SCOPE_COOKIE_NAME } from "@web/intake";

import { POST } from "./route";

function exitRequest(): ReturnType<typeof POST> {
  return POST();
}

describe("POST /demo/exit", () => {
  test("clears the persona and scope cookies and redirects to /login", async () => {
    const response = await exitRequest();

    expect(response.status).toBe(303);
    // A RELATIVE Location so the Set-Cookie deletions reach the host the browser
    // is on — an absolute redirect can switch host and drop them (see persona route).
    expect(response.headers.get("location")).toBe("/login");
    expect(response.cookies.get(DEMO_PERSONA_COOKIE_NAME)?.value).toBe("");
    expect(response.cookies.get(SCOPE_COOKIE_NAME)?.value).toBe("");
  });

  test("expires both cookies (epoch Expires) rather than just blanking them", async () => {
    const response = await exitRequest();
    const setCookie = response.headers.getSetCookie();

    const personaCookie = setCookie.find((c) =>
      c.startsWith(`${DEMO_PERSONA_COOKIE_NAME}=`),
    );
    const scopeCookie = setCookie.find((c) => c.startsWith(`${SCOPE_COOKIE_NAME}=`));
    expect(personaCookie).toMatch(/Expires=Thu, 01 Jan 1970/i);
    expect(scopeCookie).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });
});
