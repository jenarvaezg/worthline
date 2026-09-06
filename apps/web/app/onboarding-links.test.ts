/**
 * Destinos del checklist de primeros pasos (#1702).
 *
 * El defecto no fue un enlace feo, fue un enlace que expulsa: `snapshot`
 * apuntaba a `/`, y desde que `/` es el landing público en vez de un redirect a
 * `/app`, pulsarlo saca al usuario recién registrado de la aplicación y lo deja
 * en el marketing. El fallback `?? "/"` abría el mismo agujero para cualquier
 * paso futuro sin entrada en el mapa.
 *
 * De ahí las dos reglas que este fichero fija: el mapa cubre exactamente los
 * pasos que el dominio produce (no hay fallback al que caer), y cada destino
 * resuelve a una página real bajo `app/(workspace)` — el área autenticada.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deriveOnboardingProgress } from "@worthline/domain";
import { describe, expect, it } from "vitest";
import { ONBOARDING_LINKS } from "./onboarding-links";

const workspaceDirectory = join(import.meta.dirname, "(workspace)");

/** Los cuatro pasos, pendientes: es cuando el checklist los pinta como acción. */
const steps = deriveOnboardingProgress({
  activeMemberCount: 0,
  holdingCount: 0,
  hasFireConfig: false,
  snapshotCount: 0,
});

describe("ONBOARDING_LINKS", () => {
  it("da destino a cada paso que el dominio produce, y a ninguno más", () => {
    const stepIds = steps.map((step) => step.id);
    expect(stepIds).toEqual(["members", "holdings", "fire", "snapshot"]);
    expect(Object.keys(ONBOARDING_LINKS).sort()).toEqual([...stepIds].sort());
  });

  it("nunca manda a `/`: es el landing público, no la app", () => {
    for (const href of Object.values(ONBOARDING_LINKS)) {
      expect(href).not.toBe("/");
    }
  });

  it("resuelve cada destino a una página real del área autenticada", () => {
    for (const [id, href] of Object.entries(ONBOARDING_LINKS)) {
      if (href === null) continue;
      const pathname = href.split("#")[0] ?? "";
      const segments = pathname.split("/").filter(Boolean);
      expect(segments.length, `${id} apunta a la raíz`).toBeGreaterThan(0);
      const page = join(workspaceDirectory, ...segments, "page");
      const exists = existsSync(`${page}.tsx`) || existsSync(`${page}.ts`);
      expect(exists, `${id} → ${href} no tiene página (${page}.tsx)`).toBe(true);
    }
  });

  it("aterriza en el ancla que promete, no arriba de la página", () => {
    // Un fragmento que ya no existe no rompe la navegación: la degrada en
    // silencio, que es peor. El `id` puede mudarse de fichero, así que se busca
    // por toda la app y no en la página concreta.
    for (const href of Object.values(ONBOARDING_LINKS)) {
      const fragment = href?.split("#")[1];
      if (fragment === undefined) continue;
      const found = execFileSync(
        "grep",
        ["-rl", `id="${fragment}"`, "--include=*.tsx", import.meta.dirname],
        { encoding: "utf8" },
      );
      expect(found.trim(), `nadie declara id="${fragment}"`).not.toBe("");
    }
  });
});
