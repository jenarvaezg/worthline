/**
 * Test-only seams of `@worthline/pricing`, for suites outside this package that need
 * the MyInvestor client to answer from the anonymized fixtures (#1887) instead of the
 * network — the web's first-start integration test (#1880). Application code never
 * imports this module.
 */
export { fixtureTransport } from "./myinvestor/testing/fake-transport";
