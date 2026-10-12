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

function defaultTab(spec: FichaViewSpec): string {
  return spec.tabs[0] ?? "";
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
    defaultTab(spec);
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
  if (next.tab === defaultTab(spec)) params.delete(FICHA_TAB_PARAM);
  else params.set(FICHA_TAB_PARAM, next.tab);
  if (next.action === null) params.delete(FICHA_ACTION_PARAM);
  else params.set(FICHA_ACTION_PARAM, next.action);

  const qs = params.toString();
  return qs ? `?${qs}` : "";
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
  if (tab === (tabs[0] ?? "")) return basePath;
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
  if (tab !== (tabs[0] ?? "")) params.set(FICHA_TAB_PARAM, tab);
  params.set(FICHA_ACTION_PARAM, action);
  return `${basePath}?${params}`;
}
