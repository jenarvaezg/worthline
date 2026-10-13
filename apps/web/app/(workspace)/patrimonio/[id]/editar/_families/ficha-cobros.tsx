/**
 * «Cobros» on a tabbed ficha: the tab, the «Añadir cobro» action and where a refused
 * cobro lands — the three pieces every asset family places the same way (#1846).
 *
 * The shared Cobros panel is loaded once by the page (`_chrome/payouts-panel`); this
 * module turns it into what a tabbed family hands the ficha. It was written inside
 * the investment family first (#1826, #1829, #1830), and every family that moves to
 * tabs carries the same three things, so they live here and a family states only
 * WHERE in its order the tab goes and which tabs it has:
 *
 * - the tab, keyed `cobros`, because `?abrir=cobros` is a contract — rentas, FIRE
 *   and salud link there (`holdingCobrosHref`, #1824);
 * - the action, at hand once the holding has paid something and inside «Más» before
 *   (#1829), offering «Añadir otro» after a registration;
 * - the error targets: the record's own controls print on the tab, an entry form's
 *   refusal reopens «Añadir cobro» over it, on the form that produced it.
 */

import { COBRO_FORM_ID } from "@web/inversiones/cobro-form-ids";
import { FichaLink } from "@web/patrimonio/[id]/editar/_ficha/ficha-link";
import type { FichaTarget } from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import {
  fichaActionUrl,
  fichaTabUrl,
} from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import type { FichaAction, FichaTab, PayoutsPanel } from "./family-contract";

/** The Cobros tab's key: the `?abrir=cobros` every link into it already uses. */
export const COBROS_TAB = "cobros";

/** The «Añadir cobro» action's key: its `?accion=`. */
export const COBRO_ACTION = "cobro";

/** What a tabbed family places for Cobros. */
export interface FichaCobros {
  /** «Cobros N»: what it paid and is declared to pay. */
  tab: FichaTab;
  /** «Añadir cobro», by the #1829 rule: at hand once it has paid something. */
  action: FichaAction;
  /** Where each Cobros form's refusal lands, by `formId`. */
  errorTargets: Readonly<Record<string, FichaTarget>>;
}

export function fichaCobros({
  currentUrl,
  payoutsPanel,
  tabs,
}: {
  /** The ficha's own public URL. */
  currentUrl: string;
  payoutsPanel: PayoutsPanel;
  /**
   * Every tab the ficha ends up with, in order — «Datos del activo» included — so
   * the return URL and the link here are built against the same list the family's.
   */
  tabs: readonly string[];
}): FichaCobros {
  const cobrosUrl = fichaTabUrl(currentUrl, tabs, COBROS_TAB);

  return {
    action: {
      again: "Añadir otro",
      content: payoutsPanel.entry(cobrosUrl),
      key: COBRO_ACTION,
      label: "Añadir cobro",
      // At hand once the holding has paid something; one that never has does not
      // need the button in view, so it waits in «Más» (#1829).
      tier: payoutsPanel.count > 0 ? "secondary" : "more",
    },
    errorTargets: {
      // The record's own controls print on the tab; an entry form's refusal reopens
      // «Añadir cobro» over it, on the form that produced it (#1731 review).
      [COBRO_FORM_ID.record]: { tab: COBROS_TAB },
      [COBRO_FORM_ID.oneOff]: { action: COBRO_ACTION, tab: COBROS_TAB },
      [COBRO_FORM_ID.recurring]: { action: COBRO_ACTION, tab: COBROS_TAB },
    },
    tab: {
      content: payoutsPanel.record(
        cobrosUrl,
        // With none yet, the record is one line and this is its door (#1830): the
        // «Añadir cobro» panel, opened over the tab.
        <FichaLink
          action={COBRO_ACTION}
          href={fichaActionUrl(currentUrl, tabs, COBROS_TAB, COBRO_ACTION)}
          tab={COBROS_TAB}
        >
          Añadir un cobro
        </FichaLink>,
      ),
      count: payoutsPanel.count,
      key: COBROS_TAB,
      label: "Cobros",
    },
  };
}
