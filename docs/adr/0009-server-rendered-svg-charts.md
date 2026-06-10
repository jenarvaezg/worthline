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
