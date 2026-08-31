/**
 * The alta form's one presentation dispatch point (#1700), the counterpart of
 * {@link altaCommandFor}: a drawer in, that drawer's pane out.
 *
 * ADR 0095's rule, applied to the alta: the page does not ask «is this a pension
 * plan?», «is this a mortgage?». It walks {@link DRAWERS} and places whatever
 * each row's family returns. Adding a drawer is adding a row to the table, a
 * case here, and a module beside its alta command — never a branch in the page.
 *
 * Every pane is in the DOM at once because the disclosure is pure CSS (ADR 0009),
 * so this dispatch renders all five; which one shows is
 * {@link altaRevealCss}'s business.
 */

import type { Instrument } from "@worthline/domain";
import type { Drawer } from "./alta-drawers";
import { DebtPane } from "./debt-pane";
import { HousingPane } from "./housing-pane";
import { InvestmentPane } from "./investment-pane";
import type { PaneValues } from "./pane-shell";
import { MoneyPane, OtherAssetPane } from "./stored-pane";

/**
 * Everything the panes need, resolved once by the page. It is the union of what
 * the five ask for — a pane reads only its own fields, and none of them reads the
 * store.
 */
export interface AltaPaneContext {
  /** Whether the workspace already has a primary residence (housing default). */
  hasPrimaryResidence: boolean;
  /** The picked symbol's live unit price, when there is one (investment). */
  livePrice: string | null;
  /** The resolved search params — the investment group's search state (#597). */
  resolvedParams: Record<string, string | string[] | undefined>;
  /** The investment group the URL or the round-trip selected. */
  selectedInstrument: Instrument | undefined;
  /** Today, as an ISO date key — the debt baseline and the capture default. */
  today: string;
  /** What a rejected alta brought back, keyed by field. */
  values: PaneValues;
}

/** The pane of one drawer. The only `switch` over the drawer table. */
export function AltaDrawerPane({
  ctx,
  drawer,
}: {
  ctx: AltaPaneContext;
  drawer: Drawer;
}) {
  switch (drawer.id) {
    case "dinero":
      return <MoneyPane values={ctx.values} />;
    case "inversion":
      return (
        <InvestmentPane
          livePrice={ctx.livePrice}
          resolvedParams={ctx.resolvedParams}
          selectedInstrument={ctx.selectedInstrument}
          today={ctx.today}
          values={ctx.values}
        />
      );
    case "inmueble":
      return (
        <HousingPane hasPrimaryResidence={ctx.hasPrimaryResidence} values={ctx.values} />
      );
    case "bien":
      return <OtherAssetPane values={ctx.values} />;
    case "deuda":
      return <DebtPane today={ctx.today} values={ctx.values} />;
  }
}
