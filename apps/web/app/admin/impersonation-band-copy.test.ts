import { describe, expect, test } from "vitest";

import { impersonationBandCopy, isAdminConsolePath } from "./impersonation-band-copy";

describe("impersonation band copy (#1732)", () => {
  test("a product route says the admin is viewing the impersonated book", () => {
    const { lead, trail } = impersonationBandCopy("/patrimonio");

    expect(lead).toBe("Viendo como ");
    expect(trail).toContain("solo lectura");
  });

  test("the admin console says the screen is NOT the impersonated workspace", () => {
    const { lead, trail } = impersonationBandCopy("/admin/catalogo");

    expect(lead).toContain("Impersonación abierta sobre");
    expect(trail).toContain("consola de administración");
    expect(`${lead}${trail}`).not.toContain("Viendo como");
  });

  test("the email is a slot, never baked into the sentence — the band bolds it", () => {
    for (const pathname of ["/patrimonio", "/admin"]) {
      const { lead, trail } = impersonationBandCopy(pathname);
      expect(`${lead}${trail}`).not.toContain("@");
    }
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
