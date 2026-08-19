"use client";

/**
 * El cockpit FIRE: los supuestos a la izquierda, sus consecuencias a la derecha,
 * y las consecuencias moviéndose mientras se teclea (#1450).
 *
 * Esta isla existe por una sola razón: «editas aquí, ves ahí» no es cierto si hay
 * que guardar y recargar para ver el efecto. El prototipado con el usuario lo midió
 * — subir el ahorro de 1.000 a 2.500 €/mes mueve el titular de 49 a 43 años — y esa
 * conversación es el producto.
 *
 * Lo que NO hace, deliberadamente:
 *
 * - **No reimplementa una fórmula.** Recalcula con `previewFireWithAssumptions`,
 *   `projectFireFromContext` y `fireLevels`, las mismas puertas del motor que
 *   produjeron las cifras del servidor.
 * - **No recalcula el pool.** Los supuestos no cambian lo que tienes: el capital
 *   elegible, el split y la ponderación vienen del servidor y se quedan.
 * - **No toca lo que juzga lo guardado.** El sello de logro (#1449) y el aviso de
 *   ahorro divergente hablan de lo declarado frente a lo medido; mientras hay
 *   cambios sin guardar se atenúan en vez de opinar sobre cifras que aún no existen.
 * - **No sustituye al formulario.** Debajo sigue habiendo un `<form action=…>`
 *   real: sin JavaScript se guarda igual, solo sin previsualización.
 */

import type {
  FireAchievement,
  FireAgeSource,
  FireCoastArrival,
  FireLevel,
  FireProjection,
  FireScopeConfig,
  MonthlySavingsSuggestion,
  SavingsCoherence,
  ScopeFireResult,
} from "@worthline/domain";
import {
  fireCoastArrival,
  fireLevels,
  monthlySavingsCapacityForFire,
  previewFireWithAssumptions,
  projectFireFromContext,
} from "@worthline/domain";
import { useState } from "react";
import {
  type FireAssumptionDraft,
  fireAssumptionOverrides,
  isFireAssumptionDraftDirty,
} from "./fire-assumption-draft";
import { FireConfigPanel } from "./fire-config-panel";
import { FirePanel } from "./fire-panel";

export interface FireCockpitProps {
  achievement: FireAchievement | null;
  ageSource: FireAgeSource | null;
  coastArrival: FireCoastArrival | null;
  coastTickFraction: number | null;
  config: FireScopeConfig | null;
  currency: string;
  currentUrl: string;
  errorMessage: string | null;
  fireLevelRail: FireLevel[] | null;
  fireProjection: FireProjection | null;
  fireResult: ScopeFireResult | null;
  privacyMode: boolean;
  /** El borrador inicial: exactamente lo guardado, tal como lo pinta el formulario. */
  savedDraft: FireAssumptionDraft;
  savingsCoherence: SavingsCoherence | null;
  savingsSuggestion: MonthlySavingsSuggestion;
  scopeId: string | null;
  seededFromPlan: boolean;
}

/** El tick de Coast en la barra: la misma fracción que calcula el servidor. */
function coastTickOf(result: ScopeFireResult): number | null {
  return result.coastFireRequired && result.fireNumber.amountMinor > 0
    ? Math.min(1, result.coastFireRequired.amountMinor / result.fireNumber.amountMinor)
    : null;
}

export function FireCockpit(props: FireCockpitProps) {
  const [draft, setDraft] = useState(props.savedDraft);
  const dirty = isFireAssumptionDraftDirty(draft, props.savedDraft);

  // Sin cambios se enseña lo que mandó el servidor, sin recalcular nada: la primera
  // pintura es la RSC auditable de #1426, no una versión de cliente parecida.
  const previewing = dirty && props.fireResult !== null;
  const result =
    previewing && props.fireResult
      ? previewFireWithAssumptions(props.fireResult, fireAssumptionOverrides(draft))
      : props.fireResult;
  const projection =
    previewing && result
      ? projectFireFromContext(result.context, {
          monthlyContributionMinor: monthlySavingsCapacityForFire(result.context.config),
        })
      : props.fireProjection;
  const levelRail =
    previewing && result ? fireLevels({ context: result.context }) : props.fireLevelRail;
  const coastTick = previewing && result ? coastTickOf(result) : props.coastTickFraction;
  // La edad de llegada a Coast se mueve con el ahorro y con la edad objetivo (#1425),
  // así que se recalcula por la misma puerta que el servidor: subir el ahorro tiene que
  // adelantar esa fecha mientras se teclea, no al guardar.
  const coastArrival =
    previewing && result ? fireCoastArrival(result.context) : props.coastArrival;

  return (
    <div className="objetivosCockpit">
      <FireConfigPanel
        ageSource={props.ageSource}
        config={props.config}
        currency={props.currency}
        currentUrl={props.currentUrl}
        draft={draft}
        errorMessage={props.errorMessage}
        onDraftChange={setDraft}
        previewing={previewing}
        privacyMode={props.privacyMode}
        realReturnUsed={props.fireResult?.context.realReturnUsed ?? null}
        savingsSuggestion={props.savingsSuggestion}
        scopeId={props.scopeId}
        seededFromPlan={props.seededFromPlan}
      />

      {/* La estrella FIRE (#1426), con las cifras que el borrador implica. */}
      <FirePanel
        achievement={props.achievement}
        ageSource={props.ageSource}
        coastArrival={coastArrival}
        coastTickFraction={coastTick}
        currency={props.currency}
        fireLevelRail={levelRail}
        fireProjection={projection}
        fireResult={result}
        previewing={previewing}
        privacyMode={props.privacyMode}
        savingsCoherence={props.savingsCoherence}
      />
    </div>
  );
}
