/**
 * The local-mode capture control on /historico — the RENDER gate.
 *
 * `local-capture.test.ts` pins the rule and `capture-snapshot-action.test.ts`
 * pins the write it guards; this pins the middle: that the button's VISIBILITY is
 * driven by the same rule, so a hosted deploy ships no control to click and a
 * local one does. A control that renders unconditionally would be a dead button
 * that 403s; one that never renders would make the action unreachable.
 *
 * Also pins the empty-state copy, because it is the sentence a local developer
 * actually reads on arrival: the hosted wording promises the histórico "se
 * acumula solo", which is the twice-daily cron — the very thing local mode does
 * not have. A local reader must be pointed at the button instead.
 *
 * Store reads are stubbed (this page reads seven surfaces before it renders);
 * `resolvePageShell` is mocked whole, since `target` is the input under test.
 */

import type { StoreTarget } from "@web/store-resolver";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

const HOSTED: StoreTarget = {
  kind: "authenticated",
  dbUrl: "libsql://example.turso.io",
  token: "jwt",
  workspaceId: "ws_1",
};

const calls = vi.hoisted(() => ({
  resolvePageShell: vi.fn(),
}));

vi.mock("@web/page-shell", () => ({ resolvePageShell: calls.resolvePageShell }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

import { HistoricoContent } from "./page";

const SCOPES = [{ id: "household", label: "Hogar", type: "household" } as const];

/** A shell whose only moving part is the store target the button keys off. */
function shellFor(target: StoreTarget) {
  return {
    persistence: {
      status: "ok",
      checkKey: "bootstrap.last_healthcheck_at",
      checkedAt: "2026-06-18T10:00:00.000Z",
      checkValue: "2026-06-18T10:00:00.000Z",
      databasePath: ":memory:",
      displayPath: ":memory:",
    },
    privacyMode: false,
    requestedScopeId: undefined,
    scopes: SCOPES,
    selectedScope: SCOPES[0],
    store: {
      assets: { readAssets: async () => [] },
      liabilities: {
        readDebtModel: async () => null,
        readLiabilities: async () => [],
      },
      payouts: {
        readPayoutSchedules: async () => [],
        readPayouts: async () => [],
      },
      snapshots: {
        buildProjectionContext: async () => ({ operationsByAsset: new Map() }),
        readSnapshotHoldings: async () => [],
        readSnapshots: async () => [],
      },
    },
    target,
    workspace: {
      baseCurrency: "EUR",
      groups: [],
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    },
  };
}

async function render(target: StoreTarget, searchParams = {}): Promise<string> {
  calls.resolvePageShell.mockResolvedValueOnce(shellFor(target));
  return renderToStaticMarkup(
    await HistoricoContent({ searchParams: Promise.resolve(searchParams) }),
  );
}

describe("el botón de captura solo existe en modo local", () => {
  test("con el store local aparece, junto al contador de capturas", async () => {
    const html = await render({ kind: "local" });

    expect(html).toContain("Capturar hoy");
    expect(html).toContain('name="currentUrl"');
    expect(html).toContain("0 capturas");
  });

  test("el opt-in al rechazo en línea no viaja en el HTML", async () => {
    const html = await render({ kind: "local" });

    // `inlineError=1` se estampa en el handler del submit, nunca en el HTML
    // renderizado: un formulario enviado sin JS no puede llevarlo, y ese es el
    // único que sabe pintar el terminal por redirección. Si apareciera aquí, un
    // post sin JS pediría un estado que su respuesta no puede traerle.
    expect(html).not.toContain("inlineError");
  });

  test("con un workspace alojado no aparece nada que pulsar", async () => {
    const html = await render(HOSTED);

    expect(html).not.toContain("Capturar hoy");
    expect(html).not.toContain('name="currentUrl"');
  });

  test("tampoco en la demo, que además es de solo lectura", async () => {
    const html = await render({
      kind: "demo",
      persona: "joven",
      now: "2026-06-18T10:00:00.000Z",
    });

    expect(html).not.toContain("Capturar hoy");
  });
});

describe("el estado vacío no promete una captura programada que no existe", () => {
  test("en local, el texto señala el botón en vez del cron", async () => {
    const html = await render({ kind: "local" });

    expect(html).not.toContain("El histórico se acumula solo");
    expect(html).toContain("no hay captura programada");
    expect(html).toContain("Capturar hoy");
  });

  test("alojado, el texto sigue siendo el de siempre", async () => {
    // The "it accumulates by itself" wording is the `range=all` branch; the
    // default window gets the shorter "no captures in this period" line.
    expect(await render(HOSTED, { range: "all" })).toContain(
      "El histórico se acumula solo",
    );
    expect(await render(HOSTED)).toContain("No hay capturas en este periodo");
  });
});
