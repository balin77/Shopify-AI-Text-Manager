# JSON-LD — offene Entscheidungen

> Verschoben aus `docs/ROADMAP.md` (2026-09-12), inhaltlich unverändert. Die
> beiden Punkte sind als interne Eintraege in
> [app/config/roadmap.ts](../../app/config/roadmap.ts) gefuehrt
> (`jsonld-product-group`, `jsonld-merchant-listing`); die Begruendung steht hier.

### JSON-LD: Entscheidung vor dem Ausbau des Theme-Schemas — `Product` vs. `ProductGroup`

Dawn gibt bei Varianten-Produkten `ProductGroup` mit `hasVariant` aus (eine
eigene Entity je Variante), wir geben `Product` mit einem Offer-Array. Beide
Modelle sind valide, aber sie sind **nicht gleichwertig**: Wird das
Theme-Schema entfernt, verliert Google die einzelnen Varianten-Entities.
Sichtbar wird das erst Wochen später in der Search Console, nicht am Tag des
Umbaus.

Vor dem Entfernen des Theme-Schemas bewusst entscheiden:

- **Offer-Array behalten** — Google leitet die Preisspanne selbst ab und
  bekommt Verfügbarkeit + SKU je Variante. Keine eigenständigen
  Varianten-Entities.
- **Auf `ProductGroup` + `hasVariant` wechseln** — Varianten bleiben eigene
  Entities (relevant, wenn einzelne Varianten in der Suche ranken sollen),
  dafür deutlich größeres Markup.

Nicht nebenbei beim Ausbau entscheiden — der Wechsel ändert die Identität der
Entities und damit, was Google über die Zeit gelernt hat.

### JSON-LD: `hasMerchantReturnPolicy` + `shippingDetails` (Merchant listings)

Ohne diese beiden Felder meldet die Google Search Console unter "Merchant
listings" Warnungen zu unserem Product-Markup. Sie fehlen bewusst — die Daten
existieren nirgends in der App, und die beiden naheliegenden Quellen taugen
nicht: `shop.refund_policy` ist Fließtext (Parsen wäre Raten), und
markt-/gewichtsabhängige Versandkosten sind über Liquid nicht verlässlich
abbildbar.

Entscheidend für die spätere Umsetzung: **Google prüft diese Angaben gegen die
Merchant-Center-Daten und entzieht bei Abweichung die Rich Results komplett.**
Falsche Angaben sind also schlechter als gar keine. Wenn wir es bauen, dann
ausschließlich als explizite Händler-Eingabe im App-Embed (Rückgabefrist,
Rückgabeart, Versandkosten/-dauer je Zielland) mit **leerem Default** — nie
geraten, nie geparst, nie aus einer Policy-Seite extrahiert. Bis dahin sind die
Search-Console-Warnungen der bewusst gewählte Preis.

Betroffene Datei: `extensions/storefront/blocks/structured-data.liquid`.

---
