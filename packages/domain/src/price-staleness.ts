/**
 * @deprecated The staleness rule has moved to prices.ts (issue #67).
 * This file re-exports for backward compatibility during the transition.
 * It will be removed once all consumers import from prices directly.
 */
export { selectStalePrices } from "./prices";
