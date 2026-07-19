import { useState, useEffect } from "react";
import type { FetcherWithComponents } from "@remix-run/react";
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

// Field ordering + labels for the limits grid. Kept local (vs. deriving from
// DEFAULT_SEO_LIMITS keys) so each row keeps a stable order and a meaningful
// title-cased label without a separate mapping table.
const LIMIT_FIELDS: Array<{
  key: keyof SeoLimits;
  labelKey: string;
  fallbackLabel: string;
}> = [
  { key: "titleMin", labelKey: "seoLimitTitleMin", fallbackLabel: "Titel min." },
  { key: "titleMax", labelKey: "seoLimitTitleMax", fallbackLabel: "Titel max." },
  { key: "seoTitleMax", labelKey: "seoLimitSeoTitleMax", fallbackLabel: "SEO-Titel max." },
  { key: "metaDescMin", labelKey: "seoLimitMetaDescMin", fallbackLabel: "Meta-Beschreibung min." },
  { key: "metaDescMax", labelKey: "seoLimitMetaDescMax", fallbackLabel: "Meta-Beschreibung max." },
  { key: "descriptionMin", labelKey: "seoLimitDescriptionMin", fallbackLabel: "Beschreibung min." },
  { key: "handleMin", labelKey: "seoLimitHandleMin", fallbackLabel: "URL-Slug min." },
  { key: "handleMax", labelKey: "seoLimitHandleMax", fallbackLabel: "URL-Slug max." },
  { key: "altTextMin", labelKey: "seoLimitAltTextMin", fallbackLabel: "Alt-Text min." },
  { key: "altTextMax", labelKey: "seoLimitAltTextMax", fallbackLabel: "Alt-Text max." },
];

function toDraft(stored: Partial<SeoLimits> | null): Record<keyof SeoLimits, string> {
  const resolved = resolveSeoLimits(stored);
  const out = {} as Record<keyof SeoLimits, string>;
  for (const { key } of LIMIT_FIELDS) out[key] = String(resolved[key]);
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
  const [limits, setLimits] = useState<Record<keyof SeoLimits, string>>(initialDraft);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    const suffixChanged =
      seoTitleSuffixEnabled !== (settings.seoTitleSuffixEnabled ?? false) ||
      seoTitleSuffix !== (settings.seoTitleSuffix || "");
    const limitsChanged = LIMIT_FIELDS.some(({ key }) => limits[key] !== initialDraft[key]);
    const changed = suffixChanged || limitsChanged;
    setHasChanges(changed);
    if (onHasChangesChange) onHasChangesChange(changed);
    // initialDraft is derived from `settings` — including it in deps would
    // create a new object each render and loop indefinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seoTitleSuffixEnabled, seoTitleSuffix, limits, settings, onHasChangesChange]);

  const handleSave = () => {
    if (!hasChanges) return;
    // Only ship a limits payload if the merchant may edit them AND actually
    // changed something — avoids overwriting the DB row from a read-only
    // render on free/basic plans.
    const limitsChanged =
      canEditLimits &&
      LIMIT_FIELDS.some(({ key }) => limits[key] !== initialDraft[key]);
    fetcher.submit(
      {
        actionType: "saveSeoSettings",
        seoTitleSuffixEnabled: String(seoTitleSuffixEnabled),
        seoTitleSuffix,
        ...(limitsChanged ? { seoLimits: JSON.stringify(coerceLimits(limits)) } : {}),
      },
      { method: "POST" },
    );
  };

  const handleDiscard = () => {
    setSeoTitleSuffixEnabled(settings.seoTitleSuffixEnabled ?? false);
    setSeoTitleSuffix(settings.seoTitleSuffix || "");
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

          <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
            {LIMIT_FIELDS.map(({ key, labelKey, fallbackLabel }) => (
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
  for (const { key } of LIMIT_FIELDS) {
    const n = parseInt(draft[key], 10);
    if (Number.isFinite(n) && n > 0 && n !== DEFAULT_SEO_LIMITS[key]) {
      out[key] = n;
    }
  }
  return out;
}
