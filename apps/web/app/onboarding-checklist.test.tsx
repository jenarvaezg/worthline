/**
 * Cableado del checklist de primeros pasos (#1702).
 *
 * El defecto no fue un enlace feo, fue un enlace que expulsa: el paso
 * «snapshot» apuntaba a `/`, y desde que `/` es el landing público en vez de un
 * redirect a `/app`, pulsarlo saca de la aplicación justo al usuario al que el
 * checklist acompaña — solo se muestra mientras el onboarding está incompleto.
 * El fallback `?? "/"` abría el mismo agujero para cualquier paso futuro.
 *
 * Por eso las aserciones caen sobre el HTML que sale del componente y no sobre
 * el mapa de destinos: un literal reintroducido en el render, o un fallback
 * nuevo, tiene que romper algo. `onboarding-links.test.ts` cubre el mapa.
 */
import { deriveOnboardingProgress } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import OnboardingChecklist from "./onboarding-checklist";

/** Un workspace recién provisionado: los cuatro pasos pendientes. */
const brandNew = deriveOnboardingProgress({
  activeMemberCount: 0,
  holdingCount: 0,
  hasFireConfig: false,
  snapshotCount: 0,
});

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("OnboardingChecklist (#1702)", () => {
  test("ningún paso enlaza fuera del área autenticada", () => {
    const hrefs = hrefsOf(
      renderToStaticMarkup(<OnboardingChecklist onboarding={brandNew} />),
    );

    expect(hrefs).not.toContain("/");
    for (const href of hrefs) {
      expect(href.startsWith("/")).toBe(true);
    }
  });

  test("manda cada paso accionable a su pantalla", () => {
    const hrefs = hrefsOf(
      renderToStaticMarkup(<OnboardingChecklist onboarding={brandNew} />),
    );

    expect(hrefs).toEqual(["/ajustes", "/patrimonio/anadir", "/objetivos#supuestos"]);
  });

  test("el paso informativo se pinta como texto marcado, no como enlace", () => {
    const html = renderToStaticMarkup(<OnboardingChecklist onboarding={brandNew} />);

    expect(html).toContain("Tu primer snapshot se captura automáticamente");
    // Sale del `<span class="info">`, nunca de un `<a>`: no hay nada que pulsar.
    expect(html).toMatch(
      /<span class="info">○ Tu primer snapshot se captura automáticamente<\/span>/,
    );
  });

  test("un paso completado no enlaza a ninguna parte", () => {
    const withMembers = deriveOnboardingProgress({
      activeMemberCount: 2,
      holdingCount: 0,
      hasFireConfig: false,
      snapshotCount: 0,
    });

    const hrefs = hrefsOf(
      renderToStaticMarkup(<OnboardingChecklist onboarding={withMembers} />),
    );

    expect(hrefs).not.toContain("/ajustes");
    expect(hrefs).toEqual(["/patrimonio/anadir", "/objetivos#supuestos"]);
  });

  test("desaparece cuando ya no queda ningún paso pendiente", () => {
    const done = deriveOnboardingProgress({
      activeMemberCount: 2,
      holdingCount: 3,
      hasFireConfig: true,
      snapshotCount: 1,
    });

    expect(renderToStaticMarkup(<OnboardingChecklist onboarding={done} />)).toBe("");
  });
});
