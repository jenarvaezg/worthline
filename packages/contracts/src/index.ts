export type CurrencyCode = "EUR" | (string & {});

export interface MoneyMinor {
  amountMinor: number;
  currency: CurrencyCode;
}

export type DecimalString = string;

export type LiquidityTier =
  | "cash"
  | "market"
  | "retirement"
  | "illiquid"
  | "housing";

export interface LocalPersistenceStatus {
  status: "ok";
  databasePath: string;
  displayPath: string;
  checkedAt: string;
  checkKey: string;
  checkValue: string;
}
