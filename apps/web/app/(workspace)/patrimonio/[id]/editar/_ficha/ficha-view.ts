/**
 * What the ficha is showing, as the URL says it (#1826, interaction-patterns §3).
 *
 * Two pieces of view state, both in the query string so a deep link, a reload and
 * the Back button all land on the same screen: which tab is open (`?pestaña=`) and
 * which action's side panel (`?accion=`). Nothing here persists anything — it is
 * the «which data am I looking at» half of the page, and the island conmuta it
 * without a round-trip.
 *
 * Two older doors are read as well, because links to them already exist and must
 * keep landing where they promised:
 *
 * - `?abrir=` names a tab or an action by its key. `?abrir=operaciones` and
 *   `?abrir=cobros` are what `holdingOperationsHref`/`holdingCobrosHref` build, and
 *   `?abrir=traspaso&archivar=1` is the Papelera's «Lo traspasé a…» exit (#1549).
 * - A refusal that came back in the URL (`?error=…&form=…`, the no-JS terminal and
 *   every action that still redirects) lands where its band is printed — the panel
 *   of the form that produced it, or the tab, when a `formId` is shared by forms in
 *   both (Cobros: the one-off entry and a schedule's costs) — or the band would sit
 *   behind a closed panel. Which form lives where is the ficha's to say
 *   ({@link FichaViewSpec.errorTargets}).
 *
 * An explicit `?pestaña=`/`?accion=` always wins over what those imply, and every
 * write spells the view out explicitly and drops the doors that had implied it —
 * otherwise closing a panel opened by `?abrir=traspaso` would leave the URL
 * reopening it on the next reload.
 *
 * Pure on purpose: no `window`, so the rules are unit tests and the island is left
 * with the `pushState` wiring only (interaction-patterns §7).
 */

import { PRESERVED_VALUE_PREFIX } from "@web/current-url";

/** The tab param. Spelled as the user reads it; `pestana` is accepted on the way in. */
export const FICHA_TAB_PARAM = "pestaña";
const FICHA_TAB_PARAM_ASCII = "pestana";
/** The open action's param. */
export const FICHA_ACTION_PARAM = "accion";
/** The legacy door: a tab or an action, by key. */
const FICHA_OPEN_PARAM = "abrir";

/** Where a refusal lands: a tab, an action's panel, or both. */
export interface FichaTarget {
  tab?: string;
  action?: string;
}

/** What one ficha offers — its tabs, its actions, and where each form's refusal lands. */
export interface FichaViewSpec {
  /** The tabs, in order. The first is the default, and is omitted from the URL. */
  tabs: readonly string[];
  /** The actions this holding offers right now (a non-candidate has no «histórico»). */
  actions: readonly string[];
  /** By `formId`: the tab or panel whose form prints that refusal. */
  errorTargets: Readonly<Record<string, FichaTarget>>;
}

/** The ficha's view: one tab, and at most one action's panel. */
export interface FichaView {
  tab: string;
  action: string | null;
}

/** The read side of `URLSearchParams` — what `useSearchParams()` hands the island. */
export interface SearchParamsReader {
  get(name: string): string | null;
}

/** The tab the bare URL shows: the first. One rule for every URL built or read. */
function defaultTab(tabs: readonly string[]): string {
  return tabs[0] ?? "";
}

function offered(list: readonly string[], value: string | null | undefined) {
  return value !== null && value !== undefined && list.includes(value) ? value : null;
}

/** Where the refusal in the URL lands, if there is one and the ficha places it. */
function errorTarget(params: SearchParamsReader, spec: FichaViewSpec): FichaTarget {
  const formId = params.get("form");
  if (!params.get("error") || formId === null) {
    return {};
  }
  return spec.errorTargets[formId] ?? {};
}

/** The view the URL describes, every unknown value falling back to the default. */
export function readFichaView(
  params: SearchParamsReader,
  spec: FichaViewSpec,
): FichaView {
  const abrir = params.get(FICHA_OPEN_PARAM);
  const target = errorTarget(params, spec);

  const tab =
    offered(
      spec.tabs,
      params.get(FICHA_TAB_PARAM) ?? params.get(FICHA_TAB_PARAM_ASCII),
    ) ??
    offered(spec.tabs, abrir) ??
    offered(spec.tabs, target.tab) ??
    defaultTab(spec.tabs);
  const action =
    offered(spec.actions, params.get(FICHA_ACTION_PARAM)) ??
    offered(spec.actions, abrir) ??
    offered(spec.actions, target.action);

  return { action, tab };
}

/**
 * The next query string after `change`, ready for `pushState`: the view spelled out
 * explicitly (the default tab and a closed panel omitted), the doors that implied
 * the previous one dropped, and every unrelated param (`ok`, `archivar`, …) kept in
 * place. A leading `?`, or `""` when nothing remains.
 */
export function writeFichaView(
  search: string,
  spec: FichaViewSpec,
  change: Partial<FichaView>,
): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const next = { ...readFichaView(params, spec), ...change };

  for (const key of [...params.keys()]) {
    if (key.startsWith(PRESERVED_VALUE_PREFIX)) params.delete(key);
  }
  for (const key of [FICHA_OPEN_PARAM, "error", "form", FICHA_TAB_PARAM_ASCII]) {
    params.delete(key);
  }

  // `set` keeps a param where it already was, so a toggle does not reshuffle the URL.
  if (next.tab === defaultTab(spec.tabs)) params.delete(FICHA_TAB_PARAM);
  else params.set(FICHA_TAB_PARAM, next.tab);
  if (next.action === null) params.delete(FICHA_ACTION_PARAM);
  else params.set(FICHA_ACTION_PARAM, next.action);

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * «Datos del activo»: the tab every tabbed ficha ends with — «Lo básico», the
 * availability, the Zona de peligro. Named here because a family links INTO it
 * («Indicar símbolo», #1828) while the page is the one that appends it.
 */
export const FICHA_DATOS_TAB = "datos";

/**
 * Every tab a ficha ends up with, in order: the family's own, then «Datos del
 * activo», which the page appends. What each URL a family builds is built against
 * (`fichaTabUrl`, `fichaActionUrl`), so the default tab is the family's first.
 */
export function withDatosTab<const T extends readonly string[]>(
  own: T,
): readonly [...T, typeof FICHA_DATOS_TAB] {
  return [...own, FICHA_DATOS_TAB];
}

/**
 * The ask a link into the ficha sends it: show this tab, open this action's panel,
 * focus this field. A cancelable window event — `FichaLink` dispatches it, the
 * island claims it with `preventDefault` — so one mechanism serves a link outside
 * the island (the warnings band, #1828) and one printed inside a server-rendered tab
 * (Cobros' «Añadir un cobro», #1830) alike (#1731 review).
 */
export const FICHA_OPEN_EVENT = "worthline:ficha-open";

/**
 * What a link into the ficha asks for: a tab, an action's panel, or both, and the
 * `name` of a field to focus in the tab.
 */
export interface FichaOpenRequest {
  tab?: string;
  action?: string;
  field?: string;
}

/**
 * The view change a link asks for, or null when this ficha has no such tab or
 * offers no such action — then the click is not claimed and the link navigates.
 * Showing a tab alone closes the open panel: a fix is on the tab, not behind a
 * sheet. An action opens its panel over the tab it names, or over the one on show.
 */
export function claimFichaOpen(
  request: FichaOpenRequest,
  spec: FichaViewSpec,
): Partial<FichaView> | null {
  const { action, tab } = request;
  if (tab !== undefined && !spec.tabs.includes(tab)) return null;
  if (action !== undefined) {
    if (!spec.actions.includes(action)) return null;
    return tab === undefined ? { action } : { action, tab };
  }
  return tab === undefined ? null : { action: null, tab };
}

/**
 * The ficha open on `tab`: a tab's real `href` (it works with JS off and from the
 * keyboard), and the `currentUrl` a form posts so its terminal lands back on the
 * tab where its result shows. The default tab is the bare URL.
 */
export function fichaTabUrl(
  basePath: string,
  tabs: readonly string[],
  tab: string,
): string {
  if (tab === defaultTab(tabs)) return basePath;
  return `${basePath}?${new URLSearchParams({ [FICHA_TAB_PARAM]: tab })}`;
}

/**
 * The ficha open on `tab` with `action`'s panel over it (#1830): the real `href` of
 * a link printed inside a tab that opens an action — Cobros' «Añadir un cobro» —
 * so it still lands with JS off, in a new tab or from a copied link.
 */
export function fichaActionUrl(
  basePath: string,
  tabs: readonly string[],
  tab: string,
  action: string,
): string {
  const params = new URLSearchParams();
  if (tab !== defaultTab(tabs)) params.set(FICHA_TAB_PARAM, tab);
  params.set(FICHA_ACTION_PARAM, action);
  return `${basePath}?${params}`;
}
