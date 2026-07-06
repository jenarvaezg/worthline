/**
 * The deterministic placeholder the public MCP endpoint returns for a tool call
 * when there is no workspace to read (local no-auth dev, #399/#410): no internal
 * service or HTTP API is touched and no real data is exposed. The tool metadata
 * itself comes from the single catalog definition in `catalog.ts` (#576).
 */
export const STUB_NOTICE = "This tool is not yet wired to real data.";
