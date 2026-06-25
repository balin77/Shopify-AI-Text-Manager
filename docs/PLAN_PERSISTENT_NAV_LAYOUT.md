# Plan: Persistente Navigation via Remix-Layout-Route

> **Branch:** `refactor/persistent-nav-layout`
> **Strategie:** EIN atomarer Commit (vollständiger Refactor in einem Schritt — Rollback per `git revert`)
> **Status:** Bereit zur Umsetzung
> **Erstellt:** 2026-06-25

---

## Ziel

Die App-Navigation (`MainNavigation` + `ContentTypeNavigation` inkl. `RubricNavigation`) wird heute auf **jeder Seite einzeln** gerendert und bei jeder Sub-Page-Navigation unmountet + neu gemountet. Resultat: alle `useEffect`-Hooks der Nav laufen neu, Komponenten-State (offene Popover, gerade angezeigte InfoBox-Nachricht) geht verloren, Height-Measurement und ResizeObserver laufen erneut, sichtbares Flackern.

Nach dem Refactor wird die Nav **einmal pro App-Lifecycle** im Layout-Route `app.tsx` gemountet und bleibt über alle Sibling-Navigationen hinweg bestehen. Nur die Outlet-Inhalte wechseln. Das ist die offiziell vorgesehene Remix-Architektur und entspricht dem Shopify-App-Template-Standard.

---

## Architektur-Wechsel

### Ist-Zustand

```
app.tsx (Layout-Route)
  └── <Outlet />
        ├── app.products.tsx
        │     └── <div>
        │           <MainNavigation />          ← jedes Mal neu gemountet
        │           <ContentTypeNavigation />   ← jedes Mal neu gemountet
        │           <Content />
        ├── app.collections.tsx
        │     └── <div>
        │           <MainNavigation />          ← jedes Mal neu gemountet
        │           <ContentTypeNavigation />   ← jedes Mal neu gemountet
        │           <Content />
        └── … (12 weitere Routen mit gleichem Pattern)
```

### Soll-Zustand

```
app.tsx (Layout-Route)
  └── <div style={display: flex, flexDirection: column, minHeight: 100vh}>
        <MainNavigation />          ← mountet EINMAL
        <ContentTypeNavigation />   ← mountet EINMAL (returnt null auf Non-Content-Pages)
        <main style={{flex: 1, minHeight: 0}}>
          <Outlet />                 ← nur DIESER Bereich wechselt
            ├── app.products.tsx     → nur noch Content
            ├── app.collections.tsx  → nur noch Content
            └── …
        </main>
```

---

## Bestätigte Remix-Fakten (siehe Quellen am Ende)

1. **Komponenten-Persistenz**: Parent-Route-Komponenten bleiben gemountet, wenn der Nutzer zwischen Sibling-Children navigiert. Nur der `<Outlet />` swappt seinen Inhalt aus.
2. **Loader-Verhalten**: Sibling-Navigation triggert per Default **KEIN** Re-Run des Parent-Loaders. `app.tsx`'s `loader` läuft nicht erneut beim Wechsel zwischen Sub-Pages (außer bei Action-Submit oder param-Wechsel auf Parent-Level).
3. **Komponenten-State erhalten**: React-Komponenten-State (useState, useRef) bleibt erhalten, useEffect-Cleanups laufen NICHT bei Sibling-Navigation.
4. **Shopify-App-Template**: Das offizielle Shopify-Remix-Template macht genau das — Nav im `app.tsx`-Layout, Children rendern nur Content.

---

## Inventar — Alle Render-Sites der Navigation

### Gruppe A — Content-Routes mit beiden Bars (8 Files)
Diese Routen rendern aktuell sowohl `<MainNavigation />` als auch `<ContentTypeNavigation />` direkt:

| Datei | Zeile MainNav | Zeile ContentTypeNav |
|---|---|---|
| `app/routes/app.blog.tsx` | 311 | 312 |
| `app/routes/app.collections.tsx` | 186 | 187 |
| `app/routes/app.direct-translations.tsx` | 725 | 726 |
| `app/routes/app.menus.tsx` | 124 | 125 |
| `app/routes/app.metaobjects.tsx` | 239 | 240 |
| `app/routes/app.pages.tsx` | 139 | 140 |
| `app/routes/app.policies.tsx` | 221 | 222 |
| `app/routes/app.products.tsx` | 865 | 866 |

### Gruppe B — Nicht-Content-Routes nur mit MainNav (3 Files)

| Datei | Zeile |
|---|---|
| `app/routes/app.metadata.tsx` | 75 |
| `app/routes/app.settings.tsx` | 1012 |
| `app/routes/app.tasks.tsx` | 304 |

### Gruppe C — Theme-Routes via Shared-Component (6 Routes, 1 Component)

Alle diese Routen rendern über die Shared-Component `ThemeContentDomainPage`:

- `app/routes/app.cookie-banner.tsx`
- `app/routes/app.delivery.tsx`
- `app/routes/app.online-store-extras.tsx`
- `app/routes/app.selling-plans.tsx`
- `app/routes/app.system.tsx`
- `app/routes/app.templates.tsx`

Die Nav wird in `app/components/ThemeContentDomainPage.tsx` Zeilen 912-913 gerendert — also nur eine Code-Stelle für alle 6 Routen.

### Gruppe D — PlanAccessGate (Wrapper für 6 Routen)

`app/components/PlanAccessGate.tsx` Zeilen 41-42 rendert Nav in der "kein Zugriff"-Branch. Wird umhüllt von:

- `app/routes/app.blog.tsx`
- `app/routes/app.direct-translations.tsx`
- `app/routes/app.menus.tsx`
- `app/routes/app.metaobjects.tsx`
- `app/routes/app.pages.tsx`
- `app/routes/app.policies.tsx`

### Gruppe E — Edge-Cases (keine Nav, bleibt so)

- `app/routes/app._index.tsx` — Redirect zu `/app/products`
- `app/routes/app.content.tsx` — Legacy-Redirect
- `app/routes/app.setup.tsx` — Theme-Extension-Onboarding-Wizard (bisher ohne Nav; nach Refactor bekommt er sie — bewusste Entscheidung, weil eigenständiger Sub-Flow innerhalb der App)
- `app/routes/app.clear-session.tsx`, `app.billing.callback.tsx`, `app.debug-scopes.tsx` — Utilities

### Variationen der Wrapper-Struktur (relevant für Layout-Übernahme)

Die einzelnen Routen wickeln ihre Inhalte unterschiedlich ein — beim Entfernen der Nav-Zeilen den Wrapper jeweils unverändert lassen:

- **`<div style={display:flex,height:100vh,overflow:hidden}>`-Wrapper** (z.B. `app.products.tsx:864`): bleibt; aus `100vh` wird de-facto die Restfläche unter dem persistenten Nav (Layout ist Flex-Column).
- **`<Page fullWidth>`-Wrapper** (z.B. `app.tasks.tsx:303`, `app.settings.tsx:1011`): bleibt.
- **`<PlanAccessGate><Page>`-Wrapper** (z.B. `app.menus.tsx:122-123`): bleibt; Gate-Logik unverändert.

---

## Schritt-für-Schritt-Migration

### Phase 1 — Vorbereitung: `ContentTypeNavigation` safe-für-Always-On machen

**File:** `app/components/ContentTypeNavigation.tsx`

**Problem:** Heute rendert die Komponente immer die L3-`<div>`-Bar, auch wenn keine aktive Rubrik existiert (Non-Content-Pages). Sie würde im Layout-Route als leerer weißer Streifen erscheinen.

**Fix:** Early-Return-Guard direkt nach den `useEffect`-Calls und vor dem `return (<>...)`-Block:

```tsx
// Vorher
return (
  <>
    <RubricNavigation />
    <div ref={navRef} className="desktop-only content-type-nav" ...>
      ...
    </div>
  </>
);

// Nachher
if (!activeRubric) return null;

return (
  <>
    <RubricNavigation />
    <div ref={navRef} className="desktop-only content-type-nav" ...>
      ...
    </div>
  </>
);
```

`RubricNavigation` hat bereits einen analogen Guard ([RubricNavigation.tsx](../app/components/RubricNavigation.tsx)) — die Komponente returned `null` auf Non-Content-Pages. Das `setContentNavHeight(0)` darf nicht weggefallen werden — den Effect-Block, der bei `!activeRubric` `setContentNavHeight(0)` setzt, vor dem Early-Return belassen.

Konkret muss der useEffect-Block, der die Höhe misst, auch die Reset-auf-0-Logik enthalten:

```tsx
useEffect(() => {
  if (!activeRubric) {
    setContentNavHeight(0);
    return;
  }
  // … existing measurement logic …
}, [activeRubric, setContentNavHeight, entries.length]);
```

### Phase 2 — Layout-Route: Nav in `app.tsx` einbauen

**File:** `app/routes/app.tsx`

**Imports hinzufügen** (oben zu den anderen Component-Imports):

```tsx
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
```

**Im `AppContent`-Komponenten-Body**, den `return`-Block ändern von:

```tsx
return (
  <AppErrorBoundary>
    <InitialSyncBanner />
    <Outlet />
  </AppErrorBoundary>
);
```

zu:

```tsx
return (
  <AppErrorBoundary>
    <InitialSyncBanner />
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <MainNavigation />
      <ContentTypeNavigation />
      <main style={{ flex: 1, minHeight: 0 }}>
        <Outlet />
      </main>
    </div>
  </AppErrorBoundary>
);
```

**Wichtig:** `InitialSyncBanner` bleibt OBERHALB des Flex-Containers (sonst bricht das aktuelle Banner-Verhalten).

### Phase 3 — Group A entrümpeln (8 Files)

In **jeder** der folgenden Files:

- `app/routes/app.blog.tsx`
- `app/routes/app.collections.tsx`
- `app/routes/app.direct-translations.tsx`
- `app/routes/app.menus.tsx`
- `app/routes/app.metaobjects.tsx`
- `app/routes/app.pages.tsx`
- `app/routes/app.policies.tsx`
- `app/routes/app.products.tsx`

**3a) Imports entfernen** (oben in der Datei):

```tsx
import { MainNavigation } from "../components/MainNavigation";          // ← weg
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";  // ← weg
```

**3b) Render-Zeilen entfernen** (siehe Inventar §Gruppe A für genaue Zeilennummern, jeweils direkt aufeinanderfolgend):

```tsx
<MainNavigation />          // ← weg
<ContentTypeNavigation />   // ← weg
```

**3c) Wrapper-`<div>` mit `height: 100vh` beibehalten** — er wird zum Content-Container unter dem persistenten Nav. Wenn nach dem Test ein Scrollbalken zu viel erscheint, im individuellen Route den Wrapper-Style anpassen:

```tsx
// Vorher
<div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>

// Falls Scrollbalken auftritt:
<div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
```

Diese Wrapper-Anpassung ist nur dann nötig, wenn der Browser-Test einen doppelten Scrollbalken zeigt. Default: erst mal so lassen.

### Phase 4 — Group B entrümpeln (3 Files)

In **jeder** der folgenden Files:

- `app/routes/app.metadata.tsx` (Zeile 75)
- `app/routes/app.settings.tsx` (Zeile 1012)
- `app/routes/app.tasks.tsx` (Zeile 304)

**4a) Import entfernen**:

```tsx
import { MainNavigation } from "../components/MainNavigation";  // ← weg
```

**4b) Render-Zeile entfernen**:

```tsx
<MainNavigation />  // ← weg
```

Diese Routen rendern KEINE `ContentTypeNavigation`, also dort nichts entfernen.

### Phase 5 — `ThemeContentDomainPage` entrümpeln (1 File für 6 Routen)

**File:** `app/components/ThemeContentDomainPage.tsx`

**5a) Imports entfernen** (Zeilen 19-20):

```tsx
import { MainNavigation } from "./MainNavigation";          // ← weg
import { ContentTypeNavigation } from "./ContentTypeNavigation";  // ← weg
```

**5b) Render-Zeilen entfernen** (Zeilen 912-913):

```tsx
<MainNavigation />          // ← weg
<ContentTypeNavigation />   // ← weg
```

### Phase 6 — `PlanAccessGate` entrümpeln

**File:** `app/components/PlanAccessGate.tsx`

**6a) Imports entfernen** (Zeilen 18-19):

```tsx
import { MainNavigation } from "./MainNavigation";          // ← weg
import { ContentTypeNavigation } from "./ContentTypeNavigation";  // ← weg
```

**6b) Gate-Branch vereinfachen** (Zeilen 39-50). Die "kein Zugriff"-Branch braucht die Nav nicht mehr, weil sie bereits vom Layout-Route gerendert wird:

```tsx
// Vorher
return (
  <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
    <MainNavigation />
    <ContentTypeNavigation />
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <Text as="p" variant="bodyMd" tone="subdued">
        {t.content?.upgradeToAccessFeature?.replace("{plan}", planName)
          || `Upgrade to ${planName} to access this feature.`}
      </Text>
    </div>
  </div>
);

// Nachher
return (
  <div style={{ padding: "2rem", textAlign: "center" }}>
    <Text as="p" variant="bodyMd" tone="subdued">
      {t.content?.upgradeToAccessFeature?.replace("{plan}", planName)
        || `Upgrade to ${planName} to access this feature.`}
    </Text>
  </div>
);
```

### Phase 7 — Verifikation

**7a) Sanity-Greps** — sollten KEINE Treffer mehr liefern (außer im Layout-Route `app.tsx`):

```bash
grep -rn "import.*MainNavigation" app/routes app/components
# Erwartete Treffer: nur app/routes/app.tsx und app/components/MainNavigation.tsx

grep -rn "import.*ContentTypeNavigation" app/routes app/components
# Erwartete Treffer: nur app/routes/app.tsx und app/components/ContentTypeNavigation.tsx

grep -rn "<MainNavigation" app/routes app/components
# Erwartete Treffer: nur app/routes/app.tsx

grep -rn "<ContentTypeNavigation" app/routes app/components
# Erwartete Treffer: nur app/routes/app.tsx
```

**7b) Type-Check**:

```bash
npx tsc --noEmit
```

Bestehende Prisma-Fehler (domain-Felder in `theme-content-domain`, `background-sync`, `planCacheCleanup`, `app.settings.tsx`) sind vor-existent und nicht relevant für diesen Refactor. Filtern mit:

```bash
npx tsc --noEmit 2>&1 | grep -vE "domain|theme-content-domain|background-sync|planCacheCleanup|app.settings.tsx"
```

Sollte leer sein.

**7c) Browser-Smoke-Test**:

1. App im Browser öffnen, auf `/app/products` landen
2. InfoBox-Nachricht triggern (z.B. via fehlenden API-Key)
3. Auf "Tasks"-Tab klicken — **InfoBox-Nachricht soll sichtbar bleiben** (Beweis für persistente Komponente)
4. Auf "Settings"-Tab klicken — Nav bleibt still, nur Content wechselt
5. Nachrichten-Glocken-Popover öffnen, dann Tab wechseln — Popover bleibt offen
6. Auf eine Content-Page (z.B. `/app/collections`) — beide Bars sichtbar
7. Auf `/app/tasks` zurück — L2+L3 verschwinden sauber (kein leerer weißer Streifen unter L1)
8. Plan-Gate testen: auf free-Plan zu `/app/menus` — Upgrade-Message erscheint UNTER der persistenten Nav (statt mit eigener Nav-Kopie)
9. Mobile-Viewport (<900px): Hamburger-Menü öffnen, Tab wechseln — bleibt offen
10. Im React DevTools Profiler einen Tab-Wechsel aufzeichnen — `MainNavigation` darf NICHT im "Mounted"-Set auftauchen

**7d) Sticky-Positioning-Regression**:

- Auf `/app/products` mit vielen Produkten scrollen — L1+L2+L3 bleiben sticky am oberen Rand
- Auf `/app/menus` scrollen — gleiche Erwartung
- Auf `/app/settings` scrollen — nur L1 sticky (kein L2/L3 auf Non-Content)

---

## Risiken & Edge-Cases

| Risiko | Wahrscheinlichkeit | Schweregrad | Mitigation |
|---|---|---|---|
| Routen mit `height: 100vh`-Wrapper bekommen doppelten Scrollbalken | Mittel | Kosmetik | Bei Auftreten Wrapper-Style auf `flex: 1, minHeight: 0` ändern |
| `app.setup.tsx` zeigt plötzlich Nav (bisher nicht) | Hoch (sicher) | Akzeptiert | Bewusste Designentscheidung — konsistenter Sub-Flow |
| `app._index.tsx`/`app.content.tsx` zeigen kurz Nav vor Redirect-Effect | Niedrig | Aufblitzen | Akzeptabel; alternativ Loader-side `throw redirect(…)` |
| `NavigationHeightContext`-Konsumenten (`UnifiedItemList`, `UnifiedContentEditor`, `app.menus.tsx`) bekommen jetzt KONSTANTE Höhen | Niedrig | Eher Verbesserung | Smoke-Test bestätigt |
| Polaris `<Page>`-Wrapper-Unterschiede zwischen Routen | Niedrig | Visuell | Bewusst beibehalten — Routen entscheiden weiterhin individuell |
| Sticky `top` der Sub-Bars funktioniert nicht mehr | Niedrig | Funktional | Sticky funktioniert in beliebigem Scroll-Container — top-Wert basiert auf gemessenem `mainNavHeight`, unverändert |
| Embedded-App-Auth bricht | Sehr niedrig | Funktional | AppProvider-Wrap bleibt unverändert in `app.tsx` |
| `extensionSetupHint`-Effect in `AppContent` braucht InfoBox in der Nav | Niedrig | Funktional | InfoBox lebt schon im `InfoBoxProvider` (Context) — Nav-Komponente liest sie nur; Effect bleibt funktional |

---

## Erwartetes Verhalten nach Refactor

✅ Nav-Komponenten mounten EINMAL beim ersten App-Load
✅ Keine Re-Runs von Nav-`useEffect`-Hooks (Height-Measuring, Notification-Subscriptions) bei Sibling-Navigation
✅ InfoBox-Nachricht, offene Popover, Selektionen in der Nav bleiben über Navigation hinweg erhalten
✅ Sichtbar im Browser: Nav-Bars stehen visuell still, nur Outlet-Inhalt wechselt
✅ Loader von `app.tsx` läuft NICHT erneut bei Sub-Page-Wechsel
✅ Child-Route-Loader laufen wie gehabt (das ist gewollt)
✅ Sticky-Positioning aller drei Bars unverändert

---

## Commit-Strategie

**EIN atomarer Commit** auf eigenem Branch `refactor/persistent-nav-layout`.

```bash
git checkout -b refactor/persistent-nav-layout
# … alle Phasen 1-6 …
git add -A
git commit -m "refactor(nav): lift MainNavigation/ContentTypeNavigation into app layout route

Moves the nav from per-route render sites into the parent layout
route (app.tsx) so it mounts once per app lifecycle and persists
across sibling navigation — the idiomatic Remix nested-route pattern.

Removes 14 render sites across routes and shared components (groups
A–D in PLAN_PERSISTENT_NAV_LAYOUT.md). Visual result is identical;
behavior change is that nav state (InfoBox, popover, height
measurements) now survives tab switches instead of being remounted.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

**Rollback** bei Problemen: `git revert <commit-sha>`.

---

## Reihenfolge für den Agenten (TL;DR)

1. **Branch erstellen**: `git checkout -b refactor/persistent-nav-layout` (von aktuellem `develop`)
2. **Phase 1**: `ContentTypeNavigation.tsx` Early-Return-Guard einbauen
3. **Phase 2**: `app.tsx` AppContent erweitern — Nav + Outlet im Flex-Container
4. **Phase 3**: 8 Group-A-Routes entrümpeln (Imports + Render-Zeilen)
5. **Phase 4**: 3 Group-B-Routes entrümpeln
6. **Phase 5**: `ThemeContentDomainPage.tsx` entrümpeln
7. **Phase 6**: `PlanAccessGate.tsx` Gate-Branch vereinfachen
8. **Phase 7a**: Sanity-Greps laufen lassen
9. **Phase 7b**: Type-Check
10. **Phase 7c**: Browser-Smoke-Test (alle 10 Schritte oben)
11. **Phase 7d**: Sticky-Scroll-Regression
12. **Commit + Push**: Single atomic commit auf `refactor/persistent-nav-layout`

**Geschätzter Aufwand:** ~20 Files berührt (14 Routes/Components + 2 neue Imports im Layout + 1 Early-Return-Fix). Reine Mechanik nach diesem Plan — keine Architektur-Entscheidungen mehr offen.

---

## Quellen (Recherche)

- [Remix Outlet & Layout Persistence — LogRocket Blog](https://blog.logrocket.com/understanding-routes-route-nesting-remix/) — bestätigt Outlet-Parent-Persistenz
- [Remix Route Configuration Docs](https://remix.run/docs/en/main/discussion/routes) — selektives Re-Rendering als Kernfeature
- [Power of Nested Routes — Matt Stobbs](https://www.mattstobbs.com/power-of-nested-routes-in-remix/) — UI-State-Preservation Beispiele
- [Shopify App Template `app.tsx`](https://github.com/Shopify/shopify-app-template-remix/blob/main/app/routes/app.tsx) — offizielles Beispiel: Nav-im-Layout-Route Pattern
- [shopify-app-remix AppProvider Docs](https://shopify.dev/docs/api/shopify-app-remix/v2/entrypoints/appprovider) — bestätigt Layout-Route-Pattern mit Polaris
- [shouldRevalidate — Remix v2 Docs](https://v2.remix.run/docs/route/should-revalidate/) — Sibling-Navigation triggert Parent-Loader nicht
- [Sibling Routes Discussion #5431](https://github.com/remix-run/remix/discussions/5431) — bestätigtes Verhalten bei Sibling-Wechsel
