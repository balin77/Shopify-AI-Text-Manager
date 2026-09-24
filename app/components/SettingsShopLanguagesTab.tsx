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
 * Names come from Shopify's own `name` (server-rendered, identical on both
 * sides) rather than `Intl.DisplayNames`, which would be a hydration risk.
 */

import { useEffect, useMemo, useState } from "react";
import type { FetcherWithComponents } from "react-router";
import { useFetcher, useRevalidator } from "react-router";
import { Badge, Banner, BlockStack, Button, Card, InlineStack, List, Select, Text } from "@shopify/polaris";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ToggleRow } from "./ToggleRow";
import { DisabledActionTooltip } from "./DisabledActionTooltip";
import { DeleteItemModal } from "./create/DeleteItemModal";
import { useInfoBox } from "../contexts/InfoBoxContext";

interface ShopLanguage {
  locale: string;
  name?: string;
  primary: boolean;
  published: boolean;
}

interface Props {
  shopLocales: ShopLanguage[];
  /** Languages Shopify lets this shop add; `null` = the lookup failed. */
  availableLocales: Array<{ isoCode: string; name: string }> | null;
  fetcher: FetcherWithComponents<any>;
  t: any;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

const ACTION = "saveShopLocalePublication";
const REMOVE_ACTION = "removeShopLocale";

function stateOf(locales: readonly ShopLanguage[]): Record<string, boolean> {
  return Object.fromEntries(locales.filter((l) => !l.primary).map((l) => [l.locale, !!l.published]));
}

export function SettingsShopLanguagesTab({ shopLocales, availableLocales, fetcher, t, onHasChangesChange }: Props) {
  const s = t.settings?.shopLanguages ?? {};
  const revalidator = useRevalidator();
  const { showInfoBox } = useInfoBox();
  const stored = useMemo(() => stateOf(shopLocales), [shopLocales]);
  // Re-seeded whenever the STORED state changes (after a save revalidated the
  // loader), never while the merchant is mid-draft on an unchanged store.
  const storedKey = JSON.stringify(stored);
  const [draft, setDraft] = useState<Record<string, boolean>>(stored);
  const [adds, setAdds] = useState<Array<{ locale: string; name: string; published: boolean }>>([]);
  const [pick, setPick] = useState("");
  useEffect(() => {
    setDraft(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const changes = Object.entries(draft)
    .filter(([locale, published]) => stored[locale] !== published)
    .map(([locale, published]) => ({ locale, published }));
  const hasChanges = changes.length > 0 || adds.length > 0;
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
    }
    if ((response.confirmed?.length ?? 0) > 0 || (response.added?.length ?? 0) > 0) revalidator.revalidate();
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
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeFetcher.state, removeResponse]);
  const removeError: string | null =
    removeResponse && !removeResponse.success && removing && removeSubmittedFor === removing.locale
      ? (removeResponse.failed ?? []).map((f: { error: string }) => errorText(f.error)).join(" · ") ||
        removeResponse.error ||
        null
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
      default:
        return code;
    }
  }
  const nameOf = (locale: string) =>
    shopLocales.find((x) => x.locale === locale)?.name ||
    availableLocales?.find((x) => x.isoCode === locale)?.name ||
    locale;

  const handleSave = () => {
    const form = new FormData();
    form.append("actionType", ACTION);
    form.append("changes", JSON.stringify(changes));
    form.append("add", JSON.stringify(adds.map((a) => ({ locale: a.locale, published: a.published }))));
    setSubmittedHere(true);
    fetcher.submit(form, { method: "post" });
  };
  const handleDiscard = () => {
    setDraft(stored);
    setAdds([]);
  };

  const primary = shopLocales.find((l) => l.primary);
  const foreign = shopLocales.filter((l) => !l.primary);
  const saving = fetcher.state !== "idle" && fetcher.formData?.get("actionType") === ACTION;
  const enabledSet = new Set(shopLocales.map((l) => l.locale));
  const addOptions = (availableLocales ?? [])
    .filter((l) => !enabledSet.has(l.isoCode) && !adds.some((a) => a.locale === l.isoCode))
    .map((l) => ({ label: `${l.name} (${l.isoCode})`, value: l.isoCode }));

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingLg">
            {s.title || "Shop languages"}
          </Text>
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

        <Text as="p" variant="bodyMd" tone="subdued">
          {s.intro}
        </Text>

        {saveFailed.length > 0 && (
          <Banner tone="critical" title={s.failedTitle}>
            <List>
              {saveFailed.map((f) => (
                <List.Item key={f.locale}>
                  {nameOf(f.locale)}: {errorText(f.error)}
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
                {primary.name || primary.locale}
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
                    label={`${l.name || l.locale} (${l.locale}) — ${s.publishedLabel}`}
                    checked={published}
                    onChange={(value) => setDraft((prev) => ({ ...prev, [l.locale]: value }))}
                  />
                  <DisabledActionTooltip hint={hasChanges ? s.removeBlockedByDraft : undefined}>
                    <Button
                      variant="plain"
                      tone="critical"
                      disabled={hasChanges}
                      onClick={() => setRemoving({ locale: l.locale, name: l.name || l.locale })}
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
              </BlockStack>
            );
          })}
          {adds.map((a) => (
            <BlockStack key={a.locale} gap="050">
              <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <ToggleRow
                    layout="inline"
                    label={`${a.name} (${a.locale}) — ${s.publishedLabel}`}
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
            </BlockStack>
          ))}
        </BlockStack>

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            {s.addTitle}
          </Text>
          {availableLocales === null ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {s.addUnavailable}
            </Text>
          ) : (
            <>
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
                    setAdds((prev) => [...prev, { locale: chosen.isoCode, name: chosen.name, published: false }]);
                    setPick("");
                  }}
                >
                  {s.addButton || "Add"}
                </Button>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                {s.addHint}
              </Text>
            </>
          )}
        </BlockStack>

        <Text as="p" variant="bodySm" tone="subdued">
          {s.marketsNote}
        </Text>
      </BlockStack>

      {removing && (
        <DeleteItemModal
          open={!!removing}
          onClose={() => setRemoving(null)}
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
