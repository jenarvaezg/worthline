import { describe, expect, test } from "vitest";

import { impersonationBandCopy, isAdminConsolePath } from "./impersonation-band-copy";

describe("impersonation band copy (#1732)", () => {
  test("a product route says the admin is viewing the impersonated book", () => {
    const copy = impersonationBandCopy("/patrimonio", "ana@example.com");

    expect(copy.lead).toContain("Viendo como ana@example.com");
    expect(copy.lead).toContain("solo lectura");
  });

  test("the admin console says the screen is NOT the impersonated workspace", () => {
    const copy = impersonationBandCopy("/admin/catalogo", "ana@example.com");

    expect(copy.lead).toContain("ana@example.com");
    expect(copy.lead).toContain("consola de administración");
    expect(copy.lead).not.toContain("Viendo como");
  });

  test.each([
    "/admin",
    "/admin/",
    "/admin/catalogo",
    "/admin/alertas",
  ])("%s is the admin console", (pathname) => {
    expect(isAdminConsolePath(pathname)).toBe(true);
  });

  test.each([
    "/app",
    "/patrimonio",
    "/administracion",
    "/adminis",
    "/",
  ])("%s is not the admin console", (pathname) => {
    expect(isAdminConsolePath(pathname)).toBe(false);
  });
});
