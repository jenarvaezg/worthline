/**
 * The alta's one dispatch point (#1611): a route in, a command out.
 *
 * This is the whole branching `createHoldingAction` used to do inline. The action
 * now decides WHICH instrument is being created; this module answers WHAT family
 * that is and hands the work to its command. Two properties follow, and both are
 * the point of the refactor:
 *
 * - A family reads only the fields its own pane posts, validates only its own
 *   rules and writes only its own rows. Nothing runs «just in case some branch
 *   needs it», and the error path is symmetric: the refill list travels with the
 *   command, so a rejected alta of one family cannot forget a field of another.
 * - Adding a family is adding a case here and a module beside it. Adding an
 *   INSTRUMENT is adding a row to the catalog and, at most, a field to one
 *   family — never a branch in the action.
 *
 * The catalog spec each command needs travels inside the route that selected it
 * (`AltaRoute`), so no command re-derives the fact that sent it here and none
 * carries a guard for a case it cannot be called in.
 */

import type { AltaCommand } from "./alta-contract";
import type { AltaRoute } from "./alta-route";
import { DEBT_REFILL_FIELDS, runDebtAlta } from "./debt-alta";
import { HOUSING_REFILL_FIELDS, runHousingAlta } from "./housing-alta";
import { INVESTMENT_REFILL_FIELDS, runInvestmentAlta } from "./investment-alta";
import { runStoredAlta, STORED_REFILL_FIELDS } from "./stored-alta";

/** The command that creates the holding this route named. */
export function altaCommandFor(route: AltaRoute): AltaCommand {
  switch (route.family) {
    case "debt":
      return {
        refillFields: DEBT_REFILL_FIELDS,
        run: (ctx) => runDebtAlta(ctx, route.liability),
      };
    case "housing":
      return {
        refillFields: HOUSING_REFILL_FIELDS,
        run: (ctx) => runHousingAlta(ctx, { rung: route.rung }),
      };
    case "investment":
      return {
        refillFields: INVESTMENT_REFILL_FIELDS,
        run: (ctx) =>
          runInvestmentAlta(ctx, {
            rung: route.rung,
            ...(route.priceProvider ? { priceProvider: route.priceProvider } : {}),
          }),
      };
    case "stored":
      return {
        refillFields: STORED_REFILL_FIELDS,
        run: (ctx) =>
          runStoredAlta(ctx, { assetType: route.assetType, rung: route.rung }),
      };
  }
}
