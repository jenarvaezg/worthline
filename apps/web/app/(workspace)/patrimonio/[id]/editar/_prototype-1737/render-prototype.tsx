/**
 * PROTOTIPO #1737 — desechable. Lo único que la página real llama: carga las
 * piezas y monta la isla con la variante pedida. La página solo entra aquí en
 * desarrollo, para una inversión, con `?variante=` (`prototypeVariantFor`).
 */

import type { AssetFamilyContext } from "@web/patrimonio/[id]/editar/_families/family-contract";
import type { WarningOverride } from "@worthline/domain";
import type { ReactNode } from "react";
import FichaPrototype from "./ficha-prototype";
import { loadPrototypeFicha } from "./load-prototype-ficha";
import { initialFichaState, type VariantKey } from "./prototype-model";

export async function renderFichaPrototype(input: {
  ctx: AssetFamilyContext;
  variant: VariantKey;
  searchParams: Record<string, string | string[] | undefined> | undefined;
  boardHref: string;
  warnings: ReactNode;
  basics: ReactNode;
  availability: ReactNode;
  danger: ReactNode;
  overrides: WarningOverride[];
}) {
  const parts = await loadPrototypeFicha(input.ctx, {
    availability: input.availability,
    basics: input.basics,
    danger: input.danger,
    overrides: input.overrides,
  });
  const { action, tab } = initialFichaState(input.searchParams);

  return (
    <FichaPrototype
      boardHref={input.boardHref}
      extras={parts.extras}
      figures={parts.figures}
      forms={parts.forms}
      initialAction={action}
      initialTab={tab}
      initialVariant={input.variant}
      operationCount={parts.operationCount}
      refresh={parts.refresh}
      tabs={parts.tabs}
      warnings={input.warnings}
    />
  );
}
