# Roadmap

**Die Roadmap ist eine Datei, und sie ist nicht diese:**
[app/config/roadmap.ts](../app/config/roadmap.ts)

Dort steht jeder Eintrag mit `status` (`in-progress`, `planned`, `considering`,
`shipped`, `dropped`) und `visibility`. `public` erscheint auf der Website unter
`/roadmap` in drei Sprachen — der Typ erzwingt alle drei. `internal` ist nur
Entwicklung: Infrastruktur, Security, Pricing. Ein Feature ausliefern heisst
dort ein Wort aendern, nicht eine Seite bearbeiten. Verworfene Punkte bleiben
mit ihrer Begruendung stehen.

Was frueher in dieser Datei stand und KEIN Roadmap-Eintrag ist, liegt jetzt als
Entscheidungsprotokoll in [reference/](reference/):

| Dokument | Inhalt |
|---|---|
| [PRICING_AND_LIMITS.md](reference/PRICING_AND_LIMITS.md) | Limit-Review Mai 2026, Wettbewerber-Benchmark, Preisstrategie, Pricing v2 — zitiert aus `plans.ts` |
| [JSONLD_BACKLOG.md](reference/JSONLD_BACKLOG.md) | `Product` vs `ProductGroup`, `hasMerchantReturnPolicy` |
| [ROADMAP_ARCHIVE_2026-01.md](reference/ROADMAP_ARCHIVE_2026-01.md) | Der Plan vom Januar, unveraendert — Phasen, Metriken, Risiken |
