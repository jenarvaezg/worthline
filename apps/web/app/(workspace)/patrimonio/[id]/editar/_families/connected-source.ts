/**
 * A connected source's row, as the store lists it — what the two mirror families
 * (a Numista collection, a Binance rung, #1849) are handed by the dispatch, which
 * resolves it from the asset's own back-link. Its own module because neither
 * family owns it: the collection must not import the Binance family to name it.
 */

import type { WorthlineStore } from "@web/store";

export type ConnectedSource = Awaited<
  ReturnType<WorthlineStore["connectedSources"]["listSources"]>
>[number];
