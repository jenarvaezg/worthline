import type {
  CompositionHousingMode,
  CompositionRange,
  DrilldownKey,
  NetWorthFraming,
} from "@worthline/domain";

import { appendParam } from "./intake";

/**
 * The canonical composition-panel URL (#144, ADR 0036): the four view-state
 * params — framing `view`, `drill`, temporal `range`, `vivienda` — encoded with
 * each default OMITTED so a clean state yields a clean URL. Pure (only
 * `appendParam`), so the SERVER renders the initial links with it and the CLIENT
 * island builds every toggled link with the SAME function — no server/client
 * drift (S4 #520, ADR 0038). `#composicion` anchors same-page links so a server
 * navigation lands on the panel.
 */
export function compositionUrl(
  view: NetWorthFraming,
  drill: DrilldownKey | null,
  range: CompositionRange,
  housingMode: CompositionHousingMode,
  anchor = true,
): string {
  let url = "/";
  if (view === "liquid") url = appendParam(url, "view", "liquid");
  if (drill) url = appendParam(url, "drill", drill);
  if (range !== "all") url = appendParam(url, "range", range);
  if (housingMode === "hidden") url = appendParam(url, "vivienda", "oculta");
  return anchor ? `${url}#composicion` : url;
}
