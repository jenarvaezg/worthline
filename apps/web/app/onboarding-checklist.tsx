import type { OnboardingStep } from "@worthline/domain";
import Link from "next/link";
import { ONBOARDING_LINKS } from "./onboarding-links";

/**
 * The first-run checklist on the home dashboard: the four first steps, each
 * either done, pressable, or plain information.
 *
 * Pure and self-contained — it decides its own visibility — so the destinations
 * can be asserted against real markup instead of against the map they come
 * from (#1702). Nothing here is client-side: a step is a link or it is text.
 */
export default function OnboardingChecklist({
  onboarding,
}: {
  onboarding: OnboardingStep[];
}) {
  // The checklist is guidance for a workspace still being set up: once every
  // step is done it disappears rather than becoming a wall of ticks.
  if (!onboarding.some((step) => !step.done)) return null;

  return (
    <section className="onboardingChecklist section" aria-label="Primeros pasos">
      <div className="panelHeader">
        <h2>Primeros pasos</h2>
        <span>Empieza aquí</span>
      </div>
      <ol>
        {onboarding.map((step) => {
          const href = ONBOARDING_LINKS[step.id];
          return (
            <li className={step.done ? "done" : undefined} key={step.id}>
              {step.done ? (
                <span>✓ {step.label}</span>
              ) : href ? (
                <Link href={href}>○ {step.label}</Link>
              ) : (
                // Pendiente pero sin nada que pulsar: se marca como tal para no
                // ser el ítem más prominente de una lista de acciones.
                <span className="info">○ {step.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
