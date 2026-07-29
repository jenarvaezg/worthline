/**
 * Loading skeletons must announce what is loading (#1275).
 *
 * A bare <div> carries the implicit `generic` role, and the spec maps no author
 * name onto `generic`: an `aria-label` there is dropped on the floor, so the
 * skeleton had no accessible name at all even though the label was written on
 * purpose. `status` is the role these frames already behave as (a polite live
 * region), and it does take an author name.
 *
 * Scope: the five workspace-tab shells. Sub-route skeletons stay `region`.
 */

import AjustesSkeleton from "@web/ajustes/ajustes-skeleton";
import HistoricoSkeleton from "@web/historico/historico-skeleton";
import ObjetivosSkeleton from "@web/objetivos/objetivos-skeleton";
import PatrimonioSkeleton from "@web/patrimonio/patrimonio-skeleton";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import DashboardSkeleton from "./dashboard-skeleton";

function expectAnnouncedAs(element: ReactElement, label: string) {
  const markup = renderToStaticMarkup(element);
  const root = /^<[a-z]+[^>]*>/.exec(markup)?.[0] ?? "";

  expect(root).toContain('role="status"');
  expect(root).toContain('aria-busy="true"');
  expect(root).toContain(`aria-label="${label}"`);
}

describe("loading skeletons", () => {
  test("the dashboard skeleton is a named status region", () => {
    expectAnnouncedAs(<DashboardSkeleton />, "Cargando panel de resumen");
  });

  test("the patrimonio skeleton is a named status region", () => {
    expectAnnouncedAs(<PatrimonioSkeleton />, "Cargando patrimonio");
  });

  test("the objetivos skeleton is a named status region", () => {
    expectAnnouncedAs(<ObjetivosSkeleton />, "Cargando objetivos");
  });

  test("the ajustes skeleton is a named status region", () => {
    expectAnnouncedAs(<AjustesSkeleton />, "Cargando ajustes");
  });

  // This one was a <section>, i.e. a `region` landmark once named — announced,
  // but the wrong shape for a transient frame and the odd tab out.
  test("the historico skeleton is a named status region too", () => {
    expectAnnouncedAs(<HistoricoSkeleton />, "Cargando histórico");
  });
});
