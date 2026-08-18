# Metaobjekt-Editor — Plan (Phasen 0–5)

**Status:** Entwurf, Umsetzung nicht begonnen.
**Ziel:** `/app/metaobjects` vom reinen Übersetzungs-Fenster zu einer Arbeitsfläche machen — Einträge **anlegen und entfernen**, **alle** editierbaren Felder eines Eintrags bearbeiten (nicht nur das Label), und für Farb-Metaobjekte den **Swatch** (Farbwert und/oder Bild) sehen und setzen.
**Auslöser:** Produktoptionen können auf Metaobjekte verweisen (Standard-Definition für Farben); der Produkt-Editor verlinkt seit [OptionsField.tsx:196-202](../../app/components/unified/OptionsField.tsx#L196-L202) genau hierher — und wer dort ankommt, kann heute fast nichts tun.
**Baut auf:** [unified-content.actions.ts](../../app/actions/unified-content.actions.ts) (der EINE Action-Handler), [UnifiedContentEditor](../../app/components/UnifiedContentEditor.tsx), dem bereits ausgelieferten Create/Delete-Pfad aus [PLAN_CONTENT_CREATION.md](PLAN_CONTENT_CREATION.md) (§1.5/§1.8) und dem Metaobjekt-Schreibpfad des Bulk-Editors ([apply.server.ts:1541-1670](../../app/services/bulk-editor/apply.server.ts#L1541-L1670)).

> **Release-Randbedingung vorab — es ist KEINE Scope-Erweiterung nötig, und das ist die wichtigste Zahl dieses Plans.**
> `write_metaobjects` und `read_metaobject_definitions` stehen **bereits in beiden TOMLs** ([shopify.app.dev.toml:7](../../shopify.app.dev.toml#L7), [shopify.app.prod.toml:9](../../shopify.app.prod.toml#L9)), ebenso `read_files,write_files` (Swatch-Bilder) und `read_products` (Verwendungszählung). Damit läuft **kein** Re-Consent aller installierten Merchants an — der Kostenpunkt, den CLAUDE.md als „das, was Merchants verliert" führt, fällt hier nicht an.
> **Die eine Ausnahme, die diesen Satz kippen würde:** Metaobjekt-**DEFINITIONEN** anlegen oder ändern braucht `write_metaobject_definitions`. Das ist deshalb in §9 ein ausdrückliches Nicht-Ziel und darf nicht „nebenbei" in eine Phase rutschen.

---

## 0. Ist-Zustand (gegen den Code verifiziert, 2026-08)

### 0.1 Was `/app/metaobjects` heute ist

[app.metaobjects.tsx](../../app/routes/app.metaobjects.tsx) rendert den `UnifiedContentEditor` mit `METAOBJECTS_CONFIG`. Das Datenmodell der Seite ist der Kern jeder Schwierigkeit:

- **Ein Item = ein Metaobjekt-TYP.** Der Loader ([:33-101](../../app/routes/app.metaobjects.tsx#L33-L101)) baut aus `MetaobjectDefinition` Pseudo-Items mit der ID `metaobject_type_<type>` und `contentCount` aus einem `db.metaobject.count`. Echte Einträge lädt er nicht.
- **Ein Feld = ein EINTRAG.** `getFieldDefinitions` ([content-fields.config.tsx:779-799](../../app/config/content-fields.config.tsx#L779-L799)) erzeugt pro Metaobjekt **ein** Textfeld, dessen `key` und `translationKey` die Metaobjekt-GID ist, und dessen Wert das Label-Feld (`display_name` | `name` | `label`, [shopifyFields.ts:93-97](../../app/constants/shopifyFields.ts#L93-L97)) ist.
- **Nachladen** der Einträge eines Typs geschieht clientseitig über `GET /api/metaobjects/<type>` ([:188-216](../../app/routes/app.metaobjects.tsx#L188-L216)).

Folge: Es gibt in dieser Oberfläche **keine Ebene, auf der ein Eintrag ein Objekt ist**. Ein Eintrag ist ein Formularfeld. Anlegen, Löschen, Mehrfeld-Bearbeitung und ein Swatch haben dort keinen Platz — das ist der eigentliche Grund für die Beschwerde, nicht eine fehlende Schaltfläche.

### 0.2 Was gespeichert werden kann — und was nicht

Der Speicherpfad ist der Metaobjekt-Zweig in [content-update.action.ts:473-760](../../app/actions/content/content-update.action.ts#L473-L760). Er sammelt alle Formularfelder, deren Key mit `gid://shopify/Metaobject/` beginnt, und schreibt **ausschließlich das Label-Feld**:

| Vorgang | heute |
|---|---|
| Label in der Primärsprache ändern | ✅ `metaobjectUpdate` mit genau einem Feld |
| Label übersetzen | ✅ `translationsRegister` + `MetaobjectTranslation` |
| Übersetzung leeren | ✅ `translationsRemove` |
| **Ein anderes Feld** (Farbe, Bild, Beschreibung, Liste) ändern | ❌ nicht angeboten, nicht geschrieben |
| **Eintrag anlegen** | ⚠ funktioniert, aber blind (siehe Befund B3) |
| **Eintrag löschen** | ❌ die Schaltfläche existiert und schlägt fehl (Befund B1) |

### 0.3 Was anderswo schon fertig ist — und wiederverwendet wird statt neu gebaut

Das ist der Grund, warum dieser Plan trotz drei Feature-Wünschen klein bleibt:

- **Create-Pfad für Metaobjekt-Einträge ist ausgeliefert.** `createMetaobject` ([create.actions.ts:647-681](../../app/actions/content/create.actions.ts#L647-L681)) mit Echo auf **id UND Feldwerten**, Definitionsprüfung ([:251-274](../../app/actions/content/create.actions.ts#L251-L274)), Cache-Nachzug per Typ-Sync ([:811-817](../../app/actions/content/create.actions.ts#L811-L817)), Definitions-Picker über [api.create-options.tsx:63](../../app/routes/api.create-options.tsx#L63) und die Angebots-Regeln in [create-fields.config.ts:286-356](../../app/config/create-fields.config.ts#L286-L356) (`metaobjectCreatability`, `EDITABLE_METAOBJECT_FIELD_TYPES`, `metaobjectFieldsPayload`).
- **Delete-Pfad ist ausgeliefert.** `deletePlan("metaobject")` ([delete.actions.ts:85-90](../../app/actions/content/delete.actions.ts#L85-L90)), Echo auf `deletedId` ([:139-155](../../app/actions/content/delete.actions.ts#L139-L155)), Cache-Purge inkl. Übersetzungen ([content-delete.server.ts:107-112](../../app/services/content-delete.server.ts#L107-L112)), zweistufiger Dialog mit Namenseingabe ([DeleteItemModal.tsx](../../app/components/create/DeleteItemModal.tsx)). Es fehlt **nur** der Aufruf mit einer echten Metaobjekt-GID.
- **Mehrfeld-Schreiben mit Echo gibt es schon — im Bulk-Editor.** `persistMetaobjectRow` ([apply.server.ts:1552-1670](../../app/services/bulk-editor/apply.server.ts#L1552-L1670)) schreibt beliebig viele Felder in EINEM `metaobjectUpdate`, prüft je Feld, ob Shopify **unseren Wert** zurückgibt, spiegelt erst dann `fields`/`displayName` und invalidiert die fremdsprachigen Zeilen. Spaltenbau: [columns.server.ts:109-140](../../app/services/bulk-editor/columns.server.ts#L109-L140); Typfilter `isEditableMetaobjectFieldType` ([columns.shared.ts:645-654](../../app/services/bulk-editor/columns.shared.ts#L645-L654)); Übersetzungsschlüssel = Feldschlüssel ([translations.server.ts:65-67](../../app/services/bulk-editor/translations.server.ts#L65-L67)).
  **Der Einzel-Editor hinkt dem Bulk-Editor hinterher, nicht der API.**
- **Swatch-Auflösung existiert bereits — und wird gerade verkabelt.** `resolveSwatch`/`looksLikeColourOption` ([product-option-swatch.shared.ts](../../app/services/product-option-swatch.shared.ts)) und `fetchOptionSwatches` ([product-options.server.ts:332-390](../../app/services/product-options.server.ts#L332-L390)) lösen einen Farbwert in drei absteigenden Autoritätsstufen auf (Shopifys eigener Swatch → Hex/`rgb()` im Namen → eine bewusst schmale Farbwort-Tabelle) und geben `null` zurück, wenn nichts ehrlich auflösbar ist.
  **Stand 2026-08 liegt im Arbeitsverzeichnis eine noch nicht committete Änderung**, die genau das an den Produkt-Editor anschließt: `api.product-option-details.tsx` liefert `counts` **und** `swatches` in einem Request (beide Hälften scheitern unabhängig voneinander), `VariantOptionsEditor.tsx` malt den Punkt neben den Optionswert. Dieser Plan **baut darauf auf und baut es nicht noch einmal** — er benutzt denselben Resolver für die Swatch-Vorschau in der Eintragskarte (§7.1). Sollte die Änderung nicht landen, wächst Phase 5 wieder um diesen Teil.
- **Bild-Auswahl** über [FilePickerModal](../../app/components/image-manager/FilePickerModal.tsx) (`onAdd`, `uploadCommitMode`, `initialKind: "image"`) plus `MediaLibraryImage`-Cache ([schema.prisma:1936-1961](../../prisma/schema.prisma#L1936-L1961), kennt sogar `usageKind: "metaobject"`).
- **Reload pro Typ:** `/api/sync-single-resource` mit `resourceType=metaobjects` ([:160-177](../../app/routes/api.sync-single-resource.tsx#L160-L177)).

### 0.4 Datenmodell und Cache

[schema.prisma:1148-1210](../../prisma/schema.prisma#L1148-L1210): `MetaobjectDefinition` (inkl. `fieldDefinitions` JSON mit `required`/`validations`), `Metaobject` (`fields` JSON), `MetaobjectTranslation` (`shop, metaobjectId, key, locale, marketId` — der Feldschlüssel ist also **schon** Teil des Unique-Keys, das Datenmodell trägt Mehrfeld-Übersetzungen bereits).
Sync: [metaobject-sync.service.ts](../../app/services/metaobject-sync.service.ts) — Definitionen ([:158-228](../../app/services/metaobject-sync.service.ts#L158-L228)), Einträge pro Typ mit Stale-Delete ([:233-313](../../app/services/metaobject-sync.service.ts#L233-L313)), Übersetzungen gebündelt und markt-bewusst ([:371-487](../../app/services/metaobject-sync.service.ts#L371-L487)) — **gefiltert auf Label-Felder** ([:438](../../app/services/metaobject-sync.service.ts#L438)).

**Dieser Plan legt keine neue Prisma-Tabelle an.** Damit entfällt der GDPR-Pflichtteil (`redactShopData` + Kommentarblock) vollständig; alles Neue lebt in bestehenden shop-scoped Tabellen.

### 0.5 Plan-Gating heute

`metaobjects` ist in [plans.ts:261](../../app/config/plans.ts#L261) (Pro) und [:300](../../app/config/plans.ts#L300) (Max) enthalten, in Free/Basic nicht. Die Seite ist über `<PlanAccessGate contentType="metaobjects">` gegated. **Dieser Plan ändert die Stufe nicht: alles Neue bleibt Pro+**, weil es Fähigkeiten derselben Oberfläche sind und eine zweite Stufe innerhalb einer Seite nur erklärungsbedürftig wäre.

### 0.6 Sechs Befunde aus der Bestandsaufnahme

Alle sechs sind gegen den Code verifiziert, keiner ist eine Vermutung. Sie stehen dem Feature im Weg oder sind Verletzungen der CLAUDE.md-Invarianten und werden deshalb hier eingeplant, nicht separat vertagt.

- **B1 — Der Löschen-Knopf ist da und kann nicht funktionieren.** [UnifiedContentEditor.tsx:1518-1526](../../app/components/UnifiedContentEditor.tsx#L1518-L1526) rendert „Duplizieren"/„Löschen", sobald `createResources.length > 0`; `resourceOfItem` ([:728-736](../../app/components/UnifiedContentEditor.tsx#L728-L736)) gibt bei genau einer Create-Ressource pauschal `"metaobject"` zurück. Gesendet wird also `resourceId=metaobject_type_<type>`; [delete.actions.ts:103-105](../../app/actions/content/delete.actions.ts#L103-L105) lehnt das per `isValidShopifyGID` mit 400 ab — **nachdem** der Merchant im Dialog den Typnamen abgetippt hat. „Duplizieren" fällt auf derselben Seite still durch (`handleDuplicateItem` trifft keinen Zweig und kehrt wortlos zurück).
- **B2 — Nur die ersten 25 Einträge eines Typs sind überhaupt sichtbar.** Der Loader von `/api/metaobjects/*` paginiert mit Default `limit=25` ([api.metaobjects.$.tsx:42](../../app/routes/api.metaobjects.$.tsx#L42)) und liefert ein `pagination`-Objekt; die Seite ruft die Route **ohne Parameter** auf und wertet `pagination` nirgends aus. Ein Shop mit 60 Farben sieht 25 davon, und die Kopfzeile sagt „60 Einträge".
- **B3 — Anlegen funktioniert, ist aber blind.** Das „+" öffnet `CreateItemModal` ([UnifiedContentEditor.tsx:812-820](../../app/components/UnifiedContentEditor.tsx#L812-L820)); der Typ muss dort erneut gewählt werden, obwohl links einer selektiert ist. Nach dem Anlegen wird bewusst **nicht** selektiert ([:686-692](../../app/components/UnifiedContentEditor.tsx#L686-L692)), weil die GID zu keinem Listeneintrag passt — der neue Eintrag erscheint irgendwo in einer 25er-Liste oder gar nicht (siehe B2).
- **B4 — Der Übersetzungs-Schreibpfad prüft das Echo nicht.** [content-update.action.ts:706-708](../../app/actions/content/content-update.action.ts#L706-L708) wertet nach `translationsRegister` nur `userErrors` aus und schreibt danach die `MetaobjectTranslation`-Zeile; ebenso wird bei leerem Wert nach `translationsRemove` nur `userErrors` geprüft und die lokale Zeile gelöscht ([:663-676](../../app/actions/content/content-update.action.ts#L652-L676)). Das ist exakt der in CLAUDE.md benannte Fall („silent no-op": Shopify nimmt den Aufruf an und speichert nichts) — inklusive der ausdrücklichen Regel, bei unbestätigtem Entfernen die lokale Zeile **stehen zu lassen**.
- **B5 — `MetaobjectTranslation.type` wird vom Einzel-Editor falsch befüllt.** [content-update.action.ts:710](../../app/actions/content/content-update.action.ts#L710) setzt `type: itemId`, und `itemId` ist auf dieser Seite `metaobject_type_<type>` (ausdrücklich erlaubt in [unified-content.actions.ts:77-78](../../app/actions/unified-content.actions.ts#L77-L78)). Sync und API-Route schreiben dort den nackten Typ. Der Definitions-Stale-Delete des Sync löscht per `type: { notIn: liveTypes }` ([metaobject-sync.service.ts:115-117](../../app/services/metaobject-sync.service.ts#L115-L117)) — also genau diese Zeilen. Heute maskiert, weil derselbe Sync-Lauf die Zeile danach aus Shopify neu anlegt, **solange der Schlüssel ein Label-Feld ist**; mit Phase 3 (beliebige Feldschlüssel) fiele die Maskierung weg und es wäre echter Datenverlust im Cache.
- **B6 — `/api/metaobjects/*` hat eine zweite, tote Schreibimplementierung und kein Plan-Gate.** Die `action` der Route ([api.metaobjects.$.tsx:171-583](../../app/routes/api.metaobjects.$.tsx#L171-L583)) implementiert `loadTranslations` / `translateField` / `updateContent` ein zweites Mal (mit denselben Echo-Lücken wie B4) — **kein einziger Aufrufer im Repo** postet dorthin, nur der Loader wird benutzt. Der Loader wiederum ist direkt per GET erreichbar und prüft den Plan nicht, während die Seite Pro+ verlangt. Beides sind benannte Regeln: „Do not add parallel handlers" und „Resource routes gate themselves".

---

## 1. Zielbild und Abgrenzung

**Zielbild:** Für einen Metaobjekt-Typ sieht der Merchant eine durchsuchbare, blätterbare Liste seiner Einträge. Jeder Eintrag ist eine Karte mit **allen** Feldern, die diese App ehrlich bearbeiten kann, mit Übersetzungsspalten wie überall sonst, einem Löschen-Knopf, der die Konsequenzen benennt, und — wenn der Typ eine Farbe beschreibt — einem sichtbaren Swatch, der gesetzt werden kann.

**Abgrenzung nach oben (§9 führt es aus):** Definitionen bleiben unangetastet, das Verknüpfen eines Eintrags mit einem PRODUKT bleibt beim Produkt, und Feldtypen, für die es keinen ehrlichen Editor gibt, bekommen keinen halben.

---

## 2. Was gemessen werden muss — und was hier ausdrücklich nicht behauptet wird

Dieser Abschnitt trennt drei Sorten Aussage sauber, weil ein Plan, der eine ungeprüfte API-Form still behauptet, schlechter ist als einer, der die Frage benennt.

**Verifiziert (im Repo gelesen, läuft gegen echte Shops):**
- `metaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!)` mit `fields: [{key, value}]` und Echo über `metaobject.fields` — [content.mutations.ts:491-510](../../app/graphql/content.mutations.ts#L491-L510), benutzt in Produktion vom Bulk-Editor.
- `metaobjectCreate($metaobject: MetaobjectCreateInput!)` mit `type`, `handle`, `fields` — [content.mutations.ts:667-679](../../app/graphql/content.mutations.ts#L667-L679).
- `metaobjectDelete($id: ID!)` → `deletedId` — [content.mutations.ts:749-756](../../app/graphql/content.mutations.ts#L749-L756).
- `metaobjectDefinitions(first:)` → `fieldDefinitions { key name required type { name } validations { name value } }` — [metaobject-sync.service.ts:159-184](../../app/services/metaobject-sync.service.ts#L159-L184).
- `product.options[].optionValues[].swatch { color image { image { url } } }` und `optionValues[].linkedMetafieldValue` (die Metaobjekt-GID) sowie `option.linkedMetafield { namespace key }` — [product-options.server.ts:351-366](../../app/services/product-options.server.ts#L351-L366), [product-sync.service.ts:453-468](../../app/services/product-sync.service.ts#L453-L468).
- Metaobjekt-Übersetzungen laufen über `translatableResource(resourceId: <Metaobjekt-GID>)`, Schlüssel = **Feldschlüssel** — [translations.server.ts:65-67](../../app/services/bulk-editor/translations.server.ts#L65-L67).

**API-Wissen, im Repo NICHT belegt (vor Gebrauch prüfen, aber risikoarm):**
- `MetaobjectUpdateInput` trägt neben `fields` auch `handle`, `capabilities`, `redirectNewHandle`. Dieser Plan schreibt in Phase 3 optional den `handle`; wenn das Feld nicht existiert, entfällt genau diese eine Zeile.
- Metafield-/Metaobjekt-Feldtyp `color` ist ein Hex-String. **Das genaue Format** (`#RRGGBB`, Groß-/Kleinschreibung, Alpha erlaubt?) wird gemessen, nicht angenommen — siehe M2.
- `metaobjectBulkDelete` existiert. Wird hier nicht benutzt (§9).

**Vermutung, ausdrücklich als solche markiert (Phase 0 misst sie):**
- **V1:** Eine Dritt-App mit `write_metaobjects` darf Einträge einer **Shopify-STANDARD-Definition** (`shopify--…`) anlegen/ändern/löschen. Plausibel, weil Merchants dasselbe im Admin tun — aber Standard-Definitionen tragen ein `access { admin storefront }`-Regime, und ob unsere App darunter fällt, ist nicht dokumentierbar entscheidbar.
- **V2:** Die Standard-Farbdefinition heißt `shopify--color-pattern` und trägt ein Label-Feld, ein Feld vom Typ `color` und ein Bildfeld (`file_reference`). Die einzige Repo-Spur ist ein Testwert für `linkedMetafieldKey` ([tests/unit/product-options.server.test.ts:228](../../tests/unit/product-options.server.test.ts#L228)) — und der beschreibt die **Metafield**-Namespace/Key-Kombination, nicht den Definitionstyp.
- **V3:** `ProductOptionValue.swatch` wird von Shopify **aus** diesen Feldern abgeleitet, d. h. unser `metaobjectUpdate` auf das Farbfeld ändert den Swatch im Shop.
- **V4:** Es gibt eine Rückwärts-Beziehung (`Metaobject.referencedBy` o. ä.), über die sich live zählen lässt, welche Produkte einen Eintrag verwenden.
- **V5:** Was beim Löschen eines verlinkten Eintrags passiert. Drei mögliche Welten, und der Unterschied ist gewaltig: **(a)** Shopify verweigert mit `userError`, **(b)** Shopify löscht, der Optionswert verschwindet und die zugehörigen Varianten werden mitgelöscht (das wäre derselbe Schaden, den [product-options.server.ts:9-21](../../app/services/product-options.server.ts#L9-L21) beim Löschen von Optionswerten beschreibt: Bestand, Preise, SKUs, Bildzuordnungen weg), **(c)** Shopify löscht und lässt einen toten Verweis stehen.

**Bis V5 gemessen ist, nimmt die Oberfläche (b) an** und sagt das so. Das ist die einzige Annahme, bei der ein Irrtum den Merchant nichts kostet.

**Was NICHT gemessen werden muss, obwohl es so aussieht:** Welche Felder eine Definition wirklich hat, steht bereits im eigenen Cache (`MetaobjectDefinition.fieldDefinitions`, vom Sync aus `metaobjectDefinitions` befüllt — Standard-Definitionen inklusive, der Sync filtert nichts). Die Probe bestätigt das nur gegen die Live-API, sie ist nicht die einzige Quelle.

---

## 3. Phase 0 — Messung: `/api/metaobject-probe`

**Unabhängig auslieferbar:** ja, es ist ein Dev-Diagnosewerkzeug ohne Produktoberfläche.

### 3.1 Was sie tut

Neue Route [api.metaobject-probe.tsx] nach dem Muster von [api.collection-model-probe.tsx](../../app/routes/api.collection-model-probe.tsx), eingehängt als vierter Unter-Tab in [SettingsProbesTab.tsx](../../app/components/SettingsProbesTab.tsx) („Metaobjects"), mit eigenem Gate wie die drei bestehenden. Vier Schritte, jeder einzeln auslösbar:

1. **Lesen (schreibfrei).** Alle `metaobjectDefinitions` mit `id, type, name, access { admin storefront }, capabilities { translatable { enabled } publishable { enabled } }, createdByApp { handle }, fieldDefinitions { key name required type { name } validations { name value } }`. Antwort tabellarisch, Standard-Definitionen (`type` beginnt mit `shopify--`) markiert. Beantwortet **V2** und liefert die Datengrundlage für V1.
2. **Beispielwerte (schreibfrei).** Für eine gewählte Definition die ersten Einträge mit `fields { key value type }` plus `translatableResource(resourceId:).translatableContent { key digest }`. Beantwortet **M2** (echtes Format eines `color`-Werts, echter Aufbau eines `file_reference`-Werts) und zeigt, **welche Feldschlüssel Shopify überhaupt als übersetzbar meldet**.
3. **Schreibtest auf einer Standard-Definition (destruktiv, aber selbstaufräumend).** `metaobjectCreate` eines Wegwerf-Eintrags in `shopify--color-pattern` → `metaobjectUpdate` (Farbfeld setzen) → erneutes Lesen → `metaobjectDelete`. Beantwortet **V1** und **V3** (nachdem der Eintrag existiert: hat er in irgendeinem Produkt einen Swatch? — nein, er ist unverlinkt; V3 wird deshalb in Schritt 4 mitgemessen).
4. **Verknüpfungs- und Löschtest (destruktiv, opt-in, eigener Knopf).** Wegwerf-**Produkt** anlegen, dessen Farboption per `linkedMetafield` auf die Standard-Definition zeigt und einen Wert per `linkedMetafieldValue` auf den Wegwerf-Eintrag setzt; dann `product.options[].optionValues[].swatch` lesen (**V3**), `referencedBy` am Metaobjekt abfragen (**V4**), danach den Eintrag löschen und Produkt + Varianten erneut lesen (**V5**). Zum Schluss Produkt löschen.

### 3.2 Regeln, die die Probe einhalten muss

Übernommen aus [api.collection-model-probe.tsx:22-40](../../app/routes/api.collection-model-probe.tsx#L22-L40), weil sie dort schon einmal teuer gelernt wurden:

- **Ein FEHLGESCHLAGENER Aufruf ist nie eine NEGATIVE Antwort.** Jede Aussage trägt `missing` (die API hat geantwortet, es gibt das nicht) und `error` (wir haben keine Antwort bekommen) als **getrennte** Zustände. Ein gedrosselter Request darf nicht als „Standard-Definitionen sind schreibgeschützt" gelesen werden und Phase 4 umplanen.
- **Leere Ergebnisse sind keine Evidenz.** Speziell hier: `translatableContent` listet nur Schlüssel, die einen **Primärwert haben** (CLAUDE.md-Falle). Schritt 2 muss deshalb einen Eintrag wählen, dessen Felder tatsächlich gefüllt sind — `pickWithImage` in [api.translation-probe.tsx](../../app/routes/api.translation-probe.tsx) macht genau das und ist das Vorbild.
- **Dev-only, ganze Route**, direkt POST-erreichbar ⇒ Gate in der Route, nicht nur im Tab.
- **Aufräumen im `finally`**, und was nicht aufgeräumt werden konnte, wird mit GID **berichtet** statt verschwiegen.

### 3.3 Ergebnisdokument

Das Messergebnis wird als Tabelle in §2 dieses Plans nachgetragen (mit Datum und Shop-Typ), damit V1–V5 danach nicht mehr Vermutungen sind. **Fällt V1 negativ aus** (Standard-Definitionen für uns nicht schreibbar), ändert das Phase 4 grundlegend: dann kann die App Farb-Einträge nur **anzeigen**, und der ehrliche Ausgang ist ein erklärender Hinweis plus Deep-Link in den Shopify-Admin — nicht ein Editor, dessen Speichern immer scheitert. Phase 4 beschreibt beide Ausgänge (§6.5).

**Bewusst NICHT in Phase 0:** Marktspezifische (`marketId`) Metaobjekt-Übersetzungen. Der Sync liest sie bereits markt-bewusst ([metaobject-sync.service.ts:391-393](../../app/services/metaobject-sync.service.ts#L391-L393)); dieser Plan ändert daran nichts und misst deshalb auch nichts nach.

---

## 4. Phase 1 — Der Eintrag wird ein Objekt: Liste, Suche, Anlegen

**Unabhängig auslieferbar:** ja. Nichts hieran ist destruktiv, und Phase 0 ist keine Voraussetzung.

### 4.1 Was es tut

- **Die Item-Liste bleibt die TYP-Liste.** Bewusst: Typen sind zweistellig, Einträge können vierstellig sein, und `?select=`, `registerItems` (Mobile) sowie die Deep-Links aus dem Produkt-Editor hängen alle an der Typ-Ebene. Ein Drill-Down in derselben Spalte würde alle drei brechen, um ein Problem zu lösen, das die Editorfläche besser löst.
- **Die Editorfläche wird eine Eintragsliste.** Statt N nackter Textfelder: N **Eintragskarten**, jede mit Titel (Label-Feld), `handle` als Untertitel, ausklappbarem Feldbereich (Phase 3 füllt ihn) und einer Aktionszeile. Zusammengeklappt ist eine Karte optisch das, was heute die Zeile ist — der Umstieg kostet den Merchant nichts.
- **Suche + Blättern über die Einträge** (behebt **B2**): Die Seite reicht `page`, `limit`, `search` an `/api/metaobjects/<type>` durch, das sie [seit jeher akzeptiert](../../app/routes/api.metaobjects.$.tsx#L39-L44), und rendert die mitgelieferte `pagination`.
- **„Eintrag hinzufügen"** direkt am Typ: öffnet `CreateItemModal` mit `prefill: { type: <aktueller Typ> }`. Der Typ-Picker bleibt sichtbar (der Merchant darf umentscheiden), ist aber vorbelegt. Nach Erfolg: Einträge des Typs neu laden, zur Seite mit dem neuen Eintrag springen und die Karte markieren — statt heute stiller Nichtselektion (**B3**).
- **Aufräumen im Weg (B1/B6):** Typ-Ebene bekommt keine „Löschen"/„Duplizieren"-Knöpfe mehr (Bedingung in [UnifiedContentEditor.tsx:1518](../../app/components/UnifiedContentEditor.tsx#L1518) und [:1337](../../app/components/UnifiedContentEditor.tsx#L1337) auf `resourceOfItem(selectedItem.id) !== null` umstellen; `resourceOfItem` liefert für `metaobject_type_*`-IDs `null`). Die tote `action` in [api.metaobjects.$.tsx:171-583](../../app/routes/api.metaobjects.$.tsx#L171-L583) wird **gelöscht** — sie ist der zweite Schreibpfad, den CLAUDE.md verbietet, und sie ist genau der Ort, an dem ein späterer Umbau versehentlich landen würde. Der Loader bekommt ein Plan-Gate (`canAccessContentType`/`meetsPlan`) in der Route.

### 4.2 Dateien

| Datei | Änderung |
|---|---|
| [app/routes/app.metaobjects.tsx](../../app/routes/app.metaobjects.tsx) | Paging-/Suchzustand, Fetch mit Parametern, Prefill für „+", Nachladen nach Create |
| [app/routes/api.metaobjects.$.tsx](../../app/routes/api.metaobjects.$.tsx) | tote `action` entfernen, Plan-Gate im Loader |
| `app/components/metaobjects/MetaobjectEntryCard.tsx` (neu) | Eintragskarte (Kopf, Aktionen, Feldbereich) |
| `app/components/metaobjects/MetaobjectEntryList.tsx` (neu) | Liste + Suche + Pagination über die Karten |
| [app/components/UnifiedContentEditor.tsx](../../app/components/UnifiedContentEditor.tsx) | Knopf-Bedingung auf `resourceOfItem(...)` |
| [app/i18n/de.ts](../../app/i18n/de.ts), [en.ts](../../app/i18n/en.ts), [es.ts](../../app/i18n/es.ts) | neue Strings, **alle drei** |

### 4.3 GraphQL

Keins. Phase 1 ist reine Oberfläche über bestehende Loader plus den ausgelieferten Create-Pfad.

### 4.4 Fehlermodi

- **Nachladen scheitert:** Karte(n) zeigen den Fehler, nicht „keine Einträge". Ein leeres Ergebnis nach einem Fehler ist keine Aussage über den Shop — dieselbe Regel wie in [useCreateItem.ts:170-180](../../app/hooks/useCreateItem.ts#L170-L180).
- **Create erfolgreich, Cache-Sync fehlgeschlagen** (`synced: false`): Der bestehende Pfad meldet das bereits ([create.actions.ts:336-345](../../app/actions/content/create.actions.ts#L336-L345)). Die Seite darf dann **nicht** auf den Eintrag springen — sie zeigt den Hinweis mit „Neu laden".
- **Definition nicht anlegbar** (`requiredUnknown` / `unsupportedRequiredType`): Wird schon heute mit Begründung ausgegeben ([api.create-options.tsx:18-20](../../app/routes/api.create-options.tsx#L18-L20)) — `requiredUnknown` ist eine „vor Phase 0 gecachte Definition"-Zeile und führt zu **Reload anbieten**, nie zu „optional".

### 4.5 Bewusst NICHT in Phase 1

- Kein Umbau der Item-Liste auf zwei Ebenen (Begründung oben).
- Kein Duplizieren von Einträgen. Es gibt keine Shopify-Duplikat-Mutation dafür, und ein „Kopie anlegen" wäre ein zweiter Create-Pfad für einen Nutzen, den „Anlegen + Felder abtippen" schon deckt.

### 4.6 Zu messen

Nichts. Phase 1 behauptet keine API-Form.

---

## 5. Phase 2 — Einträge entfernen (der destruktive Pfad)

**Unabhängig auslieferbar:** ja — **setzt Phase 0 und Phase 1 voraus.** Ohne die Messung V5 wird der Knopf ausgeliefert, aber bei Verwendungen > 0 gesperrt (§5.4).

### 5.1 Was es tut

Löschen-Knopf **pro Eintragskarte** (nicht pro Typ). Er ruft den ausgelieferten `deleteContent`-Pfad mit der echten Metaobjekt-GID auf; damit greifen automatisch Echo-Regel (`deletedId`), Cache-Purge inkl. `MetaobjectTranslation` und der zweistufige Dialog mit Namenseingabe.

**Vor dem Dialog** wird gezählt, wer den Eintrag benutzt — und das Ergebnis ist dreiwertig, nicht zweiwertig:

```
countLinkedOptionUsage(db, shop, metaobjectGid)
  -> { known: false }                       // Produkt-Cache ist leer -> UNBEKANNT
  -> { known: true, products: n, options: m } // aus ProductOption.values (linkedValue)
```

Die Quelle ist der bestehende Cache: `ProductOption.values` speichert je Wert `{ id, name, linked, linkedValue }`, wobei `linkedValue` die Metaobjekt-GID ist ([product-sync.service.ts:459-466](../../app/services/product-sync.service.ts#L459-L466), [product-options.server.ts:168-175](../../app/services/product-options.server.ts#L168-L175)). Ein `contains`-Filter auf der Textspalte plus exakte Nachprüfung des geparsten JSON.

**Die Unterscheidung „0" vs. „unbekannt" ist der Kern dieser Phase** und folgt derselben Regel wie `attributesSyncedAt`: Wenn der Shop keine Produkte im Cache hat (oder der letzte Produkt-Sync unbekannt ist), heißt das **nicht** „wird nirgends verwendet", sondern „wir wissen es nicht". Dann bietet der Dialog einen Produkt-Sync an, statt eine beruhigende Null zu zeigen.

Zusätzlich **eine Live-Gegenprobe** vor dem Schreiben (dieselbe Logik wie „Der Cache ist eine Vermutung, Shopify ist die Wahrheit"): Wenn Phase 0 **V4** bestätigt hat, wird die Rückwärtsbeziehung live abgefragt und ihr Ergebnis schlägt den Cache. Scheitert die Live-Abfrage, gilt wieder **unbekannt** — nicht der Cachewert.

### 5.2 Dateien

| Datei | Änderung |
|---|---|
| `app/services/metaobject-usage.server.ts` (neu) | `countLinkedOptionUsage` (Cache) + optionale Live-Gegenprobe, dreiwertiges Ergebnis |
| [app/components/create/DeleteItemModal.tsx](../../app/components/create/DeleteItemModal.tsx) | zusätzliche Konsequenzzeile + „unbekannt"-Zustand + Sperre |
| `app/components/metaobjects/MetaobjectEntryCard.tsx` | Löschen-Knopf, Zählung anfordern |
| [app/actions/content/delete.actions.ts](../../app/actions/content/delete.actions.ts) | serverseitige Wiederholung der Zählung + Sperre (der Client ist nur UI) |
| i18n de/en/es | Konsequenztexte |

### 5.3 GraphQL

`metaobjectDelete` (bereits vorhanden). Für die Live-Gegenprobe die in Phase 0 bestätigte Rückwärtsbeziehung — **ihr Name steht in diesem Plan bewusst nicht**, weil er nicht verifiziert ist (V4).

### 5.4 Fehlermodi und Regeln

- **Echo entscheidet.** Ohne `deletedId` wird lokal nichts entfernt — steht schon so im ausgelieferten Pfad und wird nicht aufgeweicht.
- **Verwendungen > 0:** Der Dialog benennt die Zahl **und** was daran hängt. Solange V5 nicht gemessen ist, ist der Knopf in diesem Fall **gesperrt** mit dem Hinweis, den Wert zuerst am Produkt zu entfernen. Nach der Messung: bei (a) Verweigerung durch Shopify reicht die Anzeige; bei (b) Variantenverlust bleibt es bei einer zweiten, ausformulierten Bestätigung, die die Zahl der betroffenen Varianten nennt; bei (c) totem Verweis eine Warnung plus Empfehlung.
- **Verwendungen unbekannt:** gesperrt, mit „Produkte synchronisieren"-Angebot. Ein Löschen ohne Wissen über die Folgen ist genau das, was dieser Abschnitt verhindern soll.
- **Nie `window.confirm`.** Polaris-`Modal`, zweistufig, wie ausgeliefert.
- **Die Sperre lebt auch im Server.** `/…/deleteContent` ist direkt POST-erreichbar; eine reine Client-Sperre ist keine.

### 5.5 Bewusst NICHT in Phase 2

- Kein Mehrfach-/Bulk-Löschen. `metaobjectBulkDelete` existiert, aber eine Massenlöschung von Werten, an denen Varianten hängen, ist die eine Operation, bei der ein Fehlklick nicht reparabel ist.
- Kein automatisches „Wert vorher aus allen Produkten entfernen". Das ändert die Variantenmatrix fremder Produkte in einem Dialog, der „Eintrag löschen" heißt.

### 5.6 Zu messen

**V4 und V5** (Phase 0, Schritt 4). Ohne sie ist Phase 2 ausliefer**bar**, aber im verwendeten Fall gesperrt — und das ist die ehrliche Zwischenstufe, nicht ein halbes Feature.

---

## 6. Phase 3 — Alle bearbeitbaren Felder eines Eintrags, mit Übersetzungsparität

**Unabhängig auslieferbar:** ja, setzt Phase 1 voraus. **System-relevant** (Schreibpfad + Übersetzungslogik) ⇒ Review-Durchlauf zwingend (§10).

### 6.1 Was es tut

Die Eintragskarte zeigt **jedes** Feld der Definition, das diese App ehrlich bearbeiten kann — dieselbe Menge, die der Bulk-Editor schon kennt (`single_line_text_field`, `multi_line_text_field`, `list.single_line_text_field`; `rich_text_field` **lesend**), plus in Phase 4 `color` und `file_reference`. Alles andere wird **angezeigt als „nicht hier bearbeitbar"** mit Feldname und Typ — nicht verschwiegen: ein Feld, das lautlos fehlt, sieht aus wie ein Bug, eines mit Begründung ist eine Erklärung (dieselbe Regel wie bei den nicht anlegbaren Definitionen).

**Der tragende Umbau ist der Feldschlüssel.** Heute ist er die Metaobjekt-GID; er wird zu `<Metaobjekt-GID>#<Feldschlüssel>`:

- Kollisionsfrei: Shopify-Feldschlüssel enthalten kein `#`, GIDs auch nicht ⇒ Split am ersten `#`.
- Der Server-Scan in [content-update.action.ts:492-497](../../app/actions/content/content-update.action.ts#L492-L497) (`key.startsWith("gid://shopify/Metaobject/")`) trifft weiterhin.
- `MetaobjectTranslation` trägt den Feldschlüssel **bereits** im Unique-Key ⇒ **keine Migration**. Der Loader emittiert `key: "<metaobjectId>#<key>"` statt `key: metaobjectId` ([api.metaobjects.$.tsx:113-126](../../app/routes/api.metaobjects.$.tsx#L113-L126)), inklusive `marketTranslations`.
- Nicht übersetzbare Felder (`color`, `file_reference`, Zahlen) bekommen `translationKey: ""`. Das ist kein Detail: `resolve()` kürzt `""` auf den Primärwert ab — ohne das würde ein Farbfeld in einer Fremdsprache als leer aufgelöst und beim Speichern gelöscht. Genau diese Regel steht in CLAUDE.md für die Merchandising-Attribute, und sie gilt hier wortgleich.

**Ein Schreibpfad statt zwei.** Die Feldschreibung wandert in ein gemeinsames `app/services/metaobject-write.server.ts` mit `writeMetaobjectFields(gateway, shop, id, writes[])`, das genau die Semantik von [persistMetaobjectRow](../../app/services/bulk-editor/apply.server.ts#L1552-L1670) trägt: ein `metaobjectUpdate` für alle Felder, Schema-Fehler und `userErrors` getrennt behandelt, **Echo pro Feldschlüssel**, Spiegelung von `fields`+`displayName` nur für bestätigte Felder, Invalidierung der fremdsprachigen Zeilen für genau diese Schlüssel. Bulk-Editor und Einzel-Editor rufen dasselbe auf — das ist das `writeMediaAltText`-Muster, nicht ein neuer Parallelpfad.

**Übersetzungen bekommen Parität und die fehlenden Echos (B4):**
- Registrieren gilt erst als erfolgreich, wenn Shopify die Schlüssel **zurückgibt**; die DB-Zeile wird sonst nicht geschrieben.
- Entfernen gilt erst als erfolgreich, wenn Shopify die Entfernung **bestätigt**; sonst bleibt die lokale Zeile stehen.
- `MetaobjectTranslation.type` wird der **nackte** Typ (B5) — mit einer Reparaturzeile, die vorhandene `metaobject_type_*`-Werte beim nächsten Schreiben korrigiert.
- Der Sync-Filter auf Label-Felder ([metaobject-sync.service.ts:438](../../app/services/metaobject-sync.service.ts#L438)) fällt weg: gespiegelt wird, was Shopify als übersetzbar meldet. **Vorsicht mit der Umkehrung:** dass ein Schlüssel dort fehlt, heißt nur, dass er **keinen Primärwert hat** — daraus darf nie „nicht übersetzbar" geschlossen werden (CLAUDE.md-Falle, siehe §3.2).

**Sprach-Regeln:** Pro Feld ein Übersetzen-Knopf; bei einem Ein-Sprachen-Shop bleibt er **sichtbar und deaktiviert** mit `t.common.requiresSecondLanguage` über `DisabledActionTooltip` — der Hinweis kommt aus `useSingleLocaleHint()`, nicht aus Props. Die Sprachleiste selbst verschwindet bereits über `shouldRenderLanguageBar()` und wird nicht angefasst.

### 6.2 Dateien

| Datei | Änderung |
|---|---|
| `app/services/metaobject-write.server.ts` (neu) | gemeinsamer, echo-geprüfter Feldschreiber |
| [app/services/bulk-editor/apply.server.ts](../../app/services/bulk-editor/apply.server.ts) | `persistMetaobjectRow` ruft den gemeinsamen Schreiber |
| [app/actions/content/content-update.action.ts](../../app/actions/content/content-update.action.ts) | Metaobjekt-Zweig auf Verbundschlüssel, gemeinsamen Schreiber, Echo bei Register/Remove, `type`-Fix |
| [app/config/content-fields.config.tsx](../../app/config/content-fields.config.tsx) | `getFieldDefinitions`/`getFieldValue` je Eintrag × Feld |
| [app/routes/api.metaobjects.$.tsx](../../app/routes/api.metaobjects.$.tsx) | Übersetzungen mit Verbundschlüssel ausliefern |
| [app/services/metaobject-sync.service.ts](../../app/services/metaobject-sync.service.ts) | Label-Filter entfernen |
| `app/components/metaobjects/MetaobjectEntryCard.tsx` | Feldbereich |
| i18n de/en/es | Feldtyp-Hinweise |

### 6.3 GraphQL

`metaobjectUpdate` (verifiziert), `translationsRegister` / `translationsRemove` / `translatableResource` (im Repo in Gebrauch). **Hygiene-Pflicht:** `#graphql`-Dokumente tragen **keine Kommentare und kein Nicht-ASCII** — die Erklärung gehört in einen `//`-Kommentar neben das Template. [graphql-document-hygiene.test.ts](../../tests/unit/graphql-document-hygiene.test.ts) prüft das; ein `§` oder Gedankenstrich im Dokument hat diese App schon einmal lahmgelegt.

### 6.4 Fehlermodi

- **Teilerfolg ist normal.** Fehler sind **pro Feld**, nie „die ganze Karte" — dieselbe Regel wie `BulkFailure.columnId`. Ein von Shopify abgelehntes Feld bleibt rot und markiert, die übrigen sind gespeichert.
- **Leeren eines Feldes:** `""` löscht den Wert. Der bestehende Pauschal-Block für leere Primärwerte ([content-update.action.ts:521-533](../../app/actions/content/content-update.action.ts#L521-L533)) wird auf das **Label-Feld** eingeschränkt (ein Eintrag ohne Anzeigenamen ist unauffindbar); für alle anderen entscheidet Shopifys Pflichtfeld-Validierung, deren `userError` sichtbar wird. `required === undefined` bleibt **unbekannt** und wird nie als „optional" gelesen.
- **Cache-Zeile fehlt** (Eintrag nicht im lokalen Cache): abbrechen mit „erst synchronisieren", wie im Bulk-Pfad.
- **`rich_text_field`:** lesend, mit Hinweis. Ein halber Rich-Text-Editor, der die JSON-Struktur beschädigt, ist schlimmer als kein Editor.

### 6.5 Bewusst NICHT in Phase 3

- **Kein Ändern des `handle`** eines Eintrags in dieser Phase. Der Handle eines Metaobjekts kann in Themes und in `metaobject_reference`-Werten referenziert sein; die Redirect-Maschinerie aus [handle-redirect.shared.ts](../../app/services/seo/handle-redirect.shared.ts) deckt Storefront-Pfade ab, nicht Metaobjekt-Referenzen. Verschoben, nicht vergessen.
- **Keine KI-Generierung** für Metaobjekt-Felder. Der bestehende Zweig setzt `supportsAI: false`; das bleibt, bis jemand sagen kann, was „generiere eine Farbe" bedeuten soll.
- **Keine Referenzfelder** (`metaobject_reference`, `product_reference`, …). Sie brauchen je einen eigenen Picker; `file_reference` kommt in Phase 4, weil dort der Picker schon existiert.

### 6.6 Zu messen

Nur indirekt: Schritt 2 der Probe zeigt, **welche Feldschlüssel Shopify pro Definition als übersetzbar meldet** — und damit, ob die Aufhebung des Label-Filters mehr Schlüssel liefert als erwartet. Das ist eine Bestätigung, keine Voraussetzung.

---

## 7. Phase 4 — Farbe und Swatch

**Unabhängig auslieferbar:** ja, setzt Phase 3 voraus. **Hängt in seiner Gestalt an Phase 0 (V1).**

### 7.1 Was es tut (wenn V1 positiv ist)

- **Feldtyp `color`** bekommt einen echten Editor: ein natives Farbfeld plus ein Hex-Textfeld, beide auf denselben Wert. Validierung mit dem **bereits vorhandenen** `HEX`-Muster aus [product-option-swatch.shared.ts:48](../../app/services/product-option-swatch.shared.ts#L48) — kein zweites Regex, das driften kann. Ungültige Eingabe wird abgelehnt, bevor sie an Shopify geht.
- **Feldtyp `file_reference`** bekommt den vorhandenen `FilePickerModal` (`initialKind: "image"`, `uploadCommitMode: "queue"`): Bibliothek durchsuchen oder neu hochladen über die ausgelieferte Staged-Upload-Kette. Geschrieben wird die Datei-GID als Feldwert.
- **Swatch-Vorschau** in der Kartenkopfzeile: `resolveSwatch` entscheidet, was gezeigt wird — Bild vor Farbe, und **nichts**, wenn nichts ehrlich auflösbar ist. Der Kommentarkopf dieser Datei begründet, warum kein Name→Hex-Wörterbuch dazukommt; das bleibt so.
- **Beides sind normale Felder**, gehen also durch denselben echo-geprüften `writeMetaobjectFields`. Kein Sonderpfad, keine zweite Mutation.

### 7.2 Was es tut, wenn V1 negativ ist

Dann sind Standard-Definitionen für diese App nur lesbar. Die Karte zeigt Farbe und Swatch **an**, die Felder sind gesperrt, und statt eines Speichern-Knopfes steht dort die Erklärung plus ein Deep-Link in den Shopify-Admin auf genau diesen Eintrag. **Eigene** (merchant-definierte) Farb-Definitionen bleiben voll editierbar — die Sperre hängt an der Definition, nicht am Feldtyp.
Diese Verzweigung wird **implementiert, nicht weggelassen**: `access.admin` je Definition liegt nach Phase 0 im Cache (bzw. wird beim Definitions-Sync mitgeholt), und ein Editor, der nur auf manchen Definitionen speichern kann, muss das vorher sagen, nicht beim Fehlschlag.

### 7.3 Dateien

| Datei | Änderung |
|---|---|
| `app/components/metaobjects/ColorFieldEditor.tsx` (neu) | Farbwähler + Hex-Feld, Validierung über das bestehende Muster |
| `app/components/metaobjects/SwatchPreview.tsx` (neu) | Vorschau über `resolveSwatch` |
| `app/components/metaobjects/MetaobjectEntryCard.tsx` | Felder einhängen, Kopfzeile |
| [app/services/metaobject-sync.service.ts](../../app/services/metaobject-sync.service.ts) | `access`/`capabilities` je Definition mitsyncen (für §7.2) |
| [prisma/schema.prisma](../../prisma/schema.prisma) | **eine** Spalte auf `MetaobjectDefinition` (Zugriffsregime), nullable ⇒ `null` = **unbekannt**, nicht „schreibbar" |
| i18n de/en/es | Feldlabels, Erklärung des Lesemodus |

Die eine neue Spalte ist eine bewusste Ausnahme von „kein neues Modell": Sie ersetzt eine Live-Abfrage pro Kartenaufbau. Sie folgt der `attributesSyncedAt`-Regel — **`null` heißt unbekannt** und führt zu „Reload anbieten", niemals zu einer stillen Annahme in die eine oder andere Richtung.

### 7.4 Fehlermodi

- **Ungültiger Hex-Wert:** clientseitig abgefangen; serverseitig noch einmal geprüft, weil die Action direkt POST-erreichbar ist.
- **Bild gelöscht/nicht referenzierbar:** Shopifys `userError` wird pro Feld sichtbar; die Vorschau fällt auf „kein Swatch" zurück, statt ein kaputtes Bild zu zeigen.
- **Farbe gesetzt, aber der Storefront-Swatch ändert sich nicht:** Das ist **V3** und wird gemessen, nicht behauptet. Fällt V3 negativ aus, sagt die Oberfläche, dass sie das Metaobjekt-Feld ändert und der Storefront-Swatch anderswo herkommt — und §9 bekommt einen Eintrag mehr.

### 7.5 Bewusst NICHT in Phase 4

- **Keine Farbnamen-Bibliothek.** Begründet in [product-option-swatch.shared.ts:19-24](../../app/services/product-option-swatch.shared.ts#L19-L24): ein selbstbewusst falscher Swatch ist schlimmer als keiner.
- **Kein `list.color`.** Erst, wenn eine reale Definition ihn benutzt.
- **Kein Anlegen der Standard-Definition**, wenn sie im Shop fehlt (das wäre `write_metaobject_definitions`, §9).

### 7.6 Zu messen

**V1, V2, V3** — Phase 0, Schritte 1–4. Ohne V1 ist die Gestalt dieser Phase offen; ohne V2 ist nicht sicher, welches Feld der Swatch ist; ohne V3 ist nicht sicher, dass das Schreiben im Shop ankommt, wo der Merchant es erwartet.

---

## 8. Phase 5 — Der Deep-Link aus dem Produkt-Editor trifft den richtigen Typ

**Unabhängig auslieferbar:** ja, hängt an keiner anderen Phase. Klein.

**Der Anlass:** [OptionsField.tsx:197-199](../../app/components/unified/OptionsField.tsx#L197-L199) übergibt `option.linkedMetaobjectType`, das in Wahrheit `linkedMetafieldKey` ist — also `namespace--key` des **Metafelds** (`shopify--color-pattern`), nicht der Metaobjekt-Definitionstyp. Die Zielseite gleicht diese Zeichenkette gegen `type` / `title` / `definitionName` ab ([app.metaobjects.tsx:164-173](../../app/routes/app.metaobjects.tsx#L164-L173)). Für die Standard-Farbe stimmen beide Schreibweisen vermutlich zufällig überein; für eine eigene Option (`custom--stoff` → Definitionstyp `stoff`) nicht, und die Vorauswahl greift still daneben — der Merchant landet auf der Metaobjekt-Seite ohne ausgewählten Typ und weiß nicht, warum.

**Die Auflösung braucht keine neue API-Frage.** Jeder verknüpfte Optionswert trägt in `linkedValue` bereits die Metaobjekt-GID ([product-sync.service.ts:459-466](../../app/services/product-sync.service.ts#L459-L466)); ein Blick in den `Metaobject`-Cache liefert den echten `type`. Schlägt das fehl (Eintrag nicht gecacht), bleibt die heutige Zeichenkette als Rückfall — eine verfehlte Vorauswahl, nie eine falsche.

**Dazu, wenn Phase 1 steht:** Der Deep-Link kann zusätzlich `?entry=<GID>` tragen und die Eintragskarte direkt aufschlagen. Erst mit der Eintragsebene sinnvoll, deshalb hier nur notiert.

**Fehlermodi:** Ein leerer Cache ist keine Aussage über den Shop — er führt zum Rückfall, nicht zu einer Fehlermeldung.

**Bewusst NICHT:** Optionswerte im Produkt-Editor **anlegen**, indem ein Metaobjekt-Eintrag verknüpft wird (`optionValuesToAdd` mit `linkedMetafieldValue`). Das verändert die Variantenmatrix und gehört zu [product-options.server.ts](../../app/services/product-options.server.ts) — ein eigenes Vorhaben mit eigener Bestätigungslogik, siehe §9.

---

## 9. Nicht-Ziele (ausdrücklich)

1. **Metaobjekt-DEFINITIONEN anlegen, ändern, löschen.** Braucht `write_metaobject_definitions` ⇒ Re-Consent aller Merchants. Wenn das je kommt, dann **in einem Deploy mit allen anderen dann fälligen Scopes**, nicht als Beiwerk dieses Plans.
2. **Einen Metaobjekt-Eintrag einem Produkt als Optionswert hinzufügen oder entfernen.** Verändert die Variantenmatrix (Varianten entstehen bzw. verschwinden mitsamt Bestand und Preisen). Gehört zum Produkt, nicht in die Metaobjekt-Verwaltung.
3. **Massenlöschen** von Einträgen (§5.5).
4. **Rich-Text- und Referenzfeld-Editoren** außer `file_reference` (§6.5).
5. **Metaobjekte im Bulk-Editor anlegen/löschen.** Der Bulk-Editor ist ein Diff über bestehende Zeilen; Anlegen und Löschen sind dort eine andere Operation, und `applyBulkDiff` bleibt der eine Schreibpfad für das, was er heute ist.
6. **Ein eigener Task-Typ.** Alles hier schreibt synchron im Request; es entsteht kein `Task`-Eintrag, also auch kein Eintrag in `LONG_RUNNING_TASK_TYPES`.
7. **Handle-Umbenennung mit Redirect** für Metaobjekte (§6.5).

---

## 10. Reihenfolge, Abhängigkeiten, Review-Pflicht

```
Phase 0 (Messung) ──┬─────────────► Phase 2 (Löschen)      [V4, V5]
                    └─────────────► Phase 4 (Farbe/Swatch)  [V1, V2, V3]

Phase 1 (Eintragsebene) ─► Phase 3 (Felder) ─► Phase 4
Phase 5 (Deep-Link)      ── unabhängig, jederzeit
```

Empfohlene Auslieferungsreihenfolge: **0 → 1 → 3 → 2 → 4 → 5**. Phase 3 vor Phase 2, weil Feldbearbeitung ungefährlich ist und den größeren Teil der Beschwerde erledigt, während Phase 2 auf ein Messergebnis wartet. Phase 5 kann jederzeit dazwischen, sie ist klein und berührt nichts von alledem — sie wird nur dann angenehmer, wenn Phase 1 schon steht (`?entry=`).

**Review-Pflicht (Arbeitsvereinbarung in CLAUDE.md):** Die Phasen **2, 3 und 4** sind system-relevant — Schreibpfad, Übersetzungslogik, Plan-Gating, geteilte Komponenten, in Phase 4 zusätzlich eine Migration. Jede von ihnen endet nach grünem `npm run typecheck` und `npm run test` mit einem unabhängigen Review-Durchlauf (`/code-review high` auf dem Branch), dessen Befunde **behoben** werden, bevor die Phase als fertig gemeldet wird; ein Befund, der ein Fehlalarm ist, wird begründet, nicht stillschweigend fallengelassen. Phase 0, 1 und 5 sind kleiner, aber Phase 1 löscht einen Routen-Handler und ändert ein Plan-Gate — also ebenfalls mit Review.

**Layout:** Es entsteht **keine neue Breitenzahl**. Die Seite läuft über den `UnifiedContentEditor` mit `showItemSidebar: false` und bekommt damit `.app-page-width-start`; die Typenliste spendiert `--app-list-column-width`. Keine Komponente dieses Plans schreibt eine Pixelzahl für Seiten- oder Spaltenbreite.

**i18n:** Jeder neue String landet in **allen drei** Dateien (`de`, `en`, `es`). Meldungen, die aus dem Server kommen (Löschkonsequenzen, Feldfehler), reisen als **Codes**, nicht als Sätze — dieselbe Regel wie bei den Handle-Redirect-Notizen.

---

## 11. Tests (Pflicht pro Phase)

| Phase | Unit | Integration |
|---|---|---|
| 0 | Trennung `missing` vs. `error` in der Auswertung | — (Probe wird von Hand gefahren) |
| 1 | Verbund aus Paging + Suche; `resourceOfItem` liefert `null` für `metaobject_type_*` | Loader-Gate: Free/Basic bekommt 403 auf `/api/metaobjects/*` |
| 2 | `countLinkedOptionUsage`: 0 vs. unbekannt vs. n; JSON-Parsing kaputter `values`-Zeilen | Löschen ohne `deletedId` ⇒ Cache bleibt; Sperre greift auch bei direktem POST |
| 3 | Verbundschlüssel: Bilden, Zerlegen, Kollisionsfreiheit; `translationKey: ""` für nicht übersetzbare Felder; `type` ist der nackte Typ | Echo-Lücke: Register ohne Echo ⇒ keine DB-Zeile; Remove ohne Bestätigung ⇒ Zeile bleibt; Teilerfolg schreibt nur bestätigte Felder |
| 4 | Hex-Validierung teilt sich das Muster mit `resolveSwatch`; `access = null` ⇒ „unbekannt" | Farbfeld-Schreiben mit Echo; Lesemodus bei negativem V1 |
| 5 | Deep-Link-Auflösung über `linkedValue` inkl. Rückfall auf die heutige Zeichenkette | Deep-Link mit unbekanntem Typ wählt nichts aus und meldet nichts Falsches |

Dazu läuft für jede Phase mit GraphQL-Text der bestehende [graphql-document-hygiene.test.ts](../../tests/unit/graphql-document-hygiene.test.ts) mit.

---

## 12. Offene Fragen (vor der jeweiligen Phase zu klären)

1. **V1–V5** (§2). Phase 0 beantwortet sie; bis dahin gilt in jeder Oberfläche die vorsichtige Lesart.
2. **Wie viele Einträge hat ein realer Farb-Typ?** Entscheidet, ob die Eintragsliste bei 25 pro Seite bleibt oder virtualisiert werden muss. Aus dem eigenen Cache ohne API-Aufruf beantwortbar.
3. **Gibt es Shops mit markt-spezifischen Metaobjekt-Übersetzungen?** Der Sync liest sie, der Einzel-Editor schreibt sie. Phase 3 ändert daran nichts — aber wenn die Antwort „nie" ist, kann die Marktspalte in der Eintragskarte entfallen und die Karte wird schmaler.
4. **Wird `handle` je gebraucht?** (§6.5) Erst beantworten, wenn ein Merchant danach fragt; die Referenzlage ist der teure Teil, nicht die Mutation.
