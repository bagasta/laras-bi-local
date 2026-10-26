# Laras dashboard visual system

Reference direction: Claude Live Artifact dashboards with compact data cards, neutral surfaces, clear metric groups, and obvious date controls. Preserve the four-destination navigation and direct transitions from proactive findings to data-chat evidence.

## Owners

- Shared tokens and components: `web/design.css`.
- Page layout, chart labels, and question interactions: `web/app.js`.
- Business calculations and import contracts: `web/data.js`.

## Principles

- Inter across interface text and headings; plain page names instead of editorial titles.
- White panels on a warm neutral canvas. Terracotta identifies primary actions; warning and success colors remain semantic.
- Proactive findings precede reporting, with compact evidence and direct action links.
- Four KPIs show real totals. Abbreviated revenue retains the exact total in its title and detail text.
- Daily sales and channel contribution are computed from the same filtered transactions.
- Questions entered on the dashboard open Chat with Data with the selected period and traceable evidence.
- Responsive layouts stack panels without removing the four primary navigation destinations.

## Evidence

The source screenshots and article links are documented in README.md. DOM workflow checks run with jsdom. Local preview is available through npm start.

The current interface removes repeated page descriptions and chart helper text. Source lists, data notes, and recommendations use native details/summary disclosure. Cloud status is explicit; it never promotes an unconfigured demo to connected data.

Multi-document import uses one compact queue, per-file expandable worksheet mappings, concise provisioning phases, and one grouped approval. Format or validation errors stay attached to their file. Connection credentials are entered once in Settings and never prefilled.

The dashboard is now schema-driven: it derives KPIs, charts, source previews, and relevant tabs from approved columns. The unconfigured demo starts with service projects and offers staff/reservation examples. Controls expose source, measure, date, and category choices; no commerce metric is shown without the corresponding data.
