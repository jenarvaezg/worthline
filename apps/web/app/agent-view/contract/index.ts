/**
 * The agent-view contract: every type the agent-view read surface (catalog,
 * HTTP read-backend, MCP server — ADR 0023, ADR 0047) publishes to a caller.
 * Split into modules by family so a change to one area (fire, debt, figures,
 * …) doesn't require reading the whole contract — this file only re-exports,
 * it carries no logic of its own. Import from here (or from `./contract`,
 * which resolves to this index) exactly as before the split.
 */
export * from "./connected-source-positions";
export * from "./contribution-plan";
export * from "./data-quality";
export * from "./debt";
export * from "./exposure";
export * from "./figures";
export * from "./financial-context";
export * from "./fire";
export * from "./holdings";
export * from "./operations";
export * from "./payouts";
export * from "./returns";
export * from "./shared";
export * from "./snapshot-history";
export * from "./workspace";
