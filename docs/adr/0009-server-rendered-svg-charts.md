# Charts are server-rendered SVG; no charting library

The dashboard needed real charts (net worth evolution, stacked decomposition, tier
donut, drilldowns), and the obvious path was a client charting library like recharts
or chart.js. We decided to render all charts as plain SVG from server components
instead: chart geometry (series building, scales, stacking, the stacked→multiline
fallback when a band crosses zero, donut arcs) lives as pure tested functions in
`packages/domain`, and the web app assembles dumb SVG elements from it.

The app is deliberately zero-client-JS — server components, native `<details>`,
links for navigation — and a chart library would have introduced its first
significant `"use client"` boundary, hydration, and ~100KB+ of JS for charts that
are geometrically simple over small local data. Interactivity stays within native
means: SVG `<title>` for hover values and SVG `<a>` for drilldown navigation via
query params. If rich cursor-following interactivity is ever wanted, the cost is
migrating individual chart components, not the page architecture.

This escape hatch was taken for the net-worth composition chart (#143): its
consolidated, cursor-following tooltip — listing every band, debt and the net
worth of the hovered period — is a `"use client"` component. The tooltip overlay
is `pointer-events: none`, so the asset bands underneath stay native `<a>` links
(drilldown navigation remains a zero-JS full document navigation); only the hover
layer needs the client. The rest of the dashboard stays server-rendered.

Historical chart zoom follows the same boundary: range and density controls are
URL state handled by the server, not pan/zoom gestures inside the SVG. The chart
may switch monthly, quarterly, or annual buckets as the selected range changes,
but the interaction remains links/forms plus a server-rendered SVG.

The dashboard's main historical chart is a net-worth composition chart: gross
asset components stack above zero, debt components stack below zero, and a net
worth line shows the resulting total. This mirrors the domain equation
`gross assets - debts = net worth` directly and avoids hiding debt inside already
netted bands when the user is trying to understand why the total moved. The
positive stack uses the five liquidity tiers — cash, market, retirement,
illiquid, and housing — plus one aggregated negative debt stack; splitting debt
by tier belongs in drilldown, not in the main chart. The chart deliberately
avoids a secondary YoY percentage axis; movement percentages belong in the
dashboard delta chips unless that trade-off is revisited.

For monthly views, closed months use the month's last snapshot. If the current
month has a later snapshot than the latest monthly close, the chart appends that
latest snapshot as an open-period bar so the dashboard does not appear one month
stale.
