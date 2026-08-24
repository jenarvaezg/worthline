import type { MoneyMinor } from "@worthline/domain";

import type { AgentViewMoney } from "./contract";

export function money(value: MoneyMinor): AgentViewMoney {
  return { amountMinor: value.amountMinor, currency: value.currency };
}

export function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

export function zero(currency: string): AgentViewMoney {
  return { amountMinor: 0, currency };
}
