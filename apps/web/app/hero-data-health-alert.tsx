import Link from "next/link";

import type { HeroHealthView } from "./hero-data-health";

/**
 * The home hero's ephemeral data-health alert (PRD #654 S3, #665).
 *
 * Renders inside the hero, after the headline deltas and before the breakdown
 * stats, only while active signals affect confidence in today's figure: red and
 * action-forward for errors, quieter gold for stale-but-usable data, and nothing
 * at all when clean (no block, badge, separator, or residual space). It has no
 * dismiss control — the alert disappears only when the cause is resolved or the
 * signal is validly overridden. Server-rendered; the fix links are real anchors,
 * so it is keyboard-operable, and the block is announced to screen readers.
 */
export default function HeroDataHealthAlert({ health }: { health: HeroHealthView }) {
  if (health.impact === "clean") {
    return null;
  }

  const isError = health.impact === "error";

  // The role below IS declared, but as a conditional expression: biome only reads
  // literal role values, so it treats this element as roleless and flags the
  // label (#1275). Both branches — `alert` and `status` — do map an author name,
  // and hero-data-health-alert.test.tsx pins the (role, label) pair for each.
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: false positive — the role is a conditional expression biome cannot evaluate; both `alert` and `status` support aria-label (see the comment above and this file's test).
    <div
      aria-label={isError ? "Alerta de salud de datos" : "Aviso de salud de datos"}
      className={`heroHealthAlert ${isError ? "heroHealthAlert--error" : "heroHealthAlert--warning"}`}
      role={isError ? "alert" : "status"}
    >
      <p className="heroHealthLead">
        {isError ? "Revisa esto antes de fiarte del número de hoy" : "Datos por revisar"}
      </p>
      <ul className="heroHealthList">
        {health.alerts.map((alert) => (
          <li className="heroHealthItem" key={alert.key}>
            <span className="heroHealthMsg">{alert.message}</span>
            {alert.href && alert.fixLabel ? (
              // Fix targets are action links, not hot navigation — no eager
              // prefetch (also keeps the alert off the prefetch path entirely).
              <Link
                className="heroHealthFix"
                href={alert.href}
                prefetch={false}
                scroll={false}
              >
                {alert.fixLabel} →
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
      {health.hiddenCount > 0 ? (
        <p className="heroHealthMore">
          y {health.hiddenCount} {health.hiddenCount === 1 ? "señal más" : "señales más"}{" "}
          de la misma gravedad
        </p>
      ) : null}
    </div>
  );
}
