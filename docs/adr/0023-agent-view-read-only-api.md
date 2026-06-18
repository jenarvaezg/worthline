# Agent view is a read-only API surface for agents

The **agent view** exposes worthline's financial context to agents as read-only
data, not as a recommendation engine. It is API-first: a shared internal service
assembles the context from `packages/db` and `packages/domain`, the HTTP API is
the external contract, and an MCP server is only an adapter on top of that API.
This keeps the future deployed product path open without letting MCP become a
parallel domain boundary.

The HTTP contract starts at `/api/v1/agent-view`. Every endpoint is a `GET`
read with the same response envelope (`data`, optional `meta`, optional `links`)
and the same error envelope (`error.code`, `error.message`, optional details).
MCP tools map to these endpoints and preserve their object shapes. Tool names may
be agent-friendly verbs, but the domain contract remains the HTTP API.

The agent view reads persisted state through a narrow `AgentViewReadStore` port
and derives figures on demand, but it never refreshes prices, syncs connected
sources, captures snapshots, writes live data, or exports transfer artifacts as a
side effect of being read. It must not reuse dashboard loaders that have those
side effects. In particular, `loadDashboard` remains a user-facing dashboard
assembly path, not an agent-view dependency.

The main context call returns a compact "full picture" for the selected
**scope** (household by default, member or member group explicitly): current
portfolio, FIRE progress, data-quality signals, recent trend, and summaries of
calculation facts. Drilldown calls expose full calculation facts where needed:
operations, valuation anchors, amortization plans, balance anchors, price
freshness, connected-source positions, snapshot holding rows, trash summary, and
"explain this figure" decomposition.

History defaults to **monthly closes** for compact trend analysis; raw snapshots
remain available through explicit date filters, granularity, cursor pagination,
and stable sorting. Money follows the domain contract (`amountMinor` +
`currency`), while quantities, prices, ratios, and FX rates stay decimal strings.
User-authored member, member group, holding, source, and position labels are
exposed because they are part of the agent's useful context, but secrets,
connected-source credentials, audit payloads, and full import/export documents
are not exposed.

The API exposes public, prefixed, opaque IDs (`wl_scp_...`, `wl_mbr_...`,
`wl_grp_...`, `wl_hld_...`, `wl_snp_...`, `wl_op_...`, `wl_src_...`,
`wl_pos_...`) plus explicit object fields and human labels. These IDs come from
a persisted public-ID registry, not from user labels or internal slug IDs. The
registry is backfilled for existing workspaces, written on normal entity
creation/sync paths, and included in export/import so IDs remain stable for the
same workspace. Agent-view reads do not lazily create missing IDs; missing
registry entries are a data-quality/implementation error to fix outside the read.
Clients must not parse prefixes for behavior.

Historical explanation has an explicit support matrix. Current-date figures can
be decomposed from live holdings and calculation facts. Snapshot-date net worth,
liquid net worth, gross assets, debts, housing equity, liquidity breakdown, and
holding values can be decomposed only when snapshot holding rows exist; older
snapshots without those rows return the aggregate figure with a partial
decomposition status and a history-coverage signal. FIRE history is not defined
for v1; FIRE explanations are current-only until worthline stores historical FIRE
assumptions and eligibility decisions.

Local v1 can run without hosted login, but the API is sensitive financial data.
The local server binds to loopback only, does not enable browser CORS for other
origins, redacts request/response logs, and requires a local capability token for
external API/MCP access even before cloud authentication exists. Production or
non-loopback serving is disabled by default until authentication and
authorization are designed.

## Considered options

- **MCP reads SQLite directly** — rejected: it would make MCP the real contract,
  duplicate future API work, and make deployment/auth harder later.
- **Only aggregate figures** — rejected: agents need calculation facts to explain
  and challenge the figures instead of treating them as magic numbers.
- **One huge unpaged dump** — rejected: it wastes context and fails on long
  operation/snapshot histories; the main call stays compact and drilldowns carry
  depth.
- **Expose current internal IDs** — rejected for the public contract because many
  current IDs contain user-derived slugs and should not become stable API
  surface.
- **Generate public IDs lazily while reading** — rejected: it would make a read
  mutate the workspace and undermine the whole agent-view safety boundary.
