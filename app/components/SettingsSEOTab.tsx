import { useState, useEffect } from "react";
import type { FetcherWithComponents } from "react-router";
import {
  Card,
  Text,
  BlockStack,
  TextField,
  Banner,
  InlineStack,
  Button,
  Divider,
  InlineGrid,
} from "@shopify/polaris";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ToggleSwitch } from "./ToggleSwitch";
import { DEFAULT_SEO_LIMITS, resolveSeoLimits, type SeoLimits } from "../utils/character-limits";
import { meetsPlan, type Plan } from "../utils/planUtils";

interface Settings {
  seoTitleSuffixEnabled: boolean;
  seoTitleSuffix: string;
  /** PLAN §Phase 3.3 — redirect the old URL when a handle changes. */
  seoAutoHandleRedirect?: boolean;
  /** Stored merchant overrides; `null` = defaults from character-limits.ts. */
  seoLimits: Partial<SeoLimits> | null;
}

interface SettingsSEOTabProps {
  settings: Settings;
  fetcher: FetcherWithComponents<any>;
  t: any;
  shopDisplayName?: string;
  subscriptionPlan: Plan;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

// Field ordering mirrors the product editor (images → title → description →
// handle → SEO title → meta description). Each group is one visual row with
// its own heading and the min/max inputs beneath.
interface LimitField {
  key: keyof SeoLimits;
  labelKey: string;
  fallbackLabel: string;
}
interface LimitGroup {
  id: string;
  headingKey: string;
  fallbackHeading: string;
  fields: LimitField[];
}
const LIMIT_GROUPS: LimitGroup[] = [
  {
    id: "altText",
    headingKey: "seoLimitGroupAltText",
    fallbackHeading: "Alt-Text",
    fields: [
      { key: "altTextMin", labelKey: "seoLimitFieldMin", fallbackLabel: "Min." },
      { key: "altTextMax", labelKey: "seoLimitFieldMax", fallbackLabel: "Max." },
    ],
  },
  {
    id: "title",
    headingKey: "seoLimitGroupTitle",
    fallbackHeading: "Titel",
    fields: [
      { key: "titleMin", labelKey: "seoLimitFieldMin", fallbackLabel: "Min." },
      { key: "titleMax", labelKey: "seoLimitFieldMax", fallbackLabel: "Max." },
    ],
  },
  {
    id: "description",
    headingKey: "seoLimitGroupDescription",
    fallbackHeading: "Beschreibung",
    fields: [
      { key: "descriptionMin", labelKey: "seoLimitFieldMin", fallbackLabel: "Min." },
    ],
  },
  {
    id: "handle",
    headingKey: "seoLimitGroupHandle",
    fallbackHeading: "URL-Slug",
    fields: [
      { key: "handleMin", labelKey: "seoLimitFieldMin", fallbackLabel: "Min." },
      { key: "handleMax", labelKey: "seoLimitFieldMax", fallbackLabel: "Max." },
    ],
  },
  {
    id: "seoTitle",
    headingKey: "seoLimitGroupSeoTitle",
    fallbackHeading: "SEO-Titel",
    fields: [
      { key: "seoTitleMin", labelKey: "seoLimitFieldMin", fallbackLabel: "Min." },
      { key: "seoTitleMax", labelKey: "seoLimitFieldMax", fallbackLabel: "Max." },
    ],
  },
  {
    id: "metaDescription",
    headingKey: "seoLimitGroupMetaDescription",
    fallbackHeading: "Meta-Beschreibung",
    fields: [
      { key: "metaDescMin", labelKey: "seoLimitFieldMin", fallbackLabel: "Min." },
      { key: "metaDescMax", labelKey: "seoLimitFieldMax", fallbackLabel: "Max." },
    ],
  },
];

const ALL_LIMIT_KEYS: Array<keyof SeoLimits> = LIMIT_GROUPS.flatMap((g) =>
  g.fields.map((f) => f.key),
);

function toDraft(stored: Partial<SeoLimits> | null): Record<keyof SeoLimits, string> {
  const resolved = resolveSeoLimits(stored);
  const out = {} as Record<keyof SeoLimits, string>;
  for (const key of ALL_LIMIT_KEYS) out[key] = String(resolved[key]);
  return out;
}

export function SettingsSEOTab({
  settings,
  fetcher,
  t,
  shopDisplayName = "",
  subscriptionPlan,
  onHasChangesChange,
}: SettingsSEOTabProps) {
  const canEditLimits = meetsPlan(subscriptionPlan, "pro");
  const initialDraft = toDraft(settings.seoLimits ?? null);

  const [seoTitleSuffixEnabled, setSeoTitleSuffixEnabled] = useState(
    settings.seoTitleSuffixEnabled ?? false,
  );
  const [seoTitleSuffix, setSeoTitleSuffix] = useState(settings.seoTitleSuffix || "");
  // Defaults to ON — see the toggle's comment below. `?? true` is not a
  // fallback for a failed load here: the column has the same default, so an
  // undefined value means "shop row predates the column", which is exactly the
  // state that should behave as on.
  const [autoHandleRedirect, setAutoHandleRedirect] = useState(
    settings.seoAutoHandleRedirect ?? true,
  );
  const [limits, setLimits] = useState<Record<keyof SeoLimits, string>>(initialDraft);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    const suffixChanged =
      seoTitleSuffixEnabled !== (settings.seoTitleSuffixEnabled ?? false) ||
      seoTitleSuffix !== (settings.seoTitleSuffix || "");
    const limitsChanged = ALL_LIMIT_KEYS.some((key) => limits[key] !== initialDraft[key]);
    const redirectChanged = autoHandleRedirect !== (settings.seoAutoHandleRedirect ?? true);
    const changed = suffixChanged || limitsChanged || redirectChanged;
    setHasChanges(changed);
    if (onHasChangesChange) onHasChangesChange(changed);
    // initialDraft is derived from `settings` — including it in deps would
    // create a new object each render and loop indefinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seoTitleSuffixEnabled, seoTitleSuffix, autoHandleRedirect, limits, settings, onHasChangesChange]);

  const handleSave = () => {
    if (!hasChanges) return;
    // Only ship a limits payload if the merchant may edit them AND actually
    // changed something — avoids overwriting the DB row from a read-only
    // render on free/basic plans.
    const limitsChanged =
      canEditLimits &&
      ALL_LIMIT_KEYS.some((key) => limits[key] !== initialDraft[key]);
    fetcher.submit(
      {
        actionType: "saveSeoSettings",
        seoTitleSuffixEnabled: String(seoTitleSuffixEnabled),
        seoTitleSuffix,
        seoAutoHandleRedirect: String(autoHandleRedirect),
        ...(limitsChanged ? { seoLimits: JSON.stringify(coerceLimits(limits)) } : {}),
      },
      { method: "POST" },
    );
  };

  const handleDiscard = () => {
    setSeoTitleSuffixEnabled(settings.seoTitleSuffixEnabled ?? false);
    setSeoTitleSuffix(settings.seoTitleSuffix || "");
    setAutoHandleRedirect(settings.seoAutoHandleRedirect ?? true);
    setLimits(toDraft(settings.seoLimits ?? null));
  };

  const handleResetLimits = () => {
    setLimits(toDraft(null));
  };

  const setLimit = (key: keyof SeoLimits) => (value: string) => {
    const cleaned = value.replace(/\D/g, "").slice(0, 4);
    setLimits((prev) => ({ ...prev, [key]: cleaned }));
  };

  const effectiveSeoTitleMax =
    parseInt(limits.seoTitleMax, 10) || DEFAULT_SEO_LIMITS.seoTitleMax;

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingLg">
            {t.settings.seoSettings || "SEO"}
          </Text>
          <SaveDiscardButtons
            hasChanges={hasChanges}
            onSave={handleSave}
            onDiscard={handleDiscard}
            saveText={t.products?.saveChanges || "Speichern"}
            discardText={t.content?.discardChanges || "Verwerfen"}
            action="saveSeoSettings"
            fetcherState={fetcher.state}
            fetcherFormData={fetcher.formData}
          />
        </InlineStack>

        <Text as="p" variant="bodyMd" tone="subdued">
          {t.settings.seoTitleSuffixDescription ||
            "Aktiviere diese Option wenn Shopify automatisch den Shop-Namen an SEO-Titel anhängt. Die KI generiert dann kürzere Titel, damit die Gesamtlänge das effektive Limit nicht überschreitet."}
        </Text>

        <BlockStack gap="400">
          {/* PLAN §Phase 3.3 / §A1 — until now, changing a handle in this app
              silently 404'd every existing link to the old address. On by
              default: a stray redirect is untidy, a broken URL costs traffic. */}
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd">
                {t.settings.autoHandleRedirect || "Weiterleitung bei Handle-Änderung"}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {t.settings.autoHandleRedirectHint ||
                  "Ändert sich der Handle eines Eintrags, wird die alte URL automatisch auf die neue weitergeleitet."}
              </Text>
            </BlockStack>
            <ToggleSwitch
              checked={autoHandleRedirect}
              onChange={setAutoHandleRedirect}
            />
          </InlineStack>

          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd">
                {t.settings.seoTitleSuffix || "SEO-Titel Shop-Suffix"}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {t.settings.seoTitleSuffixLabel || "Shopify hängt Shop-Namen an SEO-Titel an"}
              </Text>
            </BlockStack>
            <ToggleSwitch
              checked={seoTitleSuffixEnabled}
              onChange={(checked) => {
                setSeoTitleSuffixEnabled(checked);
                if (checked && !seoTitleSuffix && shopDisplayName) {
                  setSeoTitleSuffix(` – ${shopDisplayName}`);
                }
              }}
            />
          </InlineStack>

          {seoTitleSuffixEnabled && (
            <BlockStack gap="200">
              <TextField
                label={
                  t.settings.seoTitleSuffixField ||
                  "Angefügter Text (inkl. Trennzeichen)"
                }
                value={seoTitleSuffix}
                onChange={setSeoTitleSuffix}
                placeholder={
                  shopDisplayName ? ` – ${shopDisplayName}` : " – Shop Name"
                }
                helpText={
                  seoTitleSuffix
                    ? (
                        t.settings.seoTitleSuffixHint ||
                        "Effektives Zeichenlimit: {limit} Zeichen (von {max})"
                      )
                        .replace(
                          "{limit}",
                          String(
                            Math.max(1, effectiveSeoTitleMax - seoTitleSuffix.length),
                          ),
                        )
                        .replace("{max}", String(effectiveSeoTitleMax))
                    : undefined
                }
                autoComplete="off"
                maxLength={effectiveSeoTitleMax}
              />
              <Banner tone="info">
                <Text as="p">
                  {t.settings.seoTitleSuffixNote ||
                    "Dieser Text wird von Shopify angefügt und wird nicht im SEO-Titel gespeichert. Er dient nur zur Berechnung des effektiven Zeichenlimits."}
                </Text>
              </Banner>
            </BlockStack>
          )}
        </BlockStack>

        <Divider />

        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap={false}>
            <Text as="h3" variant="headingMd">
              {t.settings.seoLimitsHeading || "SEO-Zeichenlimits"}
            </Text>
            {canEditLimits && (
              <Button variant="plain" onClick={handleResetLimits}>
                {t.settings.seoLimitsReset || "Auf Standardwerte zurücksetzen"}
              </Button>
            )}
          </InlineStack>

          <Text as="p" variant="bodySm" tone="subdued">
            {t.settings.seoLimitsDescription ||
              "Diese Werte fließen als harte Vorgabe in jeden KI-Prompt (Generieren, SEO-Fix, Übersetzung im SEO-Modus) und in die Zeichenzähler im Editor."}
          </Text>

          {!canEditLimits && (
            <Banner tone="info">
              <Text as="p">
                {t.settings.seoLimitsProGate ||
                  "Diese Limits sind ab dem Pro-Plan editierbar. In Free/Basic gelten die Standardwerte."}
              </Text>
            </Banner>
          )}

          <BlockStack gap="400">
            {LIMIT_GROUPS.map((group) => (
              <BlockStack gap="200" key={group.id}>
                <Text as="h4" variant="headingSm">
                  {t.settings[group.headingKey] || group.fallbackHeading}
                </Text>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  {group.fields.map(({ key, labelKey, fallbackLabel }) => (
                    <TextField
                      key={key}
                      label={t.settings[labelKey] || fallbackLabel}
                      value={limits[key]}
                      onChange={setLimit(key)}
                      type="number"
                      min={1}
                      max={9999}
                      disabled={!canEditLimits}
                      autoComplete="off"
                      helpText={
                        canEditLimits
                          ? (t.settings.seoLimitDefaultHint || "Standard: {n}").replace(
                              "{n}",
                              String(DEFAULT_SEO_LIMITS[key]),
                            )
                          : undefined
                      }
                    />
                  ))}
                </InlineGrid>
              </BlockStack>
            ))}
          </BlockStack>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

/**
 * Coerce the draft string map back into a `Partial<SeoLimits>` with only
 * fields that differ from the default. Values matching the default drop out
 * so the DB row stays sparse and future default changes propagate.
 */
function coerceLimits(draft: Record<keyof SeoLimits, string>): Partial<SeoLimits> {
  const out: Partial<SeoLimits> = {};
  for (const key of ALL_LIMIT_KEYS) {
    const n = parseInt(draft[key], 10);
    if (Number.isFinite(n) && n > 0 && n !== DEFAULT_SEO_LIMITS[key]) {
      out[key] = n;
    }
  }
  return out;
}
