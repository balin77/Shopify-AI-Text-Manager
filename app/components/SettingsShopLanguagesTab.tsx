/**
 * Settings → Shop-Sprachen: add, publish/unpublish and remove the shop's
 * languages.
 *
 * An unpublished language is one the merchant is PREPARING — this app syncs,
 * edits and auto-translates it like any other (`translationForeignLocales`),
 * and publishing it is the launch. Adding and the publish switches are a DRAFT
 * until the save bar is pressed (CLAUDE.md, "A setting is never saved by the
 * click that changes it"); a new language is created UNPUBLISHED unless its
 * switch was turned on in the same draft. REMOVING is not a setting but an
 * irreversible act on the shop (Shopify discards the language's translations),
 * so it is its own action behind the app's two-step, type-the-name
 * confirmation — the same dialog a product delete uses — and it is offered only
 * while no draft is open, so the two can never ride one request. The server
 * re-reads the shop's languages before any write (shop-locale-publish.server.ts).
 *
 * Language names are shown in the APP's language through
 * `getLocalizedLanguageName` — the helper the language bar and the glossary
 * already render with on both sides, keyed on the app locale from the `app.tsx`
 * loader, so server and browser agree (the stated residual is CLDR drift between
 * ICU builds, CLAUDE.md "Hydration"). Shopify's own `name` is the fallback for a
 * code `Intl` does not know. The dropdown is sorted by the localized name with
 * `compareStrings`, never a bare `localeCompare`.
 */

import { useEffect, useMemo, useState } from "react";
import type { FetcherWithComponents } from "react-router";
import { useFetcher } from "react-router";
import { Badge, Banner, BlockStack, Button, Card, Checkbox, InlineStack, List, Select, Text } from "@shopify/polaris";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ToggleRow } from "./ToggleRow";
import { DisabledActionTooltip } from "./DisabledActionTooltip";
import { DeleteItemModal } from "./create/DeleteItemModal";
import { HelpTooltip } from "./HelpTooltip";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useI18n } from "../contexts/I18nContext";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { compareStrings } from "../utils/format";
import { localizedMarketName } from "../utils/market-name";

interface ShopLanguage {
  locale: string;
  name?: string;
  primary: boolean;
  published: boolean;
}

/** Mirrors `MarketWebPresence` in shop-locale-publish.server.ts (a type import
 *  from a .server module into a component is not worth the bundling question). */
interface MarketPresence {
  id: string;
  marketNames: string[];
  active: boolean;
  label?: string;
  defaultLocale: string;
  locales: string[];
}

interface Props {
  shopLocales: ShopLanguage[];
  /** Languages Shopify lets this shop add; `null` = the lookup failed. */
  availableLocales: Array<{ isoCode: string; name: string }> | null;
  /** The shop's market web presences; `null` = the lookup failed. */
  marketWebPresences?: MarketPresence[] | null;
  fetcher: FetcherWithComponents<any>;
  t: any;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

const ACTION = "saveShopLocalePublication";
const REMOVE_ACTION = "removeShopLocale";

function stateOf(locales: readonly ShopLanguage[]): Record<string, boolean> {
  return Object.fromEntries(locales.filter((l) => !l.primary).map((l) => [l.locale, !!l.published]));
}

/** Per foreign locale, the OFFERED (active-market) presences it is on — sorted, so the draft compares as a string. */
function marketStateOf(locales: readonly ShopLanguage[], presences: readonly MarketPresence[]): Record<string, string[]> {
  return Object.fromEntries(
    locales
      .filter((l) => !l.primary)
      .map((l) => [
        l.locale,
        presences
          .filter((p) => p.active && p.locales.includes(l.locale.toLowerCase()))
          .map((p) => p.id)
          .sort(),
      ]),
  );
}

const sameIds = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && a.every((x) => b.includes(x));

export function SettingsShopLanguagesTab({
  shopLocales,
  availableLocales,
  marketWebPresences = null,
  fetcher,
  t,
  onHasChangesChange,
}: Props) {
  const s = t.settings?.shopLanguages ?? {};
  const { showInfoBox } = useInfoBox();
  const { locale: appLocale } = useI18n();
  const langName = (code: string, fallback?: string) => getLocalizedLanguageName(code, appLocale, fallback);
  /** What the switch's two positions mean; "not saved yet" while it differs from the store. */
  const switchTooltip = (pending: boolean) =>
    [s.switchTooltip, pending ? s.switchTooltipPending : ""].filter(Boolean).join(" ");
  const stored = useMemo(() => stateOf(shopLocales), [shopLocales]);
  // Re-seeded whenever the STORED state changes (after a save revalidated the
  // loader), never while the merchant is mid-draft on an unchanged store.
  const storedKey = JSON.stringify(stored);
  const [draft, setDraft] = useState<Record<string, boolean>>(stored);
  const [adds, setAdds] = useState<
    Array<{ locale: string; name: string; published: boolean; webPresenceIds: string[] }>
  >([]);
  const [pick, setPick] = useState("");
  useEffect(() => {
    setDraft(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  // Which markets show each language — the same draft rule as the switches.
  const presences = marketWebPresences ?? [];
  const offered = presences.filter((p) => p.active);
  const storedMarkets = useMemo(() => marketStateOf(shopLocales, presences), [shopLocales, marketWebPresences]); // eslint-disable-line react-hooks/exhaustive-deps
  const storedMarketsKey = JSON.stringify(storedMarkets);
  const [marketDraft, setMarketDraft] = useState<Record<string, string[]>>(storedMarkets);
  useEffect(() => {
    setMarketDraft(storedMarkets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedMarketsKey]);
  const marketChanges = Object.entries(marketDraft)
    .filter(([locale, ids]) => locale in storedMarkets && !sameIds(ids, storedMarkets[locale]))
    .map(([locale, webPresenceIds]) => ({ locale, webPresenceIds }));
  const toggleMarket = (ids: readonly string[], id: string, on: boolean) =>
    (on ? [...ids, id] : ids.filter((x) => x !== id)).sort();

  // Only locales the shop STILL has: after a removal the draft holds the gone
  // one for a render, and reading it as a change flashed the save bar.
  const changes = Object.entries(draft)
    .filter(([locale, published]) => locale in stored && stored[locale] !== published)
    .map(([locale, published]) => ({ locale, published }));
  const hasChanges = changes.length > 0 || adds.length > 0 || marketChanges.length > 0;
  useEffect(() => {
    onHasChangesChange?.(hasChanges);
  }, [hasChanges, onHasChangesChange]);
  // Leaving the tab discards the draft with it — the page must not keep
  // believing there is something unsaved here.
  useEffect(() => () => onHasChangesChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A failure answers `success: false` with no `error` (the page's generic info
  // box would print raw codes) — the tab lists the failures, puts the refused
  // switches BACK (a refusal must not leave a draft that looks saved), drops
  // the pending additions (what went through shows as stored after the reload,
  // what did not is named in the banner) and reloads when anything did go
  // through. Only a response to a save made in THIS mount counts: the shared
  // fetcher keeps its data across tab switches.
  const [submittedHere, setSubmittedHere] = useState(false);
  const response = submittedHere && fetcher.data?.actionType === ACTION ? fetcher.data : null;
  const saveFailed: Array<{ locale: string; error: string }> =
    response && !response.success ? response.failed ?? [] : [];
  useEffect(() => {
    if (fetcher.state !== "idle" || !response) return;
    setAdds([]);
    if (response.success) return;
    const refused = new Set(saveFailed.map((f) => f.locale));
    if (refused.size > 0) {
      setDraft((prev) => {
        const next = { ...prev };
        for (const locale of refused) if (locale in stored) next[locale] = stored[locale];
        return next;
      });
      setMarketDraft((prev) => {
        const next = { ...prev };
        for (const locale of refused) if (locale in storedMarkets) next[locale] = storedMarkets[locale];
        return next;
      });
    }
    // No explicit reload: React Router revalidates the loaders after every
    // fetcher action by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, response]);

  // ── Removal: its own fetcher and its own confirmation ────────────────────
  const removeFetcher = useFetcher<any>();
  const [removing, setRemoving] = useState<{ locale: string; name: string } | null>(null);
  // Which removal the fetcher's answer belongs to — a failure of an earlier
  // attempt must not greet the dialog opened for another language.
  const [removeSubmittedFor, setRemoveSubmittedFor] = useState<string | null>(null);
  const removeResponse = removeFetcher.data?.actionType === REMOVE_ACTION ? removeFetcher.data : null;
  useEffect(() => {
    if (removeFetcher.state !== "idle" || !removeResponse || !removing || removeSubmittedFor !== removing.locale) return;
    if (removeResponse.success) {
      showInfoBox((s.removedMessage || "Removed “{name}”.").replace("{name}", removing.name), "success");
      setRemoving(null);
      setRemoveSubmittedFor(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeFetcher.state, removeResponse]);
  const removeFailures: Array<{ error: string }> =
    removeResponse && !removeResponse.success && removing && removeSubmittedFor === removing.locale
      ? removeResponse.failed ?? []
      : [];
  const removeError: string | null =
    removeFailures.length > 0
      ? [
          removeFailures.map((f) => errorText(f.error)).join(" · "),
          // The re-consent hint belongs where the merchant meets the refusal.
          removeFailures.some((f) => /access denied/i.test(f.error)) ? s.scopeHint : "",
        ]
          .filter(Boolean)
          .join(" ")
      : null;

  function errorText(code: string): string {
    switch (code) {
      case "primaryLocale":
        return s.errorPrimaryLocale;
      case "unknownLocale":
        return s.errorUnknownLocale;
      case "notConfirmed":
        return s.errorNotConfirmed;
      case "alreadyEnabled":
        return s.errorAlreadyEnabled;
      case "notAvailable":
        return s.errorNotAvailable;
      case "availableLookupFailed":
        return s.errorAvailableLookupFailed;
      case "invalidChanges":
        return s.errorInvalidChanges;
      case "localesUnreadable":
        return s.errorLocalesUnreadable;
      case "unknownMarket":
        return s.errorUnknownMarket;
      case "marketsUnreadable":
        return s.errorMarketsUnreadable;
      case "marketsUnverified":
        return s.errorMarketsUnverified;
      case "publicationMovedByMarkets":
        return s.errorPublicationMovedByMarkets;
      default:
        return code;
    }
  }
  const nameOf = (locale: string) =>
    langName(
      locale,
      shopLocales.find((x) => x.locale === locale)?.name || availableLocales?.find((x) => x.isoCode === locale)?.name,
    );

  const handleSave = () => {
    const form = new FormData();
    form.append("actionType", ACTION);
    form.append("changes", JSON.stringify(changes));
    form.append("add", JSON.stringify(adds.map((a) => ({ locale: a.locale, published: a.published }))));
    form.append(
      "markets",
      JSON.stringify([
        ...marketChanges,
        ...adds
          .filter((a) => a.webPresenceIds.length > 0)
          .map((a) => ({ locale: a.locale, webPresenceIds: a.webPresenceIds })),
      ]),
    );
    setSubmittedHere(true);
    fetcher.submit(form, { method: "post" });
  };
  const handleDiscard = () => {
    setDraft(stored);
    setMarketDraft(storedMarkets);
    setAdds([]);
  };

  /**
   * One checkbox per offered market web presence ("which of these" — a
   * multi-select, so checkboxes rather than pill switches, CLAUDE.md). A
   * presence whose DEFAULT language this is stays ticked and locked: Shopify
   * cannot drop a presence's default language. Published but in no market is
   * the state the owner hit with Dutch — the one line that says why the
   * storefront's language picker does not offer it.
   */
  const renderMarkets = (locale: string, ids: readonly string[], published: boolean, onChange: (next: string[]) => void) => {
    if (marketWebPresences === null || offered.length === 0) return null;
    return (
      <BlockStack gap="100">
        <InlineStack gap="300" blockAlign="center" wrap>
          <Text as="span" variant="bodySm" tone="subdued">
            {s.marketsLabel}
          </Text>
          {offered.map((p) => {
            const isDefault = p.defaultLocale.toLowerCase() === locale.toLowerCase();
            return (
              <Checkbox
                key={p.id}
                // Market names when Shopify names any; the host only as the
                // fallback label for a presence nothing names.
                label={p.marketNames.map((n) => localizedMarketName(n, appLocale)).join(", ") || p.label || p.id}
                checked={isDefault || ids.includes(p.id)}
                disabled={isDefault}
                onChange={(on) => onChange(toggleMarket(ids, p.id, on))}
              />
            );
          })}
        </InlineStack>
        {published && ids.length === 0 && (
          <Text as="p" variant="bodySm" tone="caution">
            {s.noMarketWarning}
          </Text>
        )}
      </BlockStack>
    );
  };

  const primary = shopLocales.find((l) => l.primary);
  const foreign = shopLocales.filter((l) => !l.primary);
  const saving = fetcher.state !== "idle" && fetcher.formData?.get("actionType") === ACTION;
  const enabledSet = new Set(shopLocales.map((l) => l.locale));
  const addOptions = (availableLocales ?? [])
    .filter((l) => !enabledSet.has(l.isoCode) && !adds.some((a) => a.locale === l.isoCode))
    .map((l) => ({ label: `${langName(l.isoCode, l.name)} (${l.isoCode})`, value: l.isoCode }))
    .sort((a, b) => compareStrings(a.label, b.label, appLocale));

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          {/* The explanations live in the question marks (t.help.shopLanguages*),
              like everywhere else in the app — on screen stay only the short
              hints that change with a row's state. */}
          <InlineStack gap="100" blockAlign="center" wrap={false}>
            <Text as="h2" variant="headingLg">
              {s.title || "Shop languages"}
            </Text>
            <HelpTooltip helpKey="shopLanguages" position="below" />
          </InlineStack>
          <SaveDiscardButtons
            hasChanges={hasChanges}
            onSave={handleSave}
            onDiscard={handleDiscard}
            saveText={t.products?.saveChanges || "Save"}
            discardText={t.content?.discardChanges || "Discard"}
            action={ACTION}
            isSavingCurrentItem={saving}
          />
        </InlineStack>

        {marketWebPresences === null && (
          <Text as="p" variant="bodySm" tone="caution">
            {s.marketsUnavailable}
          </Text>
        )}
        {/* Several markets on one checkbox is a platform fact, not a choice of
            this tab: Shopify keeps the languages on the web presence, and
            markets without a domain or subfolder of their own share one.
            Said once, or the merchant reads the shared box as a missing
            feature. */}
        {offered.some((p) => p.marketNames.length > 1) && (
          <Text as="p" variant="bodySm" tone="subdued">
            {s.sharedMarketsHint}
          </Text>
        )}
        {/* Read fine, nothing to offer — said, never rendered as silence. */}
        {marketWebPresences !== null && offered.length === 0 && (
          <Text as="p" variant="bodySm" tone="caution">
            {s.noActiveMarkets}
          </Text>
        )}

        {saveFailed.length > 0 && (
          <Banner tone="critical" title={s.failedTitle}>
            <List>
              {saveFailed.map((f) => (
                <List.Item key={f.locale || f.error}>
                  {f.locale ? `${nameOf(f.locale)}: ` : ""}
                  {errorText(f.error)}
                </List.Item>
              ))}
            </List>
            {saveFailed.some((f) => /access denied/i.test(f.error)) && (
              <Text as="p" variant="bodyMd">
                {s.scopeHint}
              </Text>
            )}
          </Banner>
        )}

        <BlockStack gap="300">
          {primary && (
            <InlineStack gap="200" blockAlign="center">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {langName(primary.locale, primary.name)}
              </Text>
              <Badge tone="info">{s.primaryBadge}</Badge>
              <Text as="span" variant="bodySm" tone="subdued">
                {s.primaryHint}
              </Text>
            </InlineStack>
          )}
          {foreign.length === 0 && adds.length === 0 && (
            <Text as="p" variant="bodyMd" tone="subdued">
              {s.noForeign}
            </Text>
          )}
          {foreign.map((l) => {
            const published = draft[l.locale] ?? l.published;
            return (
              <BlockStack key={l.locale} gap="050">
                <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
                  <ToggleRow
                    layout="inline"
                    label={`${langName(l.locale, l.name)} (${l.locale}) — ${s.publishedLabel}`}
                    tooltip={switchTooltip(published !== l.published)}
                    checked={published}
                    onChange={(value) => setDraft((prev) => ({ ...prev, [l.locale]: value }))}
                  />
                  <DisabledActionTooltip hint={hasChanges ? s.removeBlockedByDraft : undefined}>
                    <Button
                      variant="plain"
                      tone="critical"
                      disabled={hasChanges}
                      onClick={() => setRemoving({ locale: l.locale, name: langName(l.locale, l.name) })}
                    >
                      {s.removeButton || "Remove"}
                    </Button>
                  </DisabledActionTooltip>
                </InlineStack>
                {!published && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {s.unpublishedHint}
                  </Text>
                )}
                {renderMarkets(l.locale, marketDraft[l.locale] ?? [], published, (next) =>
                  setMarketDraft((prev) => ({ ...prev, [l.locale]: next })),
                )}
              </BlockStack>
            );
          })}
          {adds.map((a) => (
            <BlockStack key={a.locale} gap="050">
              <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <ToggleRow
                    layout="inline"
                    label={`${langName(a.locale, a.name)} (${a.locale}) — ${s.publishedLabel}`}
                    tooltip={switchTooltip(true)}
                    checked={a.published}
                    onChange={(value) =>
                      setAdds((prev) => prev.map((x) => (x.locale === a.locale ? { ...x, published: value } : x)))
                    }
                  />
                  <Badge tone="attention">{s.newBadge}</Badge>
                </InlineStack>
                <Button variant="plain" onClick={() => setAdds((prev) => prev.filter((x) => x.locale !== a.locale))}>
                  {s.undoAdd || "Don't add"}
                </Button>
              </InlineStack>
              {renderMarkets(a.locale, a.webPresenceIds, a.published, (next) =>
                setAdds((prev) => prev.map((x) => (x.locale === a.locale ? { ...x, webPresenceIds: next } : x))),
              )}
            </BlockStack>
          ))}
        </BlockStack>

        <BlockStack gap="200">
          <InlineStack gap="100" blockAlign="center" wrap={false}>
            <Text as="h3" variant="headingSm">
              {s.addTitle}
            </Text>
            <HelpTooltip helpKey="shopLanguagesAdd" position="below" />
          </InlineStack>
          {availableLocales === null ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {s.addUnavailable}
            </Text>
          ) : (
            <InlineStack gap="200" blockAlign="end" wrap={false}>
              <div style={{ flex: 1, maxWidth: 360 }}>
                <Select
                  label={s.addTitle}
                  labelHidden
                  options={[{ label: s.addPlaceholder || "…", value: "" }, ...addOptions]}
                  value={pick}
                  onChange={setPick}
                />
              </div>
              <Button
                disabled={!pick}
                onClick={() => {
                  const chosen = availableLocales.find((l) => l.isoCode === pick);
                  if (!chosen) return;
                  setAdds((prev) => [
                    ...prev,
                    { locale: chosen.isoCode, name: chosen.name, published: false, webPresenceIds: [] },
                  ]);
                  setPick("");
                }}
              >
                {s.addButton || "Add"}
              </Button>
            </InlineStack>
          )}
        </BlockStack>
      </BlockStack>

      {removing && (
        <DeleteItemModal
          open={!!removing}
          onClose={() => {
            setRemoving(null);
            setRemoveSubmittedFor(null);
          }}
          item={{ id: removing.locale, title: removing.name, resource: "shopLocale" }}
          deleting={removeFetcher.state !== "idle"}
          error={removeError}
          onConfirm={() => {
            const form = new FormData();
            form.append("actionType", REMOVE_ACTION);
            form.append("locale", removing.locale);
            setRemoveSubmittedFor(removing.locale);
            removeFetcher.submit(form, { method: "post" });
          }}
          t={{ ...(t.content?.deleteModal ?? {}), ...(s.removeModal ?? {}) }}
        />
      )}
    </Card>
  );
}
