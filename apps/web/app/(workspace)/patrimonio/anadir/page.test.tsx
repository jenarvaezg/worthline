/**
 * Wiring test for the add-holding wizard's "Importar extracto" entry point
 * (PRD #669 S3, #674, ADR 0055): inside the investment drawer's "Tengo el
 * extracto del bróker" pane, a link reaches the account-level import route —
 * the same preview/confirm flow the portfolio-level entry point uses, not a
 * copy. It appears only for the "Cotiza en bolsa" (fund) group, since the
 * multi-ISIN engine creates fund investments; the per-holding single-fund path
 * in that same pane (#176's "Cargar movimientos") is unchanged.
 */

import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  readAssets: vi.fn(async () => []),
  readLiabilities: vi.fn(async () => []),
  readWorkspace: vi.fn(async () => ({
    baseCurrency: "EUR",
    groups: [],
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  })),
  resolvePageShell: vi.fn(async () => {
    const scopes = [{ id: "household", label: "Hogar", type: "household" }];
    return {
      persistence: {
        checkedAt: "2026-06-27T00:00:00.000Z",
        checkKey: "bootstrap.last_healthcheck_at",
        checkValue: "2026-06-27T00:00:00.000Z",
        databasePath: ":memory:",
        displayPath: ":memory:",
        status: "ok",
      },
      privacyMode: false,
      requestedScopeId: undefined,
      scopes,
      selectedScope: scopes[0],
      store: {
        assets: { readAssets: calls.readAssets },
        liabilities: { readLiabilities: calls.readLiabilities },
      },
      target: { kind: "local" },
      workspace: await calls.readWorkspace(),
    };
  }),
}));

vi.mock("@web/page-shell", () => ({
  resolvePageShell: calls.resolvePageShell,
}));

// Default undefined = live; the demo-visibility test flips it (ADR 0030's
// persona cookie is how a request reads as demo).
let mockPersonaCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

afterEach(() => {
  mockPersonaCookie = undefined;
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

// PendingSubmit's useFormStatus() also suspends outside a real form-action
// lifecycle; irrelevant to the link being tested.
vi.mock("@web/pending-submit", () => ({
  PendingSubmit: ({ children }: { children: ReactNode }) => children,
}));

// SymbolSearch is an async server component rendered inline (no await by the
// caller); react-dom/server's static renderer suspends on it outside a real
// RSC pipeline. It renders per investment group and is irrelevant here.
vi.mock("@web/patrimonio/anadir/symbol-search", () => ({
  default: () => null,
}));

import { AnadirHoldingContent } from "./page";

async function renderedHtml(searchParams: Record<string, string> = {}): Promise<string> {
  const element = (await AnadirHoldingContent({
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('"Importar extracto" wizard entry point (S3, #674)', () => {
  test("the investment import pane links to the account-level import flow", async () => {
    const html = await renderedHtml();

    expect(html).toContain('href="/patrimonio/importar-extracto"');
    expect(html).toContain("Importar extracto de toda la cartera");
    // The unchanged one-fund case still routes through "Cargar movimientos".
    expect(html).toContain("Cargar movimientos");
  });

  test("the account-import link appears exactly once — only under the fund group, not pension_plan/crypto", async () => {
    const html = await renderedHtml();
    const occurrences = html.split('href="/patrimonio/importar-extracto"').length - 1;
    expect(occurrences).toBe(1);
  });

  test("stays visible in demo mode — the write-guard lives downstream on the import flow, not on the entry point", async () => {
    mockPersonaCookie = "familia";
    const html = await renderedHtml();

    expect(html).toContain('href="/patrimonio/importar-extracto"');
  });
});

describe("the ISIN is asked for, never left empty in silence (#1489)", () => {
  function isinInputs(html: string): string[] {
    return (html.match(/<input[^>]*name="isin_[a-z_]+"[^>]*>/g) ?? []).filter(Boolean);
  }

  test("the groups that HAVE an ISIN carry a visible field for it", async () => {
    const inputs = isinInputs(await renderedHtml());

    // fund and pension_plan — never hidden: a field the user never sees is how a
    // position was created without an ISIN and became an orphan for the statement
    // merge, the exposure catalog, and the assistant.
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input, input).not.toContain('type="hidden"');
    }
    expect(inputs.join()).toContain('name="isin_fund"');
    expect(inputs.join()).toContain('name="isin_pension_plan"');
  });

  test("crypto is not asked for an ISIN it cannot have", async () => {
    expect(isinInputs(await renderedHtml()).join()).not.toContain("isin_crypto");
  });

  test("the field says what the ISIN is FOR, not just its name", async () => {
    const html = await renderedHtml();

    expect(html).toContain("ISIN");
    // The reason it matters, in the user's words: it is what lets a statement find
    // this position later.
    expect(html).toContain("un extracto de tu bróker reconoce");
  });
});

describe("vivienda-habitual default — single primary residence", () => {
  function inmuebleCheckbox(html: string): string {
    const checkbox = html
      .match(/<input[^>]*type="checkbox"[^>]*>/g)
      ?.find((tag) => tag.includes("primaryResidence_inmueble"));
    expect(checkbox).toBeDefined();
    return checkbox!;
  }

  test("defaults UNCHECKED when the workspace already has a primary residence", async () => {
    calls.readAssets.mockResolvedValueOnce([
      {
        currency: "EUR",
        currentValue: { amountMinor: 30_000_000, currency: "EUR" },
        id: "casa",
        isPrimaryResidence: true,
        liquidityTier: "illiquid",
        name: "Casa",
        ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
        type: "real_estate",
      },
    ] as never);

    expect(inmuebleCheckbox(await renderedHtml())).not.toContain("checked");
  });

  test("defaults CHECKED for the first property", async () => {
    expect(inmuebleCheckbox(await renderedHtml())).toContain("checked");
  });
});

describe("the alta's acquisition-date question on the success loop (#1561)", () => {
  test("the aviso rides its own band, not the green heading", async () => {
    const html = await renderedHtml({
      deudaDesde: "2004-05-19",
      ok: "asset_added_acquisition_today",
    });

    // The alta is still confirmed as an alta…
    expect(html).toContain("Activo añadido.");
    // …and the question sits in an aviso band that names the debt's start date.
    expect(html).toContain("warningBand addSuccessNotice");
    expect(html).toContain("19/05/2004");
  });

  test("a plain alta shows no aviso band", async () => {
    const html = await renderedHtml({ ok: "asset_added" });

    expect(html).toContain("Activo añadido.");
    expect(html).not.toContain("addSuccessNotice");
  });
});

describe("orientación del alta (#1732)", () => {
  test("numbers the wizard's stretches, counting only the ones this workspace shows", async () => {
    // Un solo miembro: el reparto no se pinta, así que el alta tiene DOS tramos
    // y anunciar «de 3» contaría un paso que nadie va a ver.
    const html = await renderedHtml();

    expect(html).toContain("Paso 1 de 2 · Elige el cajón");
    expect(html).toContain("Paso 2 de 2 · Rellena lo justo");
    expect(html).not.toContain("de 3");
  });

  test("with more than one member the reparto is the third stretch", async () => {
    calls.readWorkspace.mockResolvedValueOnce({
      baseCurrency: "EUR",
      groups: [],
      members: [
        { id: "member_jose", name: "Jose" },
        { id: "member_ana", name: "Ana" },
      ],
      mode: "household",
    });

    const html = await renderedHtml();

    expect(html).toContain("Paso 1 de 3 · Elige el cajón");
    expect(html).toContain("Paso 3 de 3 · Reparto");
  });

  test("«Modo avanzado» says what it leads to", async () => {
    const html = await renderedHtml();

    expect(html).toContain("Modo avanzado");
    expect(html).toContain("Todos los instrumentos y campos técnicos");
  });
});
