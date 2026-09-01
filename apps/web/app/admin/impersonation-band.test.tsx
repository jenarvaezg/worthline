import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

let mockPathname: string | null = "/patrimonio";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

import { ImpersonationBand } from "./impersonation-band";

function render(pathname: string | null): string {
  mockPathname = pathname;
  return renderToStaticMarkup(
    <ImpersonationBand email="ana@example.com" stopAction={() => {}} />,
  );
}

describe("ImpersonationBand (#1732)", () => {
  test("on a product route it says whose book is on screen", () => {
    const markup = render("/patrimonio");

    // El email va en negrita: es la palabra sobre la que aterriza la mirada.
    expect(markup).toContain("Viendo como <strong>ana@example.com</strong>");
    expect(markup).toContain("solo lectura");
  });

  test("inside /admin it stops claiming to be the impersonated workspace", () => {
    const markup = render("/admin/catalogo");

    expect(markup).not.toContain("Viendo como");
    expect(markup).toContain("consola de administración");
    expect(markup).toContain("ana@example.com");
  });

  test("the exit control survives the split — every route keeps its way out", () => {
    for (const pathname of ["/admin", "/patrimonio", null]) {
      expect(render(pathname)).toContain("Salir");
    }
  });
});
