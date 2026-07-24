/**
 * Structured screen context the assistant layer hands the chat route (#629,
 * shape decided in S0 #628). Pure derivation from pathname + query string so
 * it unit-tests in the node env; the client island recomputes it on every
 * navigation. The server adds what the client cannot read (scope, clock).
 */

export type ScreenSection =
  | "resumen"
  | "patrimonio"
  | "historico"
  | "objetivos"
  | "ajustes"
  | "otra";

export interface ScreenContext {
  /** Current pathname, verbatim. */
  route: string;
  /** Top-level product section derived from the route. */
  section: ScreenSection;
  /** Holding id when the route is a /patrimonio/[id] drilldown. */
  holdingId: string | null;
  /** Ephemeral view state mirrored in the URL (framing/range/lens…). */
  view: Record<string, string>;
}

const ALL_SECTIONS: readonly ScreenSection[] = [
  "resumen",
  "patrimonio",
  "historico",
  "objetivos",
  "ajustes",
  "otra",
];

/**
 * Boundary guard for the untrusted screenContext the chat route receives.
 * Size bounds matter: the object is embedded verbatim in the system prompt,
 * so an unbounded `view` would be a token-cost amplifier on the shared key.
 */
const MAX_VIEW_ENTRIES = 8;
const MAX_VIEW_STRING = 128;

export function isScreenContext(value: unknown): value is ScreenContext {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  const view = v["view"];
  const viewOk =
    view !== null &&
    typeof view === "object" &&
    Object.entries(view as object).length <= MAX_VIEW_ENTRIES &&
    Object.entries(view as object).every(
      ([key, val]) =>
        key.length <= MAX_VIEW_STRING &&
        typeof val === "string" &&
        val.length <= MAX_VIEW_STRING,
    );

  return (
    typeof v["route"] === "string" &&
    v["route"].length <= 512 &&
    ALL_SECTIONS.includes(v["section"] as ScreenSection) &&
    (v["holdingId"] === null ||
      (typeof v["holdingId"] === "string" && v["holdingId"].length <= MAX_VIEW_STRING)) &&
    viewOk
  );
}

const SECTIONS = ["patrimonio", "historico", "objetivos", "ajustes"] as const;

/**
 * The query flag that re-launches the onboarding assistant mode from the ordinary
 * floating panel (PRD #1167 S3, #1170): «vuelve a repasar mi cartera con este
 * extracto», the same mode without the /bienvenida estreno surface. Captured into
 * `view` like any other URL-mirrored state so it flows to the system prompt with
 * zero extra plumbing (mirrors how S2 derived the mode purely from the route).
 */
export const ONBOARDING_RERUN_PARAM = "repasar";
const ONBOARDING_RERUN_VALUE = "1";

const VIEW_KEYS = ["view", "range", "exp", "hide", ONBOARDING_RERUN_PARAM];

/**
 * The dedicated onboarding route (PRD #1167 S1, #1168): the assistant in a
 * full-screen «estreno» presentation. It is where a freshly-provisioned
 * workspace lands (redirect gate in `onboarding-redirect.ts`) before it has an
 * `onboarded_at` mark.
 */
export const ONBOARDING_PATH = "/bienvenida";

/** The public landing at `/` is marketing-only — no assistant layer or chat turns. */
export function isAssistantSurface(pathname: string): boolean {
  return pathname !== "/";
}

/**
 * The onboarding route IS the assistant in full-screen mode, so `isAssistantSurface`
 * stays true here (chat turns are allowed); this predicate only tells the layer to
 * render its dedicated `estreno` presentation instead of the floating panel.
 */
export function isOnboardingSurface(pathname: string): boolean {
  return pathname === ONBOARDING_PATH;
}

/**
 * Whether the onboarding assistant mode applies to a turn, and in which flavour:
 *  - `"first-run"` — the dedicated `/bienvenida` estreno surface (S1/S2, #1168/#1169),
 *    a freshly-provisioned empty workspace.
 *  - `"re-run"` — the same mode re-launched from the ordinary panel via the
 *    {@link ONBOARDING_RERUN_PARAM} flag (S3, #1170), over a portfolio that already
 *    exists. Returns `null` on every other turn.
 *
 * The system prompt keys the onboarding framing off this; the re-run flavour is
 * a friendlier prompt only — the premium enforcement stays downstream at the
 * ingestion gate (#1162), so a client-set flag can never buy premium tools.
 */
export type OnboardingMode = "first-run" | "re-run";

export function onboardingModeForContext(context: ScreenContext): OnboardingMode | null {
  if (isOnboardingSurface(context.route)) return "first-run";
  if (context.view[ONBOARDING_RERUN_PARAM] === ONBOARDING_RERUN_VALUE) return "re-run";
  return null;
}

export function deriveScreenContext(pathname: string, search: string): ScreenContext {
  const seg = pathname.split("/").filter(Boolean);
  const section: ScreenSection =
    seg.length === 0 || (seg.length === 1 && seg[0] === "app")
      ? "resumen"
      : (SECTIONS.find((s) => s === seg[0]) ?? "otra");

  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const view: Record<string, string> = {};
  for (const key of VIEW_KEYS) {
    const value = params.get(key);
    if (value !== null) view[key] = value;
  }

  return {
    route: pathname,
    section,
    holdingId: section === "patrimonio" && seg.length > 1 ? (seg[1] ?? null) : null,
    view,
  };
}
