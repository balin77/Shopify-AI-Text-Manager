/**
 * Settings → Shop-Sprachen: publish or unpublish the shop's languages.
 *
 * An unpublished language is one the merchant is PREPARING — this app syncs,
 * edits and auto-translates it like any other (`translationForeignLocales`),
 * and flipping it here is the launch. Every switch is a DRAFT until the save
 * bar is pressed (CLAUDE.md, "A setting is never saved by the click that
 * changes it"), and the server re-reads the shop's languages before it writes
 * (shop-locale-publish.server.ts). The primary language is shown, fixed.
 *
 * Names come from Shopify's own `name` (server-rendered, identical on both
 * sides) rather than `Intl.DisplayNames`, which would be a hydration risk.
 */

import { useEffect, useMemo, useState } from "react";
import type { FetcherWithComponents } from "react-router";
import { useRevalidator } from "react-router";
import { Badge, Banner, BlockStack, Card, InlineStack, List, Text } from "@shopify/polaris";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ToggleRow } from "./ToggleRow";

interface ShopLanguage {
  locale: string;
  name?: string;
  primary: boolean;
  published: boolean;
}

interface Props {
  shopLocales: ShopLanguage[];
  fetcher: FetcherWithComponents<any>;
  t: any;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

const ACTION = "saveShopLocalePublication";

function stateOf(locales: readonly ShopLanguage[]): Record<string, boolean> {
  return Object.fromEntries(locales.filter((l) => !l.primary).map((l) => [l.locale, !!l.published]));
}

export function SettingsShopLanguagesTab({ shopLocales, fetcher, t, onHasChangesChange }: Props) {
  const s = t.settings?.shopLanguages ?? {};
  const revalidator = useRevalidator();
  const stored = useMemo(() => stateOf(shopLocales), [shopLocales]);
  // Re-seeded whenever the STORED state changes (after a save revalidated the
  // loader), never while the merchant is mid-draft on an unchanged store.
  const storedKey = JSON.stringify(stored);
  const [draft, setDraft] = useState<Record<string, boolean>>(stored);
  useEffect(() => {
    setDraft(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const changes = Object.entries(draft)
    .filter(([locale, published]) => stored[locale] !== published)
    .map(([locale, published]) => ({ locale, published }));
  const hasChanges = changes.length > 0;
  useEffect(() => {
    onHasChangesChange?.(hasChanges);
  }, [hasChanges, onHasChangesChange]);
  // Leaving the tab discards the draft with it — the page must not keep
  // believing there is something unsaved here.
  useEffect(() => () => onHasChangesChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A partial failure answers `success: false` with no `error` (the page's
  // generic info box would print raw codes) — the tab lists the failures and
  // reloads, so what DID go through shows as stored.
  const response = fetcher.data?.actionType === ACTION ? fetcher.data : null;
  const failed: Array<{ locale: string; error: string }> = response && !response.success ? response.failed ?? [] : [];
  useEffect(() => {
    if (fetcher.state === "idle" && response && !response.success && (response.confirmed?.length ?? 0) > 0) {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, response]);

  const errorText = (code: string) =>
    code === "primaryLocale"
      ? s.errorPrimaryLocale
      : code === "unknownLocale"
        ? s.errorUnknownLocale
        : code === "notConfirmed"
          ? s.errorNotConfirmed
          : code;
  const nameOf = (locale: string) => {
    const l = shopLocales.find((x) => x.locale === locale);
    return l?.name || locale;
  };

  const handleSave = () => {
    const form = new FormData();
    form.append("actionType", ACTION);
    form.append("changes", JSON.stringify(changes));
    fetcher.submit(form, { method: "post" });
  };

  const primary = shopLocales.find((l) => l.primary);
  const foreign = shopLocales.filter((l) => !l.primary);
  const saving =
    fetcher.state !== "idle" && fetcher.formData?.get("actionType") === ACTION;

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
            onDiscard={() => setDraft(stored)}
            saveText={t.products?.saveChanges || "Save"}
            discardText={t.content?.discardChanges || "Discard"}
            action={ACTION}
            isSavingCurrentItem={saving}
          />
        </InlineStack>

        <Text as="p" variant="bodyMd" tone="subdued">
          {s.intro}
        </Text>

        {failed.length > 0 && (
          <Banner tone="critical" title={s.failedTitle}>
            <List>
              {failed.map((f) => (
                <List.Item key={f.locale}>
                  {nameOf(f.locale)}: {errorText(f.error)}
                </List.Item>
              ))}
            </List>
            {failed.some((f) => /access denied/i.test(f.error)) && (
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
          {foreign.length === 0 && (
            <Text as="p" variant="bodyMd" tone="subdued">
              {s.noForeign}
            </Text>
          )}
          {foreign.map((l) => {
            const published = draft[l.locale] ?? l.published;
            return (
              <BlockStack key={l.locale} gap="050">
                <ToggleRow
                  layout="inline"
                  label={`${l.name || l.locale} (${l.locale}) — ${s.publishedLabel}`}
                  checked={published}
                  onChange={(value) => setDraft((prev) => ({ ...prev, [l.locale]: value }))}
                />
                {!published && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {s.unpublishedHint}
                  </Text>
                )}
              </BlockStack>
            );
          })}
        </BlockStack>

        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            {s.marketsNote}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {s.addLanguageNote}
          </Text>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}
