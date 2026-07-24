/**
 * Active-section derivation (#1190): the workspace chrome lives in a shared
 * layout, so the active tab is derived from the URL pathname instead of being
 * threaded as a prop from every page. This pure module owns that mapping; the
 * `SectionNav` client island wires it to `usePathname()`.
 */

export type AppSection = "resumen" | "patrimonio" | "historico" | "objetivos" | "ajustes";

export const NAV_SECTIONS: Array<{ id: AppSection; label: string; href: string }> = [
  { id: "resumen", label: "Resumen", href: "/app" },
  { id: "patrimonio", label: "Patrimonio", href: "/patrimonio" },
  { id: "historico", label: "Histórico", href: "/historico" },
  { id: "objetivos", label: "Objetivos", href: "/objetivos" },
  { id: "ajustes", label: "Ajustes", href: "/ajustes" },
];

/** Match a pathname against a section root: exact, or a `/`-delimited child. */
function isUnder(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/**
 * The section a pathname belongs to, or null when the route is outside the
 * workspace chrome. Nested drilldowns resolve to their parent tab (AC2); the
 * standalone /premium upgrade page stays under Ajustes — its paywall origin.
 */
export function sectionForPath(pathname: string): AppSection | null {
  if (isUnder(pathname, "/app")) return "resumen";
  if (isUnder(pathname, "/patrimonio")) return "patrimonio";
  if (isUnder(pathname, "/historico")) return "historico";
  if (isUnder(pathname, "/objetivos")) return "objetivos";
  if (isUnder(pathname, "/ajustes") || isUnder(pathname, "/premium")) return "ajustes";
  return null;
}
