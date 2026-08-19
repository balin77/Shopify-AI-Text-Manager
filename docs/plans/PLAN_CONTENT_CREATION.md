# Inhalte in ContentPilot erstellen — Plan (Phasen 0–4)

**Status (2026-08-17, Branch `claude/plan-content-creation-4fqoph`):** Phasen 0–4 umgesetzt, jeder Schritt mit eigenem Review-Durchlauf und behobenen Befunden.

| Phase | Stand |
|---|---|
| 0 | ✅ Migration, Attribut-Sync (`attribute-sync.shared.ts`), Join-Modell `ProductCollection`, `blog`-Case, Messungen (Collection-Probe) |
| 1 | ✅ Create-Modal + `createContent`, sechs Typen, Idempotenz, Delete mit Doppelbestätigung, Undo, Duplizieren |
| 1.4b | ✅ `CollectionRuleBuilder` + `collection-rules.shared.ts`, im Create-Modal **und** im Editor bestehender Collections (API-Guard ≥2026-07, Bearbeiten als Bedingungs-Diff) |
| 1b | ✅ `SeoSidebar` → `ItemSidebar` |
| 2 | ✅ Attribut-Tab; Loader liefern den Attributblock (nachgezogen in Phase 3) |
| 3.1/3.2/3.5 | ✅ `status`, `vendor`, `tags`, `author`, `sortOrder`, `templateSuffix`, `isPublished`, `money`, `taxonomy` (Kategorie-Suche), `collections` (Mitgliedschafts-Diff), `collectionRules` im Editor |
| 3.3 | ✅ Redirect bei Handle-Wechsel (Einzel- **und** Bulk-Editor), als Diff über bestehende Redirects |
| 3.4 | ✅ IndexNow am Publish-Übergang für Pages/Artikel/Blogs (die drei ohne Webhook) |
| 3.6 | ✅ `vendor`/`tags` als Bulk-Spalten |
| 4 | ✅ Scopes in beiden TOMLs, Schema + Sync (`commerce-sync.shared.ts`), `inventorySetQuantities` mit `compareQuantity`, `inventoryItemUpdate` (Kosten, Gewicht, Zolltarif, Ursprungsland), `publishablePublish`/`Unpublish`, eigene Route + Panel, Merchant-Hinweis zum Scope-Change. `taxable` bewusst nur lesend (liegt bei uns auf der Variante, nicht am InventoryItem) |

§2.5 ist vollständig umgesetzt (KI-Extras: Rest generieren, Live-SEO-Score im Modal, Auto-Alt-Text, danach übersetzen, Glossar in `generate*`). Ebenfalls offen: §8.2–§8.4.

**Phase 4, Schritt 5 (Task-Recovery):** entfällt bewusst — Bestand und Kanäle schreiben synchron im Request, es entsteht kein `Task`-Eintrag, also gibt es auch keinen Typ für `LONG_RUNNING_TASK_TYPES`.

**Ursprünglicher Status:** Entwurf, Umsetzung nicht begonnen. Grundsatzentscheidungen getroffen (§2), Review-Durchlauf eingearbeitet (2026-08).
**Ziel:** Der Merchant soll für das **Anlegen und Bearbeiten von Content** nicht mehr in den Shopify-Admin wechseln müssen. Einstieg ist der bereits vorhandene „+"-Button in [UnifiedItemList](../../app/components/unified/UnifiedItemList.tsx), der ein Create-Modal öffnet; ergänzend ein neuer Sidebar-Tab, der die *nicht-SEO*-Vollständigkeit eines Items zeigt.
**Baut auf:** [unified-content.actions.ts](../../app/actions/unified-content.actions.ts) (der EINE Action-Handler), [UnifiedContentEditor](../../app/components/UnifiedContentEditor.tsx), [FilePickerModal](../../app/components/image-manager/FilePickerModal.tsx) + Staged-Upload-Pipeline, [text-generation.handler.ts](../../app/routes/api-ai-handlers/text-generation.handler.ts) (kann bereits aus einem Bild generieren).

> **⚠ Vor der Umsetzung zwingend lesen: §1.0.** Die API-Recherche in §1 wurde gegen `shopify.dev/…/latest` gemacht, die App pinnt aber `2025-10`. Mehrere Bausteine dieses Plans stehen und fallen mit dieser Frage.

---

## 0. Ist-Zustand (gegen den Code verifiziert, 2026-08)

### 0.1 Es gibt heute keinen einzigen Create-Pfad

`productCreate` / `productSet` / `collectionCreate` / `pageCreate` / `articleCreate` / `blogCreate` / `metaobjectCreate` kommen im gesamten Repo **nicht vor**. Die App ist reiner Editor über bereits existierende Shopify-Ressourcen. Einzige Ausnahme ist `/app/direct-translations`, und das legt eine *lokale* DB-Zeile an (`DirectTranslationItem`), keine Shopify-Ressource.

**Ebenso wenig existiert ein Content-Delete.** Kein `productDelete`/`pageDelete`/`articleDelete` im Repo (nur `productDeleteMedia`). Das ist für §Phase 1.8 (Undo) relevant: ein versehentlich angelegtes Objekt ist heute nur im Shopify-Admin wieder loszuwerden.

### 0.2 Der Plus-Button existiert — aber ist nicht verkabelt

`showAddButton` / `onAddItem` / `addButtonLabel` sind in [UnifiedItemList.tsx:133-139](../../app/components/unified/UnifiedItemList.tsx#L133-L139) definiert und werden gerendert ([:727](../../app/components/unified/UnifiedItemList.tsx#L727)). Genutzt wird das **ausschließlich** von [app.direct-translations.tsx:786-788](../../app/routes/app.direct-translations.tsx#L786-L788).

**Der eigentliche Blocker:** [UnifiedContentEditor.tsx:661-704](../../app/components/UnifiedContentEditor.tsx#L661-L704) reicht `showAddButton`/`onAddItem` gar **nicht** an die Liste durch. Alle Content-Tabs laufen über diesen Wrapper — der Button ist dort also nicht „deaktiviert", sondern schlicht nicht vorhanden.

Zusätzlich gibt es die Mobile-Variante ([UnifiedItemSelectorCompact](../../app/components/unified/UnifiedItemSelectorCompact.tsx), gespeist über `registerItems`) — die braucht denselben Einstieg, sonst ist Create auf Mobil unerreichbar.

**Der eine vorhandene „+"-Flow ist KEIN Modal.** [app.direct-translations.tsx:483](../../app/routes/app.direct-translations.tsx#L483) (`handleAddNew`) selektiert eine `NEW_ID`-Sentinel, rendert den normalen Editor mit entsperrtem Quellfeld und lässt die AppSaveBar speichern; serverseitig legt `ensureItem("")` die Zeile beim Speichern an. Warum dieser Plan trotzdem ein Modal wählt, steht in §Phase 1.4 — begründet, nicht übersehen.

### 0.3 Editierbare Felder heute

Aus [content-fields.config.tsx](../../app/config/content-fields.config.tsx):

| Typ | Felder im Einzel-Editor |
|---|---|
| Products | `images`, `title`, `description`, `handle`, `productType`, `seoTitle`, `metaDescription` |
| Collections | `images` (Featured), `title`, `description`, `handle`, `seoTitle`, `metaDescription` |
| Pages / Articles / Blogs | analog (Articles zusätzlich `summary`) |

Dazu Sub-Ressourcen (Optionen, Metafelder) und Varianten-Medien über den [VariantImageManager](../../app/components/image-manager/VariantImageManager.tsx).

**Im Bulk-Editor editierbar, im Einzel-Editor nicht:** `Product.status` (Spalte `COL_STATUS`, [columns.shared.ts:433](../../app/services/bulk-editor/columns.shared.ts#L433), Schreibpfad [apply.server.ts](../../app/services/bulk-editor/apply.server.ts)) sowie `ProductVariant.price` / `compareAtPrice` / `sku` / `barcode` ([schema.prisma:535-560](../../prisma/schema.prisma#L535-L560)). Der Einzel-Editor ist hier schlicht hinterher — das ist keine Designentscheidung, sondern eine Lücke.

### 0.4 Was der Cache/Sync heute holt

Die Produkt-Sync-Query ([product-sync.service.ts:178](../../app/services/product-sync.service.ts#L178)) zieht: `id, title, descriptionHtml, handle, status, productType, updatedAt, seo, featuredImage, media(250), options, metafields(250)` + Varianten (separat).

**Nicht geholt und nirgends gespeichert:** `vendor`, `tags`, `category` (Taxonomie), `templateSuffix`, `publishedAt`, `publications`/Sales-Channels, `giftCard`, `combinedListingRole`, alle Inventory-/Versand-/Kosten-Felder. **Keine Collection-Mitgliedschaft** — es gibt weder ein Join-Modell noch irgendeinen `collectionsToJoin`-Treffer im Repo.

Für Collections ([schema.prisma:638](../../prisma/schema.prisma#L638)): kein `sortOrder`, kein Regelwerk, kein `templateSuffix`.
Für Pages: kein `templateSuffix`, kein `isPublished`/`publishedAt`.
Für Articles: **kein `author`**, keine `tags`, kein `isPublished`/`publishedAt`, kein `templateSuffix`.

**Blogs haben überhaupt kein Prisma-Modell.** Die Blog-Container werden im Loader live von Shopify geholt ([app.blog.tsx:116-119](../../app/routes/app.blog.tsx#L116-L119)), nur ihre Übersetzungen liegen als `ContentTranslation` mit `resourceType: "Blog"` in der DB. `/api/sync-single-resource` hat entsprechend **keinen `blog`-Case** — siehe Phase 0, Schritt 4, wo geklärt wird, wohin so ein Case überhaupt synchronisieren würde.

### 0.5 Was schon da ist und wiederverwendet werden kann

- **Upload-Pipeline:** `/api/staged-upload` (`stagedUploadsCreate`) → Client-PUT → entweder `fileCreate` ([api.create-shopify-file.tsx](../../app/routes/api.create-shopify-file.tsx)) oder `productCreateMedia`. **Achtung, beides zusammen erzeugt zwei MediaImages** — siehe Phase 1.4.
- **`FilePickerModal`** ist entkoppelt über `onAdd` / `onAddExternalUrl` und im Create-Modal direkt einsetzbar. Es liefert `AddedItem` mit `source: "library" | "upload" | "external_url"` und kann auch Video/3D — das Create-Modal muss das annehmen oder im Picker filtern (§Phase 1.4).
- **AI kann aus einem Bild generieren:** [text-generation.handler.ts:141](../../app/routes/api-ai-handlers/text-generation.handler.ts#L141) liest `imageUrl`, [:286-290](../../app/routes/api-ai-handlers/text-generation.handler.ts#L286-L290) reicht es an `generateProductTitle` / `generateProductDescription` weiter. **`sendImageToAI` ist KEINE persistierte Einstellung**, sondern Editor-State ([UnifiedContentEditor.tsx:868](../../app/components/UnifiedContentEditor.tsx#L868)), der als Formularfeld mitgeschickt wird — das Modal braucht seinen eigenen Toggle.
- `/api/ai` ist ein Switch mit 22 Actions ([api.ai.tsx:121-163](../../app/routes/api.ai.tsx#L121-L163)); `generateAltText` ([:131](../../app/routes/api.ai.tsx#L131)) braucht nur eine `imageUrl` und schreibt keine Ressource — im Create-Modal also nutzbar.
- **Cache-Nachzug:** `/api/sync-single-resource` für `product`, `collection`, `article`, `page`, `policy`, `templates`, `metaobjects`.
- **Plan-Limits:** [planUtils.ts](../../app/utils/planUtils.ts) (`maxProducts`/`maxCollections`/`maxArticles`/`maxPages`), Banner über `planLimit` ([app.products.tsx:905-915](../../app/routes/app.products.tsx#L905-L915)). **Zusätzlich gated [plans.ts](../../app/config/plans.ts) über den TYP** (`contentTypes`, `canAccessContentType`) — Free/Basic haben `maxArticles: 0`, Free zusätzlich keine Pages. Siehe §Phase 1.2.
- **Redirects:** `createRedirect` / `validateRedirect` in [redirects.service.ts](../../app/services/seo/redirects.service.ts) — heute nur vom SEO-Tab benutzt.
- **IndexNow:** `getEnabledConfig`, `enqueueResource`, `enqueueIndexNowUrl`, `articleUrl`, `shouldEnqueueProductChange` in [index-now.service.ts](../../app/services/seo/index-now.service.ts).
- **Keywords:** `assignKeyword` in [keywords.service.ts](../../app/services/seo/keywords.service.ts), Prompt-Brücke `loadTrackedKeywords` in [keyword-prompt.ts](../../app/routes/api-ai-handlers/keyword-prompt.ts).
- **Item-Suche über den Cache:** `GET /api/seo/item-picker?type=…&q=…` ([api.seo.item-picker.tsx](../../app/routes/api.seo.item-picker.tsx)).

### 0.6 Sidebar-Tabs heute

[SeoSidebar.tsx:355-372](../../app/components/SeoSidebar.tsx#L355-L372): `type SidebarTab = "score" | "keywords" | "jsonld"`, `availableTabs` startet mit `["score"]`; die Tab-Leiste rendert erst ab zwei Tabs, das „?"-Popover hängt an `TAB_HELP_KEY`. Der Score ([seo-score.ts](../../app/utils/seo-score.ts)) prüft ausschließlich Titel-Länge, SEO-Titel, Description, Meta-Description und Alt-Text-Abdeckung — **nichts** zu Tags, Vendor, Kategorie, Status oder Preis. Der neue Tab überschneidet sich also nicht.

### 0.7 Scopes

Stand der deployten Apps (2026-08) — dev und prod sind deckungsgleich:

```
read_files, write_files, read_legal_policies, write_legal_policies, read_locales,
read_markets, read_metaobject_definitions, write_metaobjects,
read_online_store_navigation, write_online_store_navigation,
read_online_store_pages, write_online_store_pages,
read_product_listings, read_products, write_products,
read_content, write_content, read_themes, write_themes,
read_translations, write_translations
```

Create-Mutationen und Bild-Upload verlangen nur `write_products` / `write_content` / `write_online_store_pages` / `write_metaobjects` / `write_files`; der Status-Wechsel (`productUpdate`) ebenfalls nur `write_products` — **alles vorhanden. Phase 0–3 brauchen keine Scope-Erweiterung.** Erst Phase 4 zieht Scopes nach (§2.1).

**Beide `shopify.app.*.toml` sind ABSICHTLICH versioniert** ([.gitignore:35](../../.gitignore#L35)) — sie sind die Quelle, aus der `shopify app deploy -c <dev|prod>` die Scopes ins Partner Dashboard schreibt. Genau deshalb muss ein Scope-Change (Phase 4) in **beiden** Dateien landen; ein Deploy aus einem Branch mit veralteter Datei entfernt Scopes von der Live-App.

---

## 1. Datenlücken: Shopify-Admin vs. ContentPilot

### 1.0 API-Version — geklärt (2026-08): Umzug auf 2026-07, und zwar ohnehin fällig

Die App pinnt **2025-10** ([shopify.server.ts:43](../../app/shopify.server.ts#L43), `defaultVersion = ApiVersion.October25`). Gemessen gegen shopify.dev:

| Frage | Ergebnis |
|---|---|
| Ist 2025-10 dokumentiert/unterstützt? | **Ja** — die Seiten laden, `UNLISTED` ist dort dokumentiert |
| Existiert `CollectionCreateInput` / `sources` in 2025-10, 2026-01, 2026-04? | **Nein**, in keiner davon |
| Ab wann existiert es? | **2026-07** — das neue Collection-Modell ist genau dort erschienen (Changelog vom 2026-06-17, wirksam 2026-07-01) |
| Wie lange lebt 2025-10 noch? | **Bis 2026-10-16.** Danach fallen Requests automatisch auf die älteste noch erreichbare Version vor |

**Zwei Schlüsse:**

1. **Der Umzug ist kein Projektbestandteil, sondern eine Frist.** In rund zwei Monaten wird 2025-10 unerreichbar, und die App würde ungesteuert auf irgendeine andere Version fallen. Das passiert unabhängig von diesem Plan.
2. **Das Ziel ist 2026-07** — dieselbe Version, die das `sources`-Modell bringt. Frist und Feature fallen zusammen; der Umzug ist damit die Phase −1 dieses Plans (§Phase −1).

**Dazu ein stiller Fehler, der schon heute wirkt:** Laut Changelog werden *„collections using new features […] filtered from pre-2026-07 query results"*. Sobald ein Merchant im neuen Shopify-Admin eine Collection mit mehreren Quellen anlegt, ist sie für ContentPilot auf 2025-10 **unsichtbar** — kein Fehler, kein Log, sie fehlt einfach in der Liste. Das ist heute schon ein Datenverlust-Risiko in der Anzeige, nicht erst mit diesem Plan.

Alle Feld- und Enum-Angaben in §1 sind gegen **2026-07** zu bestätigen (die Recherche lief gegen `latest`); die tragenden Punkte sind bereits geprüft — siehe §Phase −1.

### 1.1 Produkt

| Feld | Shopify-Admin | ContentPilot | Create-Input? | Kosten |
|---|---|---|---|---|
| title, descriptionHtml, handle | ✅ | ✅ | `ProductCreateInput` | — |
| seo (title/description) | ✅ | ✅ | `seo: SEOInput` | — |
| productType | ✅ | ✅ | ✅ | — |
| Medien + Alt-Text | ✅ | ✅ | `media: [CreateMediaInput!]` | — |
| Optionen | ✅ | ✅ (Sub-Resource) | `productOptions` | — |
| Metafelder | ✅ | ✅ (Sub-Resource) | `metafields` | — |
| **status** | ✅ | ⚠ nur Bulk-Editor | ✅ | Feld im Einzel-Editor |
| **vendor** | ✅ | ❌ | ✅ | Schema + Sync |
| **tags** | ✅ | ❌ | ✅ | Schema + Sync + Feldtyp |
| **category** (Taxonomie) | ✅ | ❌ | `category: ID` | Schema + Sync + Suchfeld |
| **collectionsToJoin** | ✅ | ❌ (kein Cache!) | ✅ | Picker + Membership-Cache |
| **templateSuffix** | ✅ | ❌ | ✅ | Schema + Sync |
| **giftCard** | ✅ | ❌ | ✅ (**nur beim Create**) | trivial |
| Preis / Compare-at / SKU / Barcode | ✅ | ⚠ nur Bulk-Editor | ⚠ nicht in `productCreate` | `productSet` |
| Kosten, Steuer, Gewicht, HS-Code | ✅ | ❌ | `inventoryItem` | Phase 4 |
| **Bestand, Lagerorte** | ✅ | ❌ | — | Phase 4, Scopes (§2.1) |
| **Vertriebskanäle** | ✅ | ❌ | `publishablePublish` | Phase 4, Scopes (§2.1) |

**Zwei API-Fakten, die den Entwurf prägen:**

1. `productCreate` legt **nur die Standardvariante** an. Mehrere Varianten → `productVariantsBulkCreate`. Alternativ deckt **`productSet`** alles in einem Call ab und bietet zusätzlich `identifier: { handle }` — ein Create-or-Update-by-Handle, das Retries idempotent macht (§Phase 1.7). *Beides gegen die Zielversion prüfen (§1.0).*
2. **Neu erstellte Produkte sind unpublished.** Ohne Publication ist ein Produkt auch mit `status: ACTIVE` im Shop unsichtbar — siehe §2.3.

### 1.2 Collection — und das neue `sources`-Modell

`CollectionCreateInput` (latest): `title!`, `handle`, `descriptionHtml`, `image`, `seo`, `sortOrder`, `templateSuffix`, `metafields`, **`sources: [CollectionCreateSourceTargetInput!]`**. Das Argument `input: CollectionInput` und dessen `ruleSet` sind deprecated.

```
CollectionCreateInput.sources[]
└─ CollectionCreateSourceTargetInput   (genau EIN Feld pro Eintrag setzen)
   ├─ source: CollectionCreateConditionsSourceInput   ← das Regelwerk
   │  ├─ title!            Name der Quelle (Quellen sind benannt und mehrfach möglich)
   │  ├─ description
   │  ├─ targetType        PRODUCTS (Default) | Varianten
   │  ├─ inclusion: CollectionCreateSourceInclusionInput
   │  │  ├─ conditions[]   die eigentlichen Regeln
   │  │  ├─ matchType      alle / mindestens eine Bedingung
   │  │  └─ selections[]   zusätzlich EXPLIZIT aufgenommene Produkte
   │  └─ exclusion: …      Ausschlussregeln
   ├─ subCollections: …    Mitgliedschaft leitet sich aus anderen Collections ab
   └─ shareableSource: …   bestehende, geteilte Quelle verlinken
```

Konsequenzen:

1. **„Automatisiert" ist kein Schalter mehr, sondern eine Quellenliste** — mehrere benannte Quellen, Ein- *und* Ausschlussregeln, Produkte oder Varianten. Zuschnitt: §2.4.
2. **`selections` mischt manuell und automatisch.** Die alte scharfe Trennung bildet die neue API so nicht mehr ab.
3. **Die „Typ ist unveränderlich"-Regel ist zu messen, nicht anzunehmen.** Das Help Center sagt, der Collection-Typ lasse sich nach dem Anlegen nicht ändern; `CollectionUpdateInput` hat aber ein Feld `sourcesToCreate`. Beides zugleich kann nicht stimmen (Phase 0, Schritt 5).
4. **Vorbedingung für Phase 3:** [content.mutations.ts:103](../../app/graphql/content.mutations.ts#L103) benutzt für `collectionUpdate` noch das deprecatete `input: CollectionInput` (während `articleUpdate` bereits die neue Form nutzt). `sourcesToCreate`/`sourcesToUpdate` erzwingt die Migration dieser Mutation.

### 1.2a Messergebnis 2026-07 (2026-08-16, Dev-Store `8c19f3-ce`)

Introspektion + Schreibtest über die Collection-Probe (Settings → Collection Probe). Alle zehn API-Versionen von 2024-10 bis `unstable` antworten auf dem Store, **2026-07 eingeschlossen** — Phase −1 hat kein Erreichbarkeitsproblem.

Der Zuschnitt aus §2.4 ist vollständig durch die API gedeckt: `CollectionCreateSourceTargetInput` hat genau die drei Zweige `source` / `subCollections` / `shareableSource`, `CollectionCreateConditionsSourceInput` trägt `title!`, `description`, `inclusion`, `exclusion`, `targetType`, und `inclusion`/`exclusion` haben je `matchType`, `conditions[]` **und** `selections[]`. `CollectionConditionMatchType` = `ANY | ALL`, `CollectionSourceTargetType` = `PRODUCTS | VARIANTS`.

#### Messung B: ✅ Eine manuelle Collection LÄSST sich umwandeln

`collectionUpdate` mit `sourcesToCreate` auf einer frisch als manuell angelegten Collection ging durch, und das Zurücklesen bestätigte die Regel. Die Help-Center-Aussage „der Typ ist nach dem Anlegen unveränderlich" gilt für die API **nicht**. §1.2 Punkt 3 ist damit zugunsten des Eingabefelds entschieden, und Phase 3 darf die Umwandlung anbieten.

> **⚠ Dabei der wichtigste Fund des ganzen Laufs: `ruleSet` ist eine VERLUSTBEHAFTETE Rückprojektion des neuen Modells.**
>
> Gesendet wurde `productTag { relation: TAGGED_WITH, values: […], matchType: ANY }`. Zurückgelesen kam über `ruleSet`:
> `{ appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "…" }] }`.
>
> Also: `TAGGED_WITH` → `EQUALS`, und der **eigene `matchType` der Bedingung ist ersatzlos verschwunden**. Shopify projiziert das neue Modell in die alte Form, wo das überhaupt geht — und wo es nicht geht (Ausschlüsse, mehrere Quellen, Varianten-Targeting), kann es nur weglassen. Das erklärt die §1.0-Warnung, dass solche Collections aus Vor-2026-07-Ergebnissen *herausgefiltert* werden, und verschärft sie: was NICHT gefiltert wird, kommt möglicherweise **vereinfacht** zurück.
>
> **Regel daraus:** ab 2026-07 wird `sources` gelesen, **nie** `ruleSet`. Ein Editor, der `ruleSet` liest und zurückschreibt, würde die Mitgliedschaft einer Collection stillschweigend ändern — genau das, was die Read-only-Regel aus §2.4 verhindern soll, nur eine Ebene tiefer. Der `sourcesJson`-Umschlag aus Phase 0 hält das auseinander: eine `{shape: "ruleSet"}`-Zeile ist eine Projektion, keine Wahrheit.

#### Die Bedingungen — Grundlage für `collection-rules.shared.ts`

**Kein generisches `{column, relation, condition}`-Tripel mehr.** Das ist die alte `ruleSet`-Form (`CollectionRuleInput`), die auf 2026-07 nur noch am deprecateten `CollectionInput` hängt. `CollectionSourceInclusionConditionInput` ist eine **Union mit einem Feld pro Attribut** — 18 für Einschlüsse, 5 für Ausschlüsse:

| | Einschluss | Ausschluss |
|---|---|---|
| `productTag` | ✅ `TAGGED_WITH`, `NOT_TAGGED_WITH` | ✅ nur `TAGGED_WITH` |
| `productTitle` | ✅ `EQUALS`, `NOT_EQUALS`, `STARTS_WITH`, `ENDS_WITH`, `CONTAINS`, `DOES_NOT_CONTAIN` | ❌ |
| `productType` | ✅ wie productTitle | ✅ nur `EQUALS`, `CONTAINS` |
| `productVendor` | ✅ wie productTitle | ✅ nur `EQUALS`, `CONTAINS` |
| `productCategory` | ✅ `EQUALS`, `NOT_EQUALS` | ✅ nur `EQUALS` |
| `productStatus` | ✅ `EQUALS`, `NOT_EQUALS` (Werte: `ProductStatus`) | ❌ |
| `collection` | ❌ | ✅ (nur `values: [ID!]!`, ohne Relation) |
| `variantTitle` | ✅ wie productTitle | ❌ |
| `variantPrice` | ✅ `EQUALS`, `NOT_EQUALS`, `GREATER_THAN`, `LESS_THAN` (`MoneyInput`) | ❌ |
| `variantCompareAtPrice` | ✅ dieselben + `IS_SET`, `IS_NOT_SET` | ❌ |
| `variantInventory` | ✅ `EQUALS`, `GREATER_THAN`, `LESS_THAN` (`Int`) | ❌ |
| `variantWeight` | ✅ `EQUALS`, `NOT_EQUALS`, `GREATER_THAN`, `LESS_THAN` (`WeightInput`) | ❌ |
| `metafieldString` | ✅ nur `EQUALS` | ❌ |
| `metafieldStringList` | ✅ nur `INCLUDES` | ❌ |
| `metafieldInteger` / `metafieldDecimal` | ✅ `EQUALS`, `GREATER_THAN`, `LESS_THAN` | ❌ |
| `metafieldBoolean` | ✅ nur `EQUALS` | ❌ |
| `metafieldMetaobject` | ✅ nur `EQUALS` | ❌ |
| `metafieldMetaobjectList` | ✅ nur `INCLUDES` | ❌ |

**Drei Formen, nicht eine.** Das UI kann darüber generisch rendern, die Datenform darf es nicht flachklopfen:

1. **Listenwertig** — `{ relation, values: [...], matchType }`. Die Bedingung hat also ihren **eigenen** `matchType` über ihre Werte, zusätzlich zum `matchType` der Quelle. Zwei Ebenen, und die untere ist genau die, die `ruleSet` verschluckt.
2. **Skalarwertig** — `{ relation, value }`. Betrifft die Varianten- und die numerischen Metafeld-Bedingungen; `value` ist je nach Art `MoneyInput`, `WeightInput`, `Int`, `Decimal`, `Boolean` oder `ID`.
3. **Metafeld-Bedingungen** tragen zusätzlich `definitionId: ID!`.

**Ausschlüsse können weniger als Einschlüsse.** Das UI darf nicht annehmen, jede Einschlussbedingung ließe sich spiegeln — weder die Bedingungsart noch die Relationen decken sich.

**Ein `...ConditionUnknown` existiert auf beiden Seiten.** Shopify sieht selbst vor, dass eine Bedingung auftaucht, die der Client nicht kennt. Die Read-only-Regel aus §2.4 ist damit nicht bloß unsere Vorsicht, sondern die vorgesehene Behandlung.

#### Bearbeiten ist ein DIFF, kein Ersetzen

`CollectionUpdateSourceInclusionInput` (und das Ausschluss-Pendant) hat `conditionsToCreate` / `conditionsToDelete` / `conditionsToUpdate` sowie `selectionsToAdd` / `selectionsToRemove`. Eine bestehende Quelle wird also **differenziell** geändert, und `CollectionUpdateConditionsSourceInput` verlangt `id: ID!` — der Editor braucht die Quellen- und Bedingungs-IDs aus dem Lesepfad, ein „ganze Liste neu schreiben" gibt es nicht. Das passt zur Read-only-Regel: was der Editor nicht rendert, fasst er auch nicht an, weil er es schlicht nicht in seine `*ToUpdate`-Liste aufnimmt.

**`CollectionUpdateSourceTargetInput` hat nur `condition` und `subCollections` — kein `shareableSource`.** Eine geteilte Quelle lässt sich anlegen, aber nicht ändern. Bestätigt §2.4, sie draußen zu lassen.

#### Drei Funde, die andere Planstellen korrigieren

1. **`redirectNewHandle: Boolean` existiert** auf `CollectionUpdateInput` **und** auf dem alten `CollectionInput`, also schon unter dem heutigen Pin. §Phase 3.3 behauptet, der Shopify-Admin biete für den Redirect bei Handle-Wechsel eine Checkbox, „die API nicht". Für Collections stimmt das nicht: die Weiterleitung ist ein Flag an der Mutation und braucht **kein** `createRedirect`. Vor 3.3 ist dasselbe für Product/Page/Article zu prüfen — wo das Flag existiert, ist es der richtige Weg, weil Shopify die Weiterleitung dann selbst verwaltet.
2. **`collectionDuplicate` existiert** (`CollectionDuplicateInput { collectionId, newTitle, copyPublications }`, asynchron über `job`). §2.5f nimmt an, nur Produkte hätten eine Duplicate-Mutation. Phase 1.9 kann für Collections denselben serverseitigen Weg gehen — inklusive `copyPublications`, was die §2.3-Sichtbarkeitsfalle gleich mit erledigt.
3. **`CollectionIdentifierInput { id, customId, handle }` existiert.** §1.7 setzt für Idempotenz auf `productSet(identifier: { handle })` und nimmt an, für andere Typen brauche es eine Request-ID. Für Collections gibt es eine Handle-Identität — ob eine Create-or-Update-Mutation sie annimmt, ist die Anschlussfrage.
4. **Metafeld-Bedingungen sind gegated:** `MetafieldCapabilitySmartCollectionConditionInput { enabled: Boolean! }`. Eine Metafeld-Definition muss für Smart-Collection-Bedingungen **freigeschaltet** sein, bevor sie in einer Regel benutzt werden kann. Der Regel-Editor muss die Auswahl auf freigeschaltete Definitionen beschränken oder die Freischaltung anbieten — sonst baut der Merchant eine Regel, die Shopify ablehnt.

---

### 1.3 Page

`PageCreateInput`: `title` (Pflicht), `handle`, `body`, `isPublished` (bzw. geplantes Datum), `templateSuffix`. Scope: `write_content` **oder** `write_online_store_pages` — beides vorhanden.

**⚠ `PageCreateInput` hat KEIN `seo`-Feld.** Meta-Titel und -Description leben bei Pages, Blogs und Artikeln in den Metafeldern `global.title_tag` / `description_tag` (CLAUDE.md-Gotcha). Der Create-Pfad braucht dafür einen **zweiten Schritt** mit `metafieldsSet` — mit `type`, max. 25 pro Call, und `""` wird abgelehnt (Löschen nur via `metafieldsDelete`). Ohne diesen Schritt entsteht genau das dokumentierte False-Success-Muster: das Formular nimmt SEO-Felder an, Shopify speichert nichts.

### 1.4 Blog / Article

`ArticleCreateInput`: `title` **(Pflicht)**, **`author: AuthorInput` (Pflicht)**, `blogId`, `body`, `summary`, `handle`, `image`, `isPublished`, `publishDate`, `tags`, `templateSuffix`, `metafields`.

→ **`author` ist Pflicht und existiert bei uns nirgends.** Ohne dieses Feld ist Artikel-Erstellung nicht möglich. Default: Name des Shop-Owners, überschreibbar. SEO wie bei Pages über Metafelder (§1.3).

Blog: `commentPolicy`, `templateSuffix` fehlen; das fehlende Prisma-Modell (§0.4) macht Blogs zum Sonderfall.

### 1.5 Metaobject

`metaobjectCreate` mit `type` + `fields` + optional `capabilities.publishable`. `write_metaobjects` ist vorhanden, `read_metaobject_definitions` erlaubt aber **keine neuen Definitionen** — nur Einträge zu bestehenden Typen.

**Zwei Lücken, die den Umfang begrenzen:**

1. **Der Cache kennt keine Pflichtfelder.** [metaobject-sync.service.ts](../../app/services/metaobject-sync.service.ts) speichert `fieldDefinitions` als `{key, name, type}` — **ohne `required`, ohne `validations`**. Phase 0 muss die Definitions-Query erweitern, sonst kann das Formular „Pflicht" gar nicht kennzeichnen.
2. **Nur drei Feldtypen sind editierbar:** `isEditableMetaobjectFieldType` lässt `single_line_text_field`, `multi_line_text_field`, `list.single_line_text_field` zu. Referenztypen (`product_reference`, `file_reference`, …), Zahlen, Booleans, Daten haben keinen Editor.

→ **Zuschnitt:** Create nur für Definitionen anbieten, deren Pflichtfelder allesamt Textfelder sind; andere im UI mit Begründung sperren. Volle Feldtyp-Unterstützung ist ein eigenes Vorhaben.

---

## 2. Getroffene Entscheidungen

Die fünf Grundsatzfragen sind entschieden (2026-08). Was hier steht, ist gesetzt; die Begründungen bleiben stehen, damit nachvollziehbar ist, *wogegen* entschieden wurde. Zwei Einwände aus dem Review, die eine Nachentscheidung verdienen, stehen in §8.

### 2.1 Vollständige Parität, inklusive Commerce — mit Scope-Erweiterung ✅ ENTSCHIEDEN

Der Merchant soll den Shopify-Admin wirklich nicht mehr brauchen. Also kommen auch Bestand, Lagerorte und Vertriebskanäle rein (Phase 4).

**Die maßgebliche Scope-Liste** (überall sonst wird hierauf verwiesen, nicht neu aufgezählt):

| Scope | wofür |
|---|---|
| `write_inventory` | Bestandsmengen (`inventorySetQuantities`) + `inventoryItem`-Felder (Kosten, Steuerpflicht, Gewicht) |
| `read_locations` | Lagerorte auflisten — Bestand ist immer *pro Location* |
| `write_publications` | Vertriebskanäle (`publishablePublish` / `publishableUnpublish`) |

Shopify gewährt mit einem `write_*`-Scope in der Regel auch den Lesezugriff; `read_inventory` / `read_publications` werden deshalb **nur** angefordert, falls die Messung in Phase 4 zeigt, dass die `write`-Scopes nicht reichen. Jeder überflüssige Scope ist ein Punkt im App-Store-Review.

**Preis der Kür:** Laut CLAUDE.md erzwang schon die letzte Scope-Änderung (`read_files,write_files`) eine einmalige Re-Consent-Runde bei jedem installierten Merchant. Die ist eingepreist — deshalb die harte Regel: **alle neuen Scopes gehen in EINEM Deploy raus**, in **beiden** TOMLs (§0.7). Zwei Re-Consent-Runden hintereinander sind das, was Merchants verliert.

### 2.2 Preis der Standardvariante gehört ins Create-Modal

Ein Produkt ohne Preis ist nicht verkaufsfähig. Preis / Compare-at / SKU / Barcode brauchen **keinen** neuen Scope (`write_products` deckt `productSet`) und sind im Bulk-Editor längst vorhanden. Damit ist das Produkt direkt nach dem Create verkaufsfähig, unabhängig von Phase 4.

### 2.3 Anlegen als `DRAFT`, Status danach in unserer App umschaltbar ✅ ENTSCHIEDEN

Wir legen bewusst als **`DRAFT`** an — nichts geht versehentlich live — aber der Merchant schaltet den Status **in ContentPilot** um.

- `Product.status` wird ein editierbares Feld im Einzel-Editor. **Alle vier Werte sind Zielwerte: `ACTIVE`, `DRAFT`, `UNLISTED`, `ARCHIVED`.** `UNLISTED` ist in 2025-10 nachweislich setzbar — [BulkCell.tsx:155-178](../../app/components/bulk-editor/BulkCell.tsx#L155-L178) und das Server-Gate `PRODUCT_STATUSES` in [apply.server.ts](../../app/services/bulk-editor/apply.server.ts) dokumentieren das mit Quellenlinks, und der Kommentar dort verlangt ausdrücklich, dass UI-Optionsliste und Gate synchron bleiben. Der Einzel-Editor muss dieselben vier Werte anbieten wie der Bulk-Editor; alles andere wäre genau die Inkonsistenz, die §2.2 kritisiert.
- **Wichtig und leicht zu übersehen:** `status: ACTIVE` allein macht ein Produkt **nicht** sichtbar. Sichtbarkeit = Status *und* eine Publication auf dem Online Store. Status und Kanäle sind deshalb **getrennte** Controls und getrennte Zeilen im Attribute-Tab — nie ein gemeinsamer „veröffentlicht"-Schalter.
- Übernehmen aus dem Bulk-Editor: dessen `data.errors`→Per-Zelle-Failure-Behandlung. Sie verhindert, dass eine schema-seitige Ablehnung (z. B. `UNLISTED` auf einer älteren gepinnten Version) als stiller Erfolg durchgeht.

### 2.4 Regelwerk-Formular für automatisierte Collections ✅ ENTSCHIEDEN

Das Create-Modal bietet die Typwahl **und** den Regel-Editor an. Zuschnitt nach Leitlinie §2.5:

| Fähigkeit | API | klassischer Smart-Collection-Editor | v1 |
|---|---|---|---|
| Bedingungen + alle/mindestens eine | `inclusion.conditions[]` + `matchType` | ✅ | ✅ |
| **Ausschlussregeln** | `exclusion` | ❌ | ✅ |
| **Mehrere benannte Quellen** | `sources[]` | ❌ | ✅ |
| **Regeln + feste Produktzugaben** | `inclusion.selections[]` | ❌ | ✅ |
| Sub-Collections | `subCollections` | ❌ | ❌ (read-only) |
| Varianten-Targeting | `targetType` | ❌ | ❌ (read-only) |
| Geteilte Quelle verlinken | `shareableSource` | ❌ | ❌ (read-only) |

Die drei letzten Zeilen sind bewusst draußen (Begründung §8.2): sie fügen je ein eigenes mentales Modell hinzu, und der Read-only-Fallback deckt sie zu Nullkosten ab.

**UI-Aufbau:** Die Standardansicht zeigt genau eine Bedingungsliste mit Einschlussregeln — identisch zu dem, was ein Merchant aus Shopify kennt. Ausschlüsse, weitere Quellen und feste Produktzugaben hängen hinter „Erweitert" und erscheinen nur, wenn sie gebraucht oder bereits gesetzt sind. Der Quellen-`title` wird automatisch belegt und ist nur im erweiterten Modus editierbar.

**Read-only-Regel:** Trifft der Editor auf eine Struktur, die er nicht rendert — Sub-Collections, Varianten-Targeting, `shareableSource` oder künftige Erweiterungen —, zeigt er sie **read-only mit Admin-Link** und überschreibt sie nicht. Eine Regelstruktur stillschweigend zu vereinfachen würde die Mitgliedschaft einer Collection ändern, ohne dass es jemand merkt. Die interne Datenform ist deshalb immer die volle `sources[]`-Liste.

> **Zur dritten Spalte (entschieden 2026-08-16):** Sie beschreibt den *klassischen* Editor; das `sources`-Modell ist neu und Shopifys Admin zeigt davon womöglich längst Teile. Das bleibt ungemessen, weil nichts daran hängt: **„mehr als Shopify" wird nach außen gar nicht behauptet.** Der Zuschnitt wird gebaut, weil er dem Merchant nützt — kann Shopify es heute noch nicht, kann es das morgen, und dann war die Behauptung ohnehin nur kurz haltbar.

### 2.5 Leitlinie: wo möglich mehr können als das Shopify-Interface ✅ ENTSCHIEDEN

Gleichziehen ist nicht das Ziel — überholen. Bei jedem Feld gilt: *bietet die API mehr, als der Admin zeigt, und ist das verhältnismäßig nutzbar zu machen?*

**a) Anlegen + übersetzen in einem Zug — der größte Hebel.** Shopifys Create-Dialog ist einsprachig. Eine Checkbox „danach in alle Sprachen übersetzen" macht daraus ein fertiges mehrsprachiges Objekt aus einem Dialog.

Wichtig ist **wie**: Der Create-Handler übersetzt **nichts** selbst. Er legt an, synct, und der Client feuert danach die **bestehende** `translateAll`-Action auf den neuen `itemId`. Die legt wie immer einen `bulkTranslation`-Task an ([translation.action.ts:271](../../app/actions/content/translation.action.ts#L271)) und nutzt die vorhandene Fortschritts-UI. Damit ist es *kein* zweiter Übersetzungs-Schreibpfad, sondern ein verketteter Aufruf des einen vorhandenen. **Single-Language:** Checkbox sichtbar, aber deaktiviert + `DisabledActionTooltip` mit `t.common.requiresSecondLanguage`.

**b) SEO-Score live im Modal.** `computeSeoScore` ist eine reine Funktion und läuft bereits clientseitig. **Aber ihre Eingaben sind nicht voraussetzungsfrei:** `limits` erwartet `AISettings.seoLimits`, und das effektive Titel-Limit kommt aus `seoTitleLimitForSuffix(suffix, limits)` ([seo-score.ts:91](../../app/utils/seo-score.ts#L91)) mit `seoTitleSuffixEnabled`/`seoTitleSuffix`. Ohne beides zeigt das Modal einen anderen Score als die Sidebar daneben. Zusätzlich `excludeImages` setzen, solange kein Bild gewählt ist — sonst steht dort dauerhaft ein Befund, den man im Modal nicht auflösen kann. Auflösung wie in `resolveSeoContext` ([shared.ts:88](../../app/routes/api-ai-handlers/shared.ts#L88)).

**c) Alt-Text automatisch beim Upload.** `generateAltText` existiert als AI-Action; Shopify legt Bilder ohne Alt-Text an.

**d) Keyword schon beim Anlegen.** Der Moment, in dem entschieden wird, *worum es geht*, ist der beste Moment für das Keyword — und ausgerechnet dort schreibt die AI heute keyword-blind, weil `loadTrackedKeywords` auf `resourceId` schlägt und ein neues Item keine hat. Das Modal bekommt ein Keyword-Feld; der Wert geht (1) explizit in den Prompt und (2) nach dem Create per `assignKeyword` als `primary` an das Item. Shopify hat kein Keyword-Konzept.

**e) Glossar auch in die GENERIERUNG.** `getGlossaryDirective` wird heute in acht `translate*`-Methoden eingespeist und in **null** `generate*`-Methoden ([ai.service.ts](../../src/services/ai.service.ts)). Damit produziert §2.5a einen Primärtext, der die Shop-Terminologie ignoriert, und übersetzt ihn danach *mit* Terminologie — die zwei Hälften desselben Dialogs widersprechen sich, besonders bei `doNotTranslate`-Markenbegriffen.

**f) Duplizieren.** Der häufigste reale Create-Fall ist „wie das da, nur anders". `productDuplicate` erledigt Varianten, Optionen, Medien und Metafelder in einem Call; für die übrigen Typen genügt clientseitiges Vorbefüllen aus dem Cache. Kettet man §2.5a an, entsteht ein dupliziertes *und vollständig übersetztes* Objekt — das kann der Admin nicht.

**g) Regelwerk in voller Tiefe** — §2.4.

**Wo die Leitlinie NICHT gilt:** dort, wo „mehr" nur „mehr Felder" heißt. Deshalb der Aufbau „einfacher Fall sichtbar, Mächtigkeit hinter *Erweitert*", deshalb bleibt `shareableSource` draußen, und deshalb ist `templateSuffix` zwar im Attribute-Tab, aber **nicht** im Create-Formular: ein Theme-Template-Suffix nützt nur, wer die Templates seines Themes namentlich kennt, und ein falscher Wert rendert die Seite im falschen Layout.

### 2.6 Der Plus-Button erscheint nicht überall

Auf mehreren Tabs ist Create unmöglich:

- **Policies** — feste Menge von sechs, keine Create-API.
- **Theme-Content / Templates / System-Benachrichtigungen** — keine erstellbaren Ressourcen.
- **Selling Plans / Delivery / OnlineStoreExtras** — dieselbe Flat-Domain-Beschränkung.

**Metaobjects sind erlaubt**, aber eingeschränkt: nur Einträge zu bestehenden Definitionen, und nur solche mit reinen Text-Pflichtfeldern (§1.5).

→ Gesteuert über ein Flag in der `ContentEditorConfig`, nicht global.

---

## 3. Zielbild

```
┌─ UnifiedItemList ──────┐  ┌─ Editor ─────────────┐  ┌─ Sidebar ─────────┐
│ [+] [🔎 Suche  ] [⟳]   │  │ Titel                │  │ Attribute│Score│…│  ← NEU: Tab 1
│  ▸ Produkt A           │  │ Beschreibung         │  │                   │
│  ▸ Produkt B           │  │ Handle · Typ · SEO   │  │ ✗ Keine Tags      │
│  ▸ …                   │  │ NEU: Tags, Vendor,   │  │ ✗ Kein Vendor     │
└────────────────────────┘  │      Status, Preis   │  │ ⚠ Entwurf         │
         │ Klick auf [+]    └──────────────────────┘  │ ⚠ Kein Kanal      │
         ▼                                            └───────────────────┘
┌─ CreateItemModal ─────────────────────────────┐
│ Titel*         [                            ] │  ← Live-Kollisionsprüfung
│ Keyword        [                            ] │  ← geht in Prompt + assignKeyword
│ Bild           [ Auswählen / Hochladen ]      │  ← FilePickerModal (reuse)
│ ☑ Rest per AI generieren  ☑ Bild an AI senden │  ← eigener Toggle, kein State-Erbe
│ ☑ Alt-Text generieren                         │
│ ☑ danach in alle Sprachen übersetzen          │  ← NACH dem Create: translateAll
│ Status         (•) Entwurf  ( ) Aktiv         │
│ ▸ Mehr Felder (Typ, Vendor, Kategorie, Tags…) │
│                     SEO-Score ● 72            │  ← mit shop-eigenen Limits
│                        [Abbrechen] [Erstellen]│
└───────────────────────────────────────────────┘
```

---

## 4. Phasen

### Phase −1 — API-Umzug 2025-10 → 2026-07 (eigenständig, fristgebunden)

Steht vor allem anderen und ist **auch ohne diesen Plan** bis **2026-10-16** zu erledigen (§1.0). Eigener Branch, eigener Deploy, eigener Review — nicht mit Create-Features vermischen.

**Was angefasst werden muss:**

1. **Version-Pin — sechs Stellen, und die Umgebungsvariable ist die entscheidende.** `SHOPIFY_API_VERSION` ist **gesetzt**, nicht nur optional: `.env:7`, `.env.development.template:24`, `.env.production.template:12` — alle auf `2025-10`. Sie überstimmt `defaultVersion`, also bewirkt eine Änderung allein im Code **nichts**. Zu ändern:
   - `SHOPIFY_API_VERSION` in Railway (dev **und** prod) — der eigentliche Schalter
   - `.env` lokal + beide `.env.*.template` (sonst zieht der nächste Entwickler die alte Version)
   - `defaultVersion` in [shopify.server.ts:43](../../app/shopify.server.ts#L43) samt dem Kommentar „für MEDIA_IMAGE translation support" (die Begründung trägt jetzt anders — siehe unten)
   - `api_version` unter `[webhooks]`: [shopify.app.dev.toml:24](../../shopify.app.dev.toml#L24) und [shopify.app.prod.toml:26](../../shopify.app.prod.toml#L26)

   Die Kommentare in [apply.server.ts:110/529](../../app/services/bulk-editor/apply.server.ts#L110) und `tests/unit/bulk-editor.apply.test.ts:821` argumentieren über „pre-2025-10" — inhaltlich weiterhin richtig, aber beim Umzug auf Stimmigkeit prüfen. (`dist/oauth-setup.js` und `dist/shopify-connector.js` fallen auf `2025-01` zurück, sind aber ungetrackte Build-Artefakte ohne Quelle in `src/` — toter Code, keine siebte Stelle.)
2. **SDK:** `@shopify/shopify-api ^14` kennt `ApiVersion.July26` bereits (die Map in `shopify.server.ts` listet es und kompiliert), ein Upgrade ist voraussichtlich **nicht** nötig. Vor dem Umzug verifizieren.
3. **Deploy-Reihenfolge:** Der `api_version`-Wechsel in der TOML ändert die Webhook-Registrierung. Erst deployen, dann die registrierten Webhooks gegen [webhook-registration.service.ts](../../app/services/webhook-registration.service.ts) prüfen — eine stumm auf der alten Version hängende Subscription ist genau die Klasse Fehler, die man erst Wochen später bemerkt.

**Was NICHT bricht** (gegen 2026-07 geprüft):

- **`MEDIA_IMAGE` ist weiterhin ein `TranslatableResourceType`** — der Grund, aus dem 2025-10 überhaupt gepinnt wurde, trägt weiter. Ebenso `COLLECTION_IMAGE`, `ARTICLE_IMAGE` (Featured-Image-Alt, die dritte Übersetzungsform), `PRODUCT_OPTION`, `PRODUCT_OPTION_VALUE`, `METAFIELD` (Sub-Resource-Übersetzungen).
- **`productUpdateMedia` existiert weiter** — deprecated zugunsten von `fileUpdate`, aber funktionsfähig. Der Status ist damit unverändert gegenüber heute; CLAUDE.md beschreibt es bereits als „deprecated-but-tested".
- **Das Collection-Modell ist nicht-brechend:** `ruleSet`, `collectionCreate(input:)` und `collectionUpdate(input:)` bleiben in 2026-07 abfragbar, die Migration kann schrittweise laufen. Für Phase 3 wird [content.mutations.ts:103](../../app/graphql/content.mutations.ts#L103) trotzdem auf `collection:` umgestellt (§1.2 Punkt 4).

**Was zu messen bleibt** (die Recherche lief gegen `latest`, nicht gegen 2026-07):

- Ein GraphQL-Smoke-Test über die Schreibpfade: Übersetzungen (`translationsRegister`/`translationsRemove` inkl. Echo), Alt-Text (`productUpdateMedia`/`fileUpdate`), Metafelder (`metafieldsSet`/`metafieldsDelete`), Theme-Content, `stagedUploadsCreate`. Die GraphQL-Oberfläche verteilt sich auf gut 40 Dateien — ein Durchlauf der bestehenden Tests plus ein manueller Durchgang durch Einzel-Editor, Bulk-Editor und Theme-Tabs ist der günstigste Weg, das abzudecken.
- **`@idempotent` ist ab 2026-04 auf einer Reihe von Inventory-Mutationen Pflicht.** Betrifft heute nichts, aber **Phase 4** muss es von Anfang an mitsenden.
- Ob der Sprung Collections sichtbar macht, die vorher gefiltert waren (§1.0) — falls ja, ist ein voller `syncAllCollections` nach dem Deploy nötig, weil ein Reload nur bekannte IDs auffrischt.

**DoD:** Beide Apps auf 2026-07 deployed, Webhooks auf der neuen Version registriert, `typecheck` + `test` grün, manueller Durchgang durch die drei Editor-Oberflächen ohne Regression.

---

### Phase 0 — Fundament: Messungen, Schema, Sync

> **Stand 2026-08-16 — Schritte 2–4 umgesetzt, Schritt 5 teilweise.** Migration
> [`20260818000000_content_creation_attributes`](../../prisma/migrations/20260818000000_content_creation_attributes/migration.sql),
> Sync-Mapping in [attribute-sync.shared.ts](../../app/services/attribute-sync.shared.ts),
> `blog`-Case entschieden und gebaut. `typecheck` + `test` grün (110 Dateien / 2248 Tests).
> Offen bleiben die Messungen, die eine **echte Shop-Verbindung** brauchen — siehe Schritt 5.
>
> **Eine Ergänzung gegenüber dem Entwurf, die tragend ist:** jedes der vier Modelle
> bekommt zusätzlich ein `attributesSyncedAt DateTime?`. Ohne diesen Diskriminator wäre
> „vor dem ersten Sync = unbekannt" (§2.4) nicht *darstellbar*: `vendor NULL`,
> `tags '{}'` und `isPublished true` sind die Migrations-Defaults und von „der Merchant
> hat nichts eingetragen" nicht zu unterscheiden — exakt die Falle, die CLAUDE.md für
> `SeoCrawlPage.metaRobots` beschreibt. `attributesKnown()` ist das Gate, durch das jeder
> Leser dieser Spalten muss. Die Mapper erzwingen die andere Hälfte derselben Regel:
> liefert eine Antwort den Attribut-Block **nicht**, geben sie `{}` zurück und schreiben
> weder Defaults über vorhandene Werte noch einen `attributesSyncedAt`-Stempel für Daten,
> die nie ankamen.

2. **Prisma-Migration:**
   - `Product`: `vendor String?`, `tags String[]`, `categoryId String?`, `categoryName String?`, `templateSuffix String?`, `publishedAt DateTime?`
   - `Collection`: `sortOrder String?`, `templateSuffix String?`, `isSmart Boolean @default(false)`, `sourcesJson Json?` (voller Baum, nicht flachgeklopft — §2.4)
   - `Page`: `templateSuffix String?`, `isPublished Boolean @default(true)`, `publishedAt DateTime?`
   - `Article`: `author String?`, `tags String[]`, `templateSuffix String?`, `isPublished Boolean @default(true)`, `publishedAt DateTime?`
   - **Collection-Mitgliedschaft**: ein Join-Modell `ProductCollection(shop, productId, collectionId)` — ohne das kann der Attribute-Tab die Zeile „in 0 Collections" nicht zeigen (§Phase 2).
   - Metaobject-`fieldDefinitions` um `required`/`validations` erweitern (§1.5).
   - Index nur, wo gefiltert wird. **Beachten:** die FORWARD RULE in [schema.prisma](../../prisma/schema.prisma) verlangt für Indizes auf große Hot-Tables `CREATE INDEX CONCURRENTLY` außerhalb der Prisma-Migration.
   - **GDPR-Drift-Guard:** [gdpr.service.ts](../../app/services/gdpr.service.ts) muss jedes neue shop-scoped Modell löschen, sonst schlägt `tests/unit/gdpr.service.test.ts` fehl — der Test parst das Schema.
3. **Sync-Queries erweitern:** [product-sync.service.ts:178](../../app/services/product-sync.service.ts#L178) (`vendor`, `tags`, `category`, `templateSuffix`, `publishedAt`, Collection-Mitgliedschaft), analog in [content-sync.service.ts](../../app/services/content-sync.service.ts). Backfill über den regulären Sync; bis dahin sind die Spalten `null` = „unbekannt", nicht „fehlt".
4. **`blog`-Case in [api.sync-single-resource.tsx](../../app/routes/api.sync-single-resource.tsx)** — und dabei entscheiden, **wohin** er synct: Es gibt kein `Blog`-Modell, heute existieren nur `ContentTranslation`-Zeilen mit `resourceType: "Blog"`. Entweder ein Modell anlegen oder den Case auf „Loader-Revalidierung anstoßen" beschränken. So oder so explizit, nicht implizit.

   **✅ Entschieden (2026-08-16): kein `Blog`-Modell.** Die Primärfelder eines Blog-Containers holt der Loader von [app.blog.tsx](../../app/routes/app.blog.tsx) ohnehin bei **jedem** Besuch live — eine Cache-Zeile wäre eine zweite Wahrheit für Daten, die nie veralten. Nur die Übersetzungen brauchen einen Speicher, und den haben sie (`ContentTranslation`, `resourceType: "Blog"`). `syncSingleBlog` in [content-sync.service.ts](../../app/services/content-sync.service.ts) frischt genau die auf: delete + recreate, **skopiert auf die erfolgreich geholten Market-Layer**, wie im Artikel-Pfad. Nebenbei geschlossen: der Loader backfillt Blog-Übersetzungen nur, wenn ein Blog **gar keine** hat — eine geänderte Übersetzung war damit aus Shopify nie nachladbar. Existiert der Blog nicht, gibt der Case 404 zurück statt einen erfolgreichen No-Op zu melden.
5. **Messungen** (Ergebnisse hier im Dokument festhalten):
   - Enums für Ein- **und** Ausschlussbedingungen + `CollectionConditionMatchType` + Limit für die Anzahl Quellen → Grundlage für `collection-rules.shared.ts` — **✅ gemessen 2026-08-16 gegen 2026-07 auf `8c19f3-ce`. Ergebnisse in §1.2a.**
   - Verwandelt `collectionUpdate` mit `sourcesToCreate` eine bestehende manuelle Collection? (§1.2 Punkt 3) — **✅ JA, gemessen.** Details und Konsequenzen in §1.2a.
   - ~~Zeigt Shopifys aktueller Admin bereits Ausschlüsse/Mehrfachquellen? (§2.4)~~ — **gestrichen (2026-08-16).** Die Messung sollte nur absichern, ob man „mehr als Shopify" behaupten darf. Wir behaupten es nicht: der Zuschnitt aus §2.4 wird gebaut, weil er nützlich ist, und wir gehen davon aus, dass Shopify es entweder schon kann oder bald können wird. Damit hängt keine Entscheidung mehr an der Antwort.
   - **Upsertet `syncSingleX` einen bisher UNBEKANNTEN GID?** — **✅ Ja, für alle fünf; am Code beantwortet, keine Shop-Verbindung nötig.** `syncSingleProduct`/`syncSingleCollection`/`syncSingleArticle`/`syncSinglePage` holen per ID und schreiben ein `upsert` **mit `create`-Zweig** — ein unbekannter GID wird angelegt, nicht verworfen. Metaobjects gehen über `syncMetaobjectsForType`, das den ganzen Typ neu holt, also einen neuen Eintrag ebenfalls findet. Die CLAUDE.md-Regel „Reload only refreshes known IDs" meint etwas anderes und bleibt richtig: die **Liste** entdeckt nichts Neues (nur `syncAll*` tut das) — aber ein gezielter Reload auf einen bekannten neuen GID, und genau den hat Phase 1.6 nach dem Create, funktioniert.
   - Reichen `write_inventory`/`write_publications` ohne ihre `read_`-Pendants? (§2.1) — **offen, erst in Phase 4 messbar.**
6. **Webhooks:** `products/create` feuert bei unserem eigenen Create mit ([webhooks.products.tsx:141](../../app/routes/webhooks.products.tsx#L141)). Zusammen mit dem expliziten Sync ergibt das zwei Syncs — beide Upserts, also idempotent. `altTextModifiedAt` (5-Min-Preserve-Fenster) muss auch beim Create gesetzt werden.

**DoD:** Migration angewendet, ein Sync-Lauf füllt die Spalten, alle Messungen beantwortet und notiert, `typecheck` + `test` grün.

> **Migration gegen ein echtes Postgres verifiziert (2026-08-16), nicht nur gelesen:** Basis-Schema per `db push` materialisiert, mit je einer Zeile pro Tabelle befüllt, `migration.sql` angewendet, danach `prisma migrate diff` gegen das Ziel-Schema → **leer**. Die bestehenden Zeilen tragen anschließend die Defaults **und `attributesSyncedAt = NULL`**, also „unbekannt" — genau das Verhalten aus §2.4. Der Lauf hat auch den Grund für die zwei expliziten `@default([])` geliefert: ohne sie meldet `migrate diff` gegen **jede** deployte DB dauerhaft Drift, weil Postgres eine `NOT NULL`-Spalte nur mit Default zu einer gefüllten Tabelle hinzufügen kann.
>
> **Dabei aufgefallen und mitgefixt (unabhängig von diesem Plan): eine frische Datenbank kam bisher nicht hoch.** Zwei getrennte Ursachen, beide erst sichtbar, wenn man `migrate deploy` tatsächlich einmal gegen eine leere DB laufen lässt:
>
> 1. `20260516000004_add_initial_sync_completed_at` brach mit `42804` ab — `SELECT DISTINCT p."shop", NULL, …`, und Postgres typt ein nacktes `NULL` als `text`, während `uninstalledAt` `timestamp` ist. Die Spalte wird dort gar nicht gesetzt, gehört also nicht in die Spaltenliste; das ist der ehrlichere Fix als ein `NULL::timestamp`.
> 2. Danach zeigte ein `migrate diff` gegen das Schema vier Spalten, die in **keiner** Migration stehen (`AISettings.selectedModel` / `seoTitleSuffix` / `seoTitleSuffixEnabled`, `Task.aiModel`) — irgendwann per `db push` auf die bestehenden DBs gebracht und nie festgehalten. Das ist die unangenehmere Hälfte: der Deploy wäre durchgelaufen und erst der **erste Request** wäre gescheitert. Nachgetragen in `20260818000100_fresh_db_schema_gaps`, alles `IF NOT EXISTS` und damit auf bestehenden DBs ein reiner No-Op (gemessen).
>
> Die Prüfsummen-Sorge bei (1) hat sich gemessen erledigt: `prisma migrate deploy` verifiziert die Prüfsummen bereits angewendeter Migrationen **nicht** — es meldet „No pending migrations to apply" und wendet nachfolgende Migrationen normal an (Postgres 16 / Prisma 6.19). Nur `migrate dev` würde Drift monieren, und das läuft in keinem Deploy-Pfad. Ergebnis: volle Historie auf einer leeren DB grün, `migrate diff` gegen das Schema leer.

---

### Phase 1 — Create-Modal am Plus-Button

**1.1 Konfiguration.** In `ContentEditorConfig` ([content-editor.types.ts:330](../../app/types/content-editor.types.ts#L330)) ein Feld `createSupport?: { resource: CreatableResource; requiresParent?: "blog" }`. Gesetzt für `products`, `collections`, `pages`, `blog` (deckt Artikel *und* Blog-Container ab), `metaobjects` — **sechs Ressourcentypen über fünf Tabs**. Nicht gesetzt für Policies, Theme-Familie, Selling Plans (§2.6).

**1.2 Verkabelung + Gating.** [UnifiedContentEditor.tsx:661](../../app/components/UnifiedContentEditor.tsx#L661) reicht `showAddButton`/`onAddItem` durch; derselbe Einstieg im Mobile-Pfad. Das Gate ist **zweistufig**, weil [plans.ts](../../app/config/plans.ts) zwei verschiedene Sperren kennt:

- `canAccessContentType(plan, type)` — Free hat keine Pages/Artikel, Basic keine Artikel. Hier ist die Erklärung „Ihr Tarif enthält diesen Inhaltstyp nicht", **nicht** „Limit erreicht".
- `getMaxForResource` / `isAtLimit` — Mengengrenze, hier passt die Limit-Erklärung.

Beides sichtbar-aber-deaktiviert mit dem jeweils richtigen Tooltip, nie versteckt. Serverseitig gelten beide erneut (§1.5).

**1.3 Feld-Definitionen.** Neue Datei `app/config/create-fields.config.ts`, **client-safe** (kein `.server`-Import), damit Modal und Server-Validator dieselbe Quelle nutzen — Muster wie `columns.shared.ts`. Bewusst getrennt von `content-fields.config.tsx`, weil Create-Felder ≠ Edit-Felder (`giftCard` nur beim Create, `author` nur dort Pflicht, `blogId` nur dort relevant).

- **Product:** `title*`, Keyword, Bild, Status (Default `DRAFT`), Preis/Compare-at/SKU, `productType`, `vendor`, `tags`, `category`, `descriptionHtml`, `handle`, `seo`
- **Collection:** `title*`, Typwahl manuell/automatisiert (Default manuell), Bild, `descriptionHtml`, `handle`, `seo`, `sortOrder`; bei „automatisiert" der Regel-Editor (1.4b)
- **Page:** `title*`, `body`, `handle`, `seo` (→ Metafeld-Schritt, §1.3), `isPublished`
- **Article:** `blogId*`, `title*`, `author*` (Default Shop-Owner), Bild, `summary`, `body`, `handle`, `tags`, `seo` (→ Metafeld-Schritt), `isPublished`
- **Blog:** `title*`, `handle`, `commentPolicy`
- **Metaobject:** `type*` (nur Definitionen mit Text-Pflichtfeldern, §1.5), `handle`, deren Pflichtfelder

`templateSuffix` bewusst nicht im Formular (§2.5).

**1.4 Die Komponente.** `app/components/create/CreateItemModal.tsx`, Polaris `Modal`, generisch über die Config gerendert.

*Warum Modal und nicht das `NEW_ID`-Muster aus Direct Translations (§0.2):* Dort gibt es genau ein Pflichtfeld (den Quelltext); hier hat jeder Typ mehrere, teils typabhängige Pflichtfelder und mit dem Regel-Editor einen eigenen Unterdialog. Ein Editor-Formular mit unauflösbaren Pflichtfeldern und aktiver SaveBar wäre die schlechtere UX. Die Abweichung ist bewusst — sie ist im Modal dadurch abzufedern, dass es die AppSaveBar-Konvention respektiert: **`confirmNavigation()` beim Schließen mit ungespeicherten Eingaben** ([useSaveBar.ts](../../app/hooks/useSaveBar.ts)).

- **Kein Browser-Storage für Entwürfe.** localStorage/sessionStorage wurden für die App-Store-Compliance bewusst entfernt ([useAppNavigation.ts:17](../../app/hooks/useAppNavigation.ts#L17)). Ein angefangenes Formular lebt im Speicher; verlassen wird über `confirmNavigation()` abgesichert, nicht über einen persistierten Draft.
- **Bild:** `FilePickerModal`. **Genau EIN Upload-Weg zum Produkt** — die staged URL geht direkt als `media: [{ originalSource }]` in den Create. Der Umweg über `fileCreate` und danach nochmal `productCreate(media:)` erzeugt **zwei** MediaImages für dasselbe Bild und kollidiert mit der Doppel-Listing-Invariante des `MediaLibraryImage`-Caches. Der Picker kann auch Video/3D zurückgeben — entweder annehmen (`mediaContentType` aus `mediaKind` ableiten) oder im Picker filtern; still verschlucken ist keine Option.
- **AI-Generierung:** `/api/ai` `generateAIText`. Zwei Dinge, die der Handler heute nicht kann und die mitgeplant werden müssen: er leitet Prompt und Zeichenlimit aus `fieldDefinitions.find(f => f.key === fieldType)` ab (für `tags` existiert die Definition erst nach Phase 3), und er legt einen Task mit `resourceId: itemId` an und ruft `loadTrackedKeywords(…, itemId, …)` — im Modal gibt es noch keine `itemId`. Der leere Fall muss sauber durchlaufen, und das Keyword aus §2.5d wird **explizit** übergeben statt aus der DB geladen.
- **Eigener `sendImageToAI`-Toggle** (§0.5) — der Editor-State ist im Modal nicht verfügbar.
- **SEO-Score** mit shop-eigenen Limits und `excludeImages` (§2.5b).
- **Alt-Text** nach dem Upload (§2.5c).
- **Kollisionsprüfung live:** debounced gegen `/api/seo/item-picker` — „ein Produkt mit diesem Titel existiert bereits". Verhindert den häufigsten Create-Fehler, das versehentliche Duplikat.
- **Sprachen:** siehe §2.5a — der Handler schreibt nur die Primärsprache, die Übersetzung ist ein **nachgelagerter** Client-Aufruf.

**1.4b Der Regel-Editor** (`app/components/create/CollectionRuleBuilder.tsx`). Eigenständig, weil Phase 3 ihn für bestehende Collections wiederverwendet.

*Standardansicht:* Zeilenliste `Feld / Operator / Wert` mit Hinzufügen/Entfernen, darüber „alle / mindestens eine" (`inclusion.matchType`). Wert-Input je Feldtyp (Text, Zahl, Gewicht mit Einheit, Auswahl). Mindestens eine Bedingung ist Pflicht.

*Hinter „Erweitert":* Ausschlussregeln (`exclusion`, eigener `matchType`, optisch als „außer" abgesetzt), feste Produktzugaben (`inclusion.selections[]`, Produkt-Picker), weitere Quellen (`sources[]`, Namen erst ab der zweiten sichtbar).

*Beides:* Feld- und Operator-Enums aus `app/config/collection-rules.shared.ts`, client-safe, geteilt mit dem Server-Validator. Der Server akzeptiert keine Kombination und keine Quellenanzahl außerhalb dieser Liste. Nicht renderbare Strukturen: read-only + Admin-Link (§2.4).

*Keine Trefferzahl-Vorschau in v1* — bräuchte eine Produktabfrage mit denselben Regeln. Der Hinweis, dass die Mitgliedschaft erst nach dem Anlegen sichtbar wird, gehört ins Modal. (Mit Ausschlussregeln steigt der Wert einer Vorschau spürbar — erster Kandidat für Nachschub.)

**1.5 Server.** Neuer Action-Typ `createContent` im **bestehenden** Switch ([unified-content.actions.ts:128-145](../../app/actions/unified-content.actions.ts#L128-L145)) → `app/actions/content/create.actions.ts`. Keine parallele Route.

1. **Plan-Gate serverseitig — beide Stufen** (`canAccessContentType` **und** Mengenlimit). Die UI-Sperre ist Kosmetik, die Action ist per POST erreichbar.
2. **Payload gegen `create-fields.config.ts` validieren**, Regelwerk gegen `collection-rules.shared.ts` — nie den Client-Claim übernehmen.
3. Mutation je Typ. Produkte: `productSet` (deckt Variante/Preis mit ab und bietet `identifier: { handle }` für Idempotenz). Collections: `collectionCreate` mit `collection:` (nicht `input:`) und der vollständigen `sources[]`-Liste. **Pages/Artikel/Blogs: zweiter Schritt `metafieldsSet` für `global.title_tag`/`description_tag`** (§1.3) — mit `type`, ohne `""`.
4. **Echo-Regel:** `userErrors` genügt nicht. Geprüft wird, dass die Antwort eine `id` **und** die gesetzten Kernfelder zurückliefert — inklusive der Metafelder aus Schritt 3. Kein Echo ⇒ Fehler, kein DB-Schreiben.
5. `syncSingleX` für den neuen GID (Ergebnis der Phase-0-Messung beachten).
6. **Keyword zuweisen** (`assignKeyword`, §2.5d) und **IndexNow** vorbereiten (§Phase 3 — bei `DRAFT` wird NICHT gepingt).
7. Rückgabe `{ actionType: "createContent", success: true, id }`.

**1.6 Nach dem Create.** Client selektiert das neue Item, revalidiert, InfoBox. Scheitert der Sync, das Shopify-Objekt existiert aber: **nicht** als Fehler melden — „erstellt, wird beim nächsten Reload sichtbar" und Reload anstoßen. Die Umkehrung provoziert einen zweiten Klick und damit ein Duplikat.

**1.7 Fehlerfälle und Idempotenz.**
- Gesperrter Button gegen Doppelklick reicht **nicht** — er deckt weder Timeout-plus-Retry noch Reload mitten im Request. Absicherung: `productSet(identifier: { handle })` wo verfügbar, sonst eine client-generierte Request-ID, die der Handler einige Sekunden dedupliziert.
- Handle-Kollision → Shopify hängt `-1` an; das Modal zeigt danach den tatsächlichen Handle.
- Artikel ohne Blog im Shop → Hinweis + Umschalten auf das Blog-Formular.

**1.8 Undo (neuer Write-Pfad — bewusst entscheiden).** Kein allgemeines Delete, nur „diesen Create rückgängig" auf der Post-Create-InfoBox, mit Bestätigung und kurzem Zeitfenster. Begründung: die Hausregel „kein Undo nach dem Schreiben" (der Bulk-Editor leert seinen Undo-Stack beim Speichern) galt für falsche *Werte*; hier ist der Fehlerfall ein **sichtbares Objekt im Shop**. Scopes sind vorhanden, Cache-Zeile und `ContentTranslation` müssen mit aufgeräumt werden. Da es ein echter neuer Write-Pfad ist: explizit entscheiden, nicht nebenbei einbauen.

**1.9 Duplizieren (§2.5f).** „Anlegen wie …" als zweiter Einstieg neben dem leeren Formular: für Produkte `productDuplicate` (`newStatus: DRAFT`), für die übrigen Typen clientseitiges Vorbefüllen aus dem Cache. Mit angehängtem `translateAll` (§2.5a) ist das der günstigste vollständige Create-Pfad im ganzen Plan.

**DoD:** Auf allen sechs Ressourcentypen erstellbar, neues Item sofort selektiert und editierbar, beide Plan-Gates server- wie clientseitig, Tests nach §7.

---

### Phase 1b — Rename `SeoSidebar` → `ItemSidebar`

Eigener Commit **vor** Phase 2: ein reines Rename-Diff ist überprüfbar, ein gemischtes nicht.

- [SeoSidebar.tsx](../../app/components/SeoSidebar.tsx) → `ItemSidebar.tsx`, `SeoSidebarProps` → `ItemSidebarProps`
- Import + Verwendung in [UnifiedContentEditor.tsx:24/532](../../app/components/UnifiedContentEditor.tsx#L24)
- Flag `showSeoSidebar` → `showItemSidebar`: [content-editor.types.ts:330](../../app/types/content-editor.types.ts#L330), 7 Vorkommen in `content-fields.config.tsx`, 4 in `UnifiedContentEditor` (443, 584, 1264, 1292)
- Doc-Kommentare: `seo-score.ts`, `audit.service.ts`, `keywords.service.ts`, `SeoSettingsContext.tsx`, `api.seo-keyword.tsx`, `KEYWORDS_CONTRACT.md`

i18n-Keys bleiben unter `t.seo.sidebarTabs.*` — sie umzubenennen fasst drei Sprachdateien an, ohne dass ein Nutzer etwas sieht.

---

### Phase 2 — Sidebar-Tab „Attribute"

**2.1** `SidebarTab` um `"attributes"` erweitern, `availableTabs` mit `["attributes", "score"]` starten, wenn der Typ Attribute hat. Label + `TAB_HELP_KEY` (`seoSidebarAttributes`), Hilfetexte in `t.help.*` für **de/en/es**.

**2.2 Inhalt** — disjunkt zum Score (§0.6):

| Zeile | Produkt | Collection | Artikel | Page |
|---|---|---|---|---|
| Status | 4 Werte | — | isPublished | isPublished |
| Vertriebskanäle (getrennt vom Status, §2.3) | Anzahl | Anzahl | — | — |
| Tags | Anzahl | — | Anzahl | — |
| Vendor / Autor | fehlt/gesetzt | — | Autor | — |
| Kategorie (Taxonomie) | fehlt/gesetzt | — | — | — |
| Produkttyp | fehlt/gesetzt | — | — | — |
| Collection-Mitgliedschaft | Anzahl | — | — | — |
| Preis der Standardvariante | fehlt/gesetzt | — | — | — |
| Featured Image | ja/nein | ja/nein | ja/nein | — |
| Theme-Template | Standard/abweichend | dito | dito | dito |
| Sortierung | — | sortOrder | — | — |
| Keyword zugewiesen | ja/nein | ja/nein | ja/nein | ja/nein |
| In keinem Menü verlinkt | — | — | — | Hinweis (§8.3) |

Jede Zeile mit Ampel und klickbar → springt zum Feld im Editor (Phase 3) bzw. verlinkt in den Admin.

**2.3 Datenherkunft — nicht alles liegt im geladenen Item.** Titel/SEO/Bild/Tags/Vendor kommen aus dem Item. **Nachzuladen bzw. erst später verfügbar:**
- *Collection-Mitgliedschaft* — braucht das Join-Modell aus Phase 0.
- *Vertriebskanäle* — kein Cache, kein Scope vor Phase 4. Bis dahin „unbekannt" mit Admin-Link, **kein** roter Befund.
- *Preis der Standardvariante* — liegt auf `ProductVariant` und wird heute nicht ins Editor-Item geladen.

**2.4 Weitere Randfälle:**
- Neue Spalten sind vor dem ersten Sync `null` = **„unbekannt", nicht „fehlt"** — sonst produziert die Migration einen Tag lang falsche rote Punkte.
- **Foreign-Locale:** Tags, Vendor, Kategorie sind nicht übersetzbar (übersetzbar sind nur `title`, `body_html`, `handle`, `meta_*`, `summary_html`, `product_type` — `FIELD_TO_TRANSLATION_KEY`). Im Fremdsprachen-Modus read-only mit Erklärung, sonst wirkt es wie ein verlorenes Speichern.

**DoD:** Tab sichtbar, Checkliste korrekt für alle vier Typen, i18n in drei Sprachen, `null` als „unbekannt", nachgeladene Zeilen sauber im Ladezustand.

---

### Phase 3 — Attribute im Editor bearbeitbar

1. **Neue `FieldDefinition`-Typen** + `FieldRenderer`:
   - `status` — Select mit **allen vier** Werten (§2.3), `productUpdate`, kein neuer Scope. Solange Phase 4 fehlt: Hinweis, dass „Aktiv" ohne Vertriebskanal keine Sichtbarkeit bedeutet.
   - `tags` — Chips + Autocomplete aus den im Shop vergebenen Tags
   - `select` — `sortOrder`, `commentPolicy`
   - `taxonomy` — Kategorie-Suche
   - `collections` — Multi-Picker (Mitgliedschaft, braucht das Join-Modell)
   - `money` — Preis / Compare-at der Standardvariante
   - `collectionRules` — der `CollectionRuleBuilder` für bestehende Collections, über `collectionUpdate` (`sourcesToCreate`/`sourcesToUpdate`; erzwingt die Migration aus §1.2 Punkt 4). Read-only-Regel §2.4.
2. **Schreiben** über den bestehenden `updateContent`-Pfad, damit die Change-Detection gegen die Session-Baseline unverändert gilt. Preis über `productSet`/`productVariantsBulkUpdate`, danach `ProductVariant`-Mirror.
3. **Redirect bei Handle-Wechsel (§A1).** Die App ändert Handles heute an drei Stellen — Einzel-Editor, Bulk-Spalte `field.handle`, bulk-translate — und legt **nie** einen Redirect an; jede Änderung bricht still die alte URL. Der Shopify-Admin bietet dafür eine Checkbox, die API nicht. `createRedirect` aus [redirects.service.ts](../../app/services/seo/redirects.service.ts) einhängen, per Checkbox angeboten, bei brandneuen Objekten unterdrückt.

   **Offene Frage 3 — Redirect × Locale-Präfix — ist GEMESSEN (2026-08, Live-Shop, [api.redirect-locale-probe.tsx](../../app/routes/api.redirect-locale-probe.tsx)).** Ein Wegwerf-Redirect `/<probe>` → `/<target>`, beide Seiten unverwechselbar, beantwortet beide Hälften: `/en/<probe>` liefert **301**, ein präfigierter Pfad greift also auf die pfadbasierte Redirect-Tabelle zu; und die `Location` ist `/en/<target>`, das Präfix wird also **mitgeführt**. Damit deckt **eine unpräfigierte Zeile jede Sprache ab** — pro Locale eine eigene Zeile wäre überflüssig, nicht nötig.

   **Gebaut:** `decideTranslatedHandleRedirect` ([handle-redirect.shared.ts](../../app/services/seo/handle-redirect.shared.ts)) deckt die Fremdsprachen-Hälfte ab — Bulk-Grid-Zelle `field.handle` im Fremdsprachen-Modus und der Fremdsprachen-Save des Einzel-Editors. Genau die Reichweite der einen Zeile macht sie heikel (sie greift unter *jedem* Präfix), deshalb verweigert sie vier Fälle: **keine vorherige Übersetzung** (die Sprache wurde unter dem PRIMÄR-Handle ausgeliefert, das live bleibt — deshalb erzeugt bulk-translate, das nur leere Werte füllt, keinen einzigen Redirect), ein altes Handle, das noch das primäre oder **das einer anderen Sprache** desselben Objekts ist (die Zeile würde eine lebende Seite kapern), eine **markt-spezifische** Übersetzung (shop-weite Zeile ≠ Markt-URL) und einen **Artikel unter einem Blog mit übersetztem Handle** (zwei übersetzbare Segmente, welche Schreibweise der Storefront ausliefert ist ungemessen → `localeBlogHandleUnknown`, nie geraten). Eine **gelöschte** Übersetzung leitet zurück auf das Primär-Handle. Bewusst offen: eine Kollision mit dem Handle eines *anderen* Objekts in einer anderen Sprache wird nicht geprüft — `ContentTranslation.value` hat keinen Index.
4. **IndexNow am Statuswechsel (§A2).** Produkte/Collections sind über Webhooks abgedeckt; für **Pages, Artikel und Blogs existiert kein Webhook** — eine hier angelegte Page erreicht IndexNow erst beim manuellen Katalog-Versand. Enqueue gehört an den Übergang auf `ACTIVE`/`isPublished`, nicht an den Create (Draft-URLs pingt man nicht); die Regel dafür ist `shouldEnqueueProductChange`, für Artikel `articleUrl` + `enqueueIndexNowUrl`.
5. **Übersetzungs-Semantik markieren:** `tags`, `vendor`, `category`, `status`, `price` bekommen `supportsTranslation: false` und im Fremdsprachen-Modus einen erklärenden deaktivierten Zustand. `productType` bleibt übersetzbar — dort greift `GroupedFieldTranslation` (shop-weit einheitlich), das darf nicht umgangen werden.
6. **Bulk-Editor nachziehen:** `vendor` und `tags` als Spalten (`status` existiert bereits).

---

### Phase 4 — Commerce: Bestand, Lagerorte, Vertriebskanäle

Die Phase mit dem Scope-Change → **ein Deploy, eine Re-Consent-Runde**. Vorher prüfen, ob sonst noch etwas an Scopes ansteht. Siehe auch den Review-Einwand in §8.1.

1. **Scopes** aus §2.1 in **beide** TOMLs.
2. **Schema + Sync:** `ProductVariant` um `cost`, `taxable`, `weight`, `weightUnit`, `requiresShipping`, `harmonizedSystemCode`, `countryCodeOfOrigin`, `inventoryTracked`, `inventoryPolicy`; neue Tabellen für Bestand pro Location und einen Location-Cache. **Beide sind shop-scoped → GDPR-Drift-Guard** (Phase 0, Schritt 2). Bestände sind volatil: der Cache ist Anzeige, die Wahrheit steht bei Shopify.
3. **Schreiben:** `inventoryItem`-Felder über `productSet`/`inventoryItemUpdate`, Mengen über `inventorySetQuantities` — **nie Delta-Rechnung auf Cache-Werten**, das ist die klassische Quelle für Bestandsdrift.
4. **Vertriebskanäle:** `publications` auflisten, `publishablePublish`/`publishableUnpublish`. UI im Create-Modal (Default Online Store), im Editor und im Attribute-Tab.
5. **Task-Recovery:** falls hier ein Long-Running-Task entsteht, muss sein Typ in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](../../task-recovery.service.js#L34)) — sonst wird er nach ~10 statt 45 Minuten als hängend gereapt.
6. **Merchant-Kommunikation:** ein Release-Hinweis in der App, der erklärt, *warum* die App jetzt Bestand und Kanäle sehen will. Gehört zum Umfang, nicht als Nachtrag.

**Bestandsführung ist ein Write-Pfad mit echtem Geldwert** — die Echo-Regel gilt hier strenger: eine Mengenänderung ist erst erfolgreich, wenn Shopify die neue Menge zurückliefert. Kein optimistisches UI-Update.

---

## 5. Risiken und Invarianten

| Risiko | Umgang |
|---|---|
| **2025-10 wird am 2026-10-16 unerreichbar** | Phase −1 (Umzug auf 2026-07) vor allem anderen — unabhängig von diesem Plan fällig |
| Collections mit dem neuen Mehrquellen-Modell sind auf 2025-10 **unsichtbar** (kein Fehler, sie fehlen einfach) | Phase −1; danach ein voller `syncAllCollections`, weil Reload nur bekannte IDs auffrischt |
| `@idempotent` ist ab 2026-04 auf Inventory-Mutationen Pflicht | Phase 4 sendet es von Anfang an mit |
| Scope-Erweiterung = Re-Consent | Phase 0–3 ohne; Phase 4 bündelt **alle** Scopes in EINEN Deploy, in **beiden** TOMLs, + Release-Hinweis |
| Zweiter Write-Pfad neben `handleUnifiedContentActions` | `createContent` als Case im bestehenden Switch |
| „Übersetzt gleich mit" rutscht in den Create-Handler | Create schreibt nur die Primärsprache; Übersetzung ist ein **nachgelagerter** Client-Aufruf von `translateAll` (§2.5a) |
| Stiller No-Op | Echo-Prüfung auf `id` + Kernfelder **inkl. der SEO-Metafelder** bei Page/Artikel/Blog |
| **SEO auf Page/Artikel/Blog stillschweigend verloren** | Zweiter `metafieldsSet`-Schritt, mit `type`, ohne `""` (§1.3) |
| Duplikate durch Retry/Reload | `identifier: { handle }` oder Request-ID-Dedup — ein gesperrter Button reicht nicht (§1.7) |
| Angelegtes Objekt nicht mehr loszuwerden | Undo-Pfad §1.8 — es gibt heute KEIN Content-Delete im Repo |
| Bild zweimal in der Media-Library | Genau EIN Upload-Weg: staged URL direkt in den Create, kein `fileCreate` davor (§1.4) |
| „Aktiv" ohne Publication = unsichtbar | Status und Kanäle getrennte Controls und Zeilen (§2.3) |
| Bestandsdrift durch Delta-Rechnung | `inventorySetQuantities` gegen frisch gelesene Werte + Echo auf die Menge |
| Plan-Gate clientseitig umgehbar | Beide Stufen serverseitig (`canAccessContentType` **und** Menge) |
| Client erfindet Felder/Regeln | Validierung gegen `create-fields.config.ts` + `collection-rules.shared.ts` |
| Regelwerk, das der Editor nicht rendert | read-only + Admin-Link, `sourcesJson` spiegelt den vollen Baum (§2.4) |
| Mächtiges Regelformular erschlägt den einfachen Fall | Standardansicht = klassische Smart Collection, Rest hinter „Erweitert" |
| Handle-Änderung bricht die alte URL | `createRedirect` einhängen (Phase 3.3) |
| Neue Pages/Artikel erreichen IndexNow nie | Enqueue am Statuswechsel (Phase 3.4) |
| Primärtext ignoriert das Glossar, Übersetzung nicht | `getGlossaryDirective` auch in die `generate*`-Methoden (§2.5e) |
| SEO-Score im Modal ≠ Score in der Sidebar | Shop-`seoLimits` + Suffix + `excludeImages` durchreichen (§2.5b) |
| Neue shop-scoped Modelle brechen den GDPR-Test | `redactShopData()` mitpflegen (Phase 0) |
| Neue Spalten `null` vor dem ersten Sync | „unbekannt" ≠ „fehlt" |
| Single-Language-Regeln | Modal zeigt keine Locale-UI; die „danach übersetzen"-Checkbox: disable + Tooltip, nicht verstecken |
| Entwurf geht beim Wegnavigieren verloren | `confirmNavigation()`; **kein** localStorage — App-Store-Compliance (§1.4) |

**Abschluss laut Working Agreement:** systemrelevanter Umbau (neuer Write-Pfad, Schema-Migration, geteilte Komponenten, alle AI-Generierungspfade durch §2.5e). Nach grünem `typecheck`/`test` ein unabhängiger Review-Pass (`/code-review high`), Befunde **vor** der Fertigmeldung beheben.

---

## 6. Reihenfolge und Aufwand

| Phase | Inhalt | Aufwand | Scope-Change |
|---|---|---|---|
| **−1** | **API-Umzug 2025-10 → 2026-07 — Frist 2026-10-16, auch ohne diesen Plan fällig** | **1–2 Tage** | nein |
| 0 | Migration, Sync-Felder, Join-Modell, `blog`-Case, Messungen | 1–2 Tage | nein |
| 1 | Create-Modal + `createContent`, sechs Typen, Idempotenz, Undo, Duplizieren | 3–4 Tage | nein |
| 1.4b | ✅ `CollectionRuleBuilder` + `collection-rules.shared.ts`, im Create-Modal **und** im Editor bestehender Collections (API-Guard ≥2026-07, Bearbeiten als Bedingungs-Diff) |
| 1b | Rename `SeoSidebar` → `ItemSidebar` (eigener Commit) | ~1 h | nein |
| 2 | Attribute-Tab | 1 Tag | nein |
| 3 | Feldtypen, Status, Preis, Redirects, IndexNow | 3–4 Tage | nein |
| 4 | Bestand, Lagerorte, Vertriebskanäle | 4–6 Tage | **ja — Re-Consent** |

Phase 1 ist ohne 2–4 auslieferbar. Phase 2 ist ohne 3 nützlich (zeigt Lücken, verlinkt in den Admin). Phase 4 ist die einzige, deren Auslieferung Merchants aktiv betrifft — nicht als Erstes.

---

## 7. Tests (Pflicht pro Phase)

Das Repo hat 109 Unit-Test-Dateien; der Hausstandard ist höher als „wird schon".

- **Phase 0:** Schema-Migration + GDPR-Drift-Guard (`gdpr.service.test.ts` muss grün bleiben); Sync-Mapping der neuen Felder.
- **Phase 1:** Server-Validierung gegen `create-fields.config.ts` (unbekanntes Feld wird verworfen); Echo-Prüfung inkl. fehlgeschlagenem `metafieldsSet`; **beide** Plan-Gates (`canAccessContentType` und Menge); Handle-Kollision; Idempotenz bei doppeltem Submit; Create-ohne-Sync-Pfad meldet Erfolg.
- **Phase 1.4b:** Enum-Validierung des Regel-Editors; `sources`-Roundtrip durch `sourcesJson` **ohne Strukturverlust**; nicht renderbare Struktur wird read-only und nicht überschrieben.
- **Phase 2:** `null` → „unbekannt"; Foreign-Locale read-only.
- **Phase 3:** Redirect nur bei Änderung und nicht bei Neuanlage; IndexNow nicht bei `DRAFT`; Status-Enum deckt alle vier Werte und deckt sich mit `PRODUCT_STATUSES`.
- **Phase 4:** Bestand-Echo; kein Delta auf Cache-Werten.

**i18n:** jeder neue String in **de/en/es** — nicht nur in Phase 2.

---

## 8. Review-Einwände, die eine Nachentscheidung verdienen

Der Review hat drei Punkte gegen bereits getroffene Entscheidungen vorgebracht. Ich habe die Entscheidungen **nicht** eigenmächtig gekippt — sie stehen hier zur Wahl.

**8.1 Phase 4 aufteilen?** Der Einwand: Vier Scopes und eine Re-Consent-Runde bei jedem Merchant, 4–6 Tage, ein Write-Pfad mit Geldwert — für den einen Bereich, in dem der Shopify-Admin wirklich gut ist und eine Content-/Übersetzungs-App nichts Eigenes beisteuert. §2.2 macht das Produkt bereits verkaufsfähig. Was Phase 4 *wirklich* löst, ist die **Kanal**-Hälfte — und die adressiert das Top-Risiko „erstellt, aber unsichtbar". Vorschlag des Reviews: Re-Consent nur für `write_publications` ausgeben, Bestand/Lagerorte per Admin-Deep-Link. **Status: offen, Entscheidung §2.1 steht bis auf Widerruf.**

**8.2 Sub-Collections und Varianten-Targeting doch aufnehmen?** In §2.4 stehen sie derzeit unter der Read-only-Regel — sie fügen einem Formular, dessen Überfrachtung wir fürchten, je ein eigenes mentales Modell hinzu, und der Fallback deckt sie zu Nullkosten ab. Wer „mehr als Shopify" maximal auslegt, könnte anders entscheiden. **Status: als draußen geplant.**

**8.3 Menüeintrag nach dem Anlegen einer Page.** Eine Page in keinem Menü ist für Käufer unsichtbar — dieselbe Klasse wie „ACTIVE ohne Publication". Die App hat `write_online_store_navigation` im Scope und ein `Menu`-Modell; die Menüseite ist read-only, aber laut ihrem eigenen Kommentar wegen fehlender *Übersetzbarkeit*, nicht wegen einer Schreibgrenze. `menuCreate`/`menuUpdate` müssten gegen die Zielversion geprüft werden; das Einfügen in den verschachtelten `items`-Baum ist fummelig. **Status: nicht eingeplant, Aufwand mittel.**

**8.4 Bulk-Create über die vorhandene CSV-Pipeline.** [csv-import.server.ts](../../app/services/bulk-editor/csv-import.server.ts) + `csv.shared.ts` sind eine vollständige, getestete, Pro-gegatete Import-Pipeline mit Preview und Caps — sie kann heute nur updaten (`resolveCsvRowId` wirft für Zeilen ohne Treffer). Zeilen *ohne* ID zu Creates zu machen wäre das kleinstmögliche „viele anlegen". **Vorbehalt:** CLAUDE.md beschreibt `applyBulkDiff` als DEN einen Write-Pfad mit genau drei Eingängen — Creates darin wären eine bewusste Erweiterung, keine stille. **Status: nicht v1**, aber hier festgehalten, damit niemand einen zweiten CSV-Parser baut.

**8.5 Weitere Kandidaten, bewusst zurückgestellt:** interne Verlinkung auf ein neues Objekt anbieten (`runInternalLinkSuggestions`, als Button in der Post-Create-InfoBox — der SEO-Contract verbietet automatisches Feuern langer Scans); Metafelder schon im Create-Formular (`scanProductMetafields` weiß, welche der Shop hat); ein shop-weites Alt-Text-Template als deterministische Alternative zum AI-Call (`fillAltTextTemplate`).

---

## 9. Stückpreis (Grundpreis) — gemessen, 2026-08-19, API 2026-07

Shopify zeigt auf seiner eigenen Variantenseite eine Box „Stückpreis": Gesamtmenge einer Packung (500 g) und eine Referenzeinheit (1 kg), woraus die Storefront „CHF 22.90 · CHF 45.80 / kg" macht. Das ist eine Preisauszeichnungspflicht (PAngV in DE, PBV in CH, Richtlinie 98/6/EG hinter beiden) und betrifft alles, was nach Gewicht oder Volumen verkauft wird.

Ob das Feld **schreibbar** ist, stand nicht in der Doku. Gemessen mit [api.unit-price-probe.tsx](../../app/routes/api.unit-price-probe.tsx) (Settings → Probes → Unit price, dev-only) auf einem echten Shop:

| Frage | Antwort |
|---|---|
| Feld im Input? | **ja** — `ProductVariantsBulkInput.unitPriceMeasurement`, dazu `showUnitPrice` |
| `UnitPriceMeasurementInput` | `quantityValue`, `quantityUnit`, `referenceValue`, `referenceUnit` |
| Einheiten-Enum | **nicht `WeightUnit`.** `ML, CL, L, M3, FLOZ, PT, QT, GAL, MG, G, KG, OZ, LB, MM, CM, M, IN, FT, YD, M2, FT2, ITEM, UNKNOWN` |
| Schreiben | **ja**, Echo bestätigt |
| Löschen mit `unitPriceMeasurement: null` | **nein** — akzeptiert, keine `userErrors`, Wert bleibt stehen |
| Löschen mit der ausgeschriebenen leeren Messung | **ja** |

Die dritte und die fünfte Zeile sind die teuren. `null` ist eine **Abwesenheit**, die die Mutation überspringt; der leere Zustand ist ein **Wert**, und genau als solcher liest eine Variante ohne Grundpreis zurück (`{quantityValue: 0, quantityUnit: null, referenceValue: 0, referenceUnit: null}` — **nicht** `null`). `EMPTY_MEASUREMENT_INPUT` in der Probe-Route hält die Schreibweise fest; wer das Feature baut, nimmt sie von dort, sonst schlägt das Löschen still fehl und der Merchant bekommt einen falschen Grundpreis nicht mehr weg.

Ebenfalls messbar geworden, weil es zweimal falsch beantwortet wurde: **eine Antwort, die den vorgefundenen Zustand wiederholt, ist keine Messung.** Der erste Lauf meldete „hide: yes", weil `showUnitPrice` schon vorher `false` war und jeder Versuch brav `false` zurückgab; ein zweiter meldete `null` als funktionierenden Lösch-Weg, weil die Variante bereits leer war. Beide Schritte prüfen jetzt gegen den Vorher-Zustand, und der Schalter wird **umgelegt und zurückgelegt** statt gelesen.

**Nachgemessen (zweiter Lauf):** `unitPriceMeasurement: null` wird akzeptiert und ignoriert; die **ausgeschriebene leere Messung** löscht. Das ist der Weg, den `EMPTY_MEASUREMENT_INPUT` festhält.

**Weiterhin offen — und das Feature ist damit gebaut, nicht darauf gewartet:** ob `showUnitPrice` ein echter, umkehrbarer Schalter ist. Auf dem Messshop war er durchgehend `false`, also nie bewegt; die Probe legt ihn inzwischen um und wieder zurück, dieser Lauf steht aus. Der Schalter wird trotzdem angeboten: gated die Storefront den Grundpreis daran, hiesse Zurückhalten, eine Messung zu schreiben, die niemand sieht. Der Preis eines Irrtums ist durch das Echo begrenzt — ein Schalter, der sich nicht bewegt, meldet sich mit einem **eigenen** Code (`unitPriceNotShown`), während die Messung gespeichert bleibt. Ebenfalls ungemessen: ob die Storefront den Grundpreis zeigt, solange der Schalter aus ist.

**Bewusst nicht validiert, weil ungemessen:** was Shopify mit gemischten Dimensionen macht (500 **g** pro 1 **l**). Diese App lehnt das Paar selbst ab (`unitPriceDimension`), statt es auf einer Storefront herauszufinden.

**Entscheidung fürs UI, wenn gebaut wird:** eigenes Disclosure in der Preise-Card, wie der Zoll-Block im Versand. Shopifys Popover-Muster (alles ausser dem effektiven Preis hinter einem Aufklapper) wird **nicht** breit übernommen: die drei Preise stehen bewusst nebeneinander, und beim Bulk-Edit über mehrere Varianten müsste man sonst pro Feld auf- und zuklappen.
