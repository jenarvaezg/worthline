import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HeroHealthView } from "./hero-data-health";
import HeroDataHealthAlert from "./hero-data-health-alert";

function render(health: HeroHealthView): string {
  return renderToStaticMarkup(<HeroDataHealthAlert health={health} />);
}

describe("HeroDataHealthAlert", () => {
  it("renders no markup at all when clean", () => {
    expect(render({ alerts: [], hiddenCount: 0, impact: "clean" })).toBe("");
  });

  it("renders an assertive alert with explicit text and a fix link for errors", () => {
    const html = render({
      alerts: [
        {
          affectedLabel: "Fondo Índice",
          fixLabel: "Ver activo",
          href: "/patrimonio/h1",
          key: "price_freshness:FAILED_PRICE:h1",
          message: 'El último precio de "Fondo Índice" falló al actualizarse.',
          severity: "high",
        },
      ],
      hiddenCount: 0,
      impact: "error",
    });
    // Role AND label on the SAME element — that pair is what makes the biome
    // suppression in this file a false positive rather than a silenced bug, so
    // assert it on the opening tag, not twice against the whole markup (#1275).
    const alert = /<div[^>]*class="heroHealthAlert[^>]*>/.exec(html)?.[0] ?? "";
    expect(alert).toContain('role="alert"');
    expect(alert).toContain('aria-label="Alerta de salud de datos"');
    expect(html).toContain("heroHealthAlert--error");
    // Explicit text — not colour alone.
    expect(html).toContain("Revisa esto antes de fiarte del número de hoy");
    expect(html).toContain("falló al actualizarse");
    expect(html).toContain('href="/patrimonio/h1"');
    expect(html).toContain("Ver activo");
  });

  it("renders a polite status with quieter copy for warnings", () => {
    const html = render({
      alerts: [
        {
          affectedLabel: "Cuenta",
          fixLabel: "Actualizar valor",
          href: "/patrimonio/actualizar",
          key: "manual_value_freshness:STALE_MANUAL_VALUE:h1",
          message: 'El valor manual de "Cuenta" lleva más de 90 días sin actualizarse.',
          severity: "medium",
        },
      ],
      hiddenCount: 0,
      impact: "warning",
    });
    const status = /<div[^>]*class="heroHealthAlert[^>]*>/.exec(html)?.[0] ?? "";
    expect(status).toContain('role="status"');
    expect(status).toContain('aria-label="Aviso de salud de datos"');
    expect(html).toContain("heroHealthAlert--warning");
    expect(html).toContain("Datos por revisar");
    expect(html).toContain('href="/patrimonio/actualizar"');
  });

  it("summarises overflow beyond the shown alerts", () => {
    const html = render({
      alerts: [
        {
          affectedLabel: undefined,
          fixLabel: undefined,
          href: undefined,
          key: "history_coverage:NO_SNAPSHOTS:sc1",
          message: "Este ámbito no tiene capturas de patrimonio.",
          severity: "medium",
        },
      ],
      hiddenCount: 3,
      impact: "warning",
    });
    expect(html).toContain("3");
    expect(html).toContain("señales más");
  });
});
