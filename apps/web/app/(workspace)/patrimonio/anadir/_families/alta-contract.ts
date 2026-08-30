/**
 * The contract every alta family answers to (#1611).
 *
 * A family owns the creation of one kind of holding end to end: which of the
 * submission's fields it reads, what it validates, what it writes, and — for the
 * ones that have something to say afterwards — what the redirect must tell the
 * user. The action knows none of that. It normalizes the submission, asks
 * {@link AltaFamily} which family it is, and hands over an {@link AltaContext}.
 *
 * Two deliberate boundaries:
 *
 * - **A family never builds a URL.** It answers with an {@link AltaResult}: a
 *   Spanish message, or an {@link AltaCreated} naming the holding, the ok-key and
 *   where the user lands. The action turns that into the redirect, because the
 *   query string it belongs in (the wizard's `&added=`, the board's `#anchor`)
 *   is a property of WHERE the alta was submitted from, not of what was created.
 * - **A family declares its own refill fields.** After a rejected alta the form
 *   comes back with what was typed still in it (`preserveFields`); the keys that
 *   matter are the ones that family's pane posts. Keeping the list beside the
 *   command is what makes «añadir un instrumento no toca las otras familias»
 *   true of the error path too, not just the happy one.
 */

import type { ExposureCatalogStubCandidate } from "@web/ensure-exposure-catalog-stubs";
import type { WorthlineStore } from "@web/store";
import type { Instrument } from "@worthline/domain";
import type { InvestmentAssetRef } from "@worthline/pricing";

/** What a family gets: the submission, the clock, and the store. */
export interface AltaContext {
  /** The request-scoped store — every read and the write go through it. */
  store: WorthlineStore;
  /**
   * The submission, already normalized: the simple wizard's drawer fields have
   * been rewritten as the chosen instrument's suffixed ones, so a family reads
   * `<field>_<instrument>` and never has to know which surface posted it.
   */
  formData: FormData;
  /** The instrument the submission chose. The family's own routing is done. */
  instrument: Instrument;
  /** Today, as an ISO date key — the ripple's anchor and the default date. */
  today: string;
  /** Wall clock, ISO — what the first-quote fetch is stamped with. */
  now: string;
  /**
   * ONE clock reading for every id this alta mints. The action takes it once so
   * the holding, its opening operation and its transfer ids all come from the
   * same millisecond — they are already distinguished by prefix and name.
   */
  seed: number;
}

/** Where a consummated alta lands the user. */
export type AltaLanding =
  /** The default: back to the wizard's success panel, or onto the board. */
  | "wizard-or-board"
  /** The holding's own ficha — «importar extracto» continues there (#173). */
  | "holding-ficha";

/** What a family answers with when the holding is written. */
export interface AltaCreated {
  /** The ok-key whose message the destination screen renders. */
  okKey: string;
  /** The new holding's INTERNAL id. The action resolves its public one (#1318). */
  holdingId: string;
  landing?: AltaLanding;
  /** Extra query params the ok-key's message reads (e.g. `deudaDesde`, #1561). */
  params?: Record<string, string>;
  /**
   * Whether the board redirect scrolls to the new row. `false` when the redirect
   * carries a QUESTION: the band that asks it sits above the row (#1561).
   */
  jumpToHolding?: boolean;
  /** The global-catalog stub to register after the commit (#1097). */
  catalog?: ExposureCatalogStubCandidate;
  /** The pricing coordinates whose FIRST quote is fetched after the commit (#1314). */
  firstQuote?: { asset: InvestmentAssetRef; nowIso: string };
}

/** A family's answer: the holding it created, or why it refused. */
export type AltaResult =
  | { ok: true; created: AltaCreated }
  | { ok: false; message: string };

/**
 * One alta family, resolved for a route: the fields its pane posts, and the
 * command that runs it with the catalog spec the routing already produced.
 */
export interface AltaCommand {
  /**
   * The unsuffixed field keys this family's pane posts, refilled after a
   * rejected alta. The action suffixes them with the chosen instrument.
   */
  refillFields: readonly string[];
  run: (ctx: AltaContext) => Promise<AltaResult>;
}
