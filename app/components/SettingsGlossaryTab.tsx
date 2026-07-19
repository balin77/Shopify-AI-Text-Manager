/**
 * SettingsGlossaryTab — Glossar/Terminologie
 * (docs/plans/GLOSSARY_IMPLEMENTATION_PLAN.md Phase 3)
 *
 * Locale-button bar like the content editors: the primary locale view manages
 * the terms (add/edit/delete + flags), each foreign locale view sets the
 * DESIRED fixed translation per term (empty = no rule, the AI translates
 * freely). Entries with doNotTranslate stay verbatim in every language.
 *
 * Editing is local (draft state); one save posts the full entry set as JSON
 * (`actionType: saveGlossary`) and the server diff-upserts in a transaction.
 * CSV export is built client-side (a top-level navigation to an authenticated
 * route would trigger an OAuth redirect inside the embedded iframe instead of
 * a download); CSV import posts the file's text (`actionType: importGlossary`).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  InlineStack,
  TextField,
  Checkbox,
  Button,
  Badge,
  Banner,
  EmptyState,
  Divider,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import type { Translation as I18nTranslation } from "~/i18n/de";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { useI18n } from "../contexts/I18nContext";

export interface GlossaryEntryDto {
  id: string;
  sourceTerm: string;
  doNotTranslate: boolean;
  caseSensitive: boolean;
  translations: Record<string, string>;
}

export interface GlossaryShopLocale {
  locale: string;
  name?: string;
  primary: boolean;
}

interface Draft extends GlossaryEntryDto {
  /** Stable client-side key (new rows have no DB id yet). */
  key: string;
}

interface Props {
  entries: GlossaryEntryDto[];
  shopLocales: GlossaryShopLocale[];
  primaryShopLocale: string;
  t: I18nTranslation;
  /** Reports unsaved-changes state to the parent (drives the native save bar + nav guard). */
  onHasChangesChange?: (hasChanges: boolean) => void;
}

interface GlossaryActionResult {
  success: boolean;
  actionType?: string;
  error?: string;
  imported?: number;
  skipped?: number;
}

/** Characters that would corrupt the prompt directive (mirrors the server check). */
function hasForbiddenChars(s: string): boolean {
  if (s.includes('"') || s.includes("->")) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true; // control chars incl. line breaks
  }
  return false;
}

let clientKeySeq = 0;
function nextKey(): string {
  return `draft_${++clientKeySeq}`;
}

function toDrafts(entries: GlossaryEntryDto[]): Draft[] {
  return entries.map((e) => ({ ...e, translations: { ...e.translations }, key: e.id }));
}

/** Order-insensitive fingerprint used for the dirty check. */
function fingerprint(drafts: Draft[]): string {
  return JSON.stringify(
    drafts
      .map((d) => ({
        id: d.id,
        sourceTerm: d.sourceTerm.trim(),
        doNotTranslate: d.doNotTranslate,
        caseSensitive: d.caseSensitive,
        translations: Object.fromEntries(
          Object.entries(d.translations)
            .map(([l, v]) => [l, v.trim()])
            .filter(([, v]) => v !== "")
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      }))
      .sort((a, b) => (a.sourceTerm < b.sourceTerm ? -1 : 1)),
  );
}

export function SettingsGlossaryTab({ entries, shopLocales, primaryShopLocale, t, onHasChangesChange }: Props) {
  const fetcher = useFetcher<GlossaryActionResult>();
  const { locale: appLocale } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [drafts, setDrafts] = useState<Draft[]>(() => toDrafts(entries));
  const [activeLocale, setActiveLocale] = useState(primaryShopLocale);
  const [importResult, setImportResult] = useState<string | null>(null);

  const isPrimaryView = activeLocale === primaryShopLocale;
  const submitting = fetcher.state !== "idle";

  // Re-init drafts when the loader data changes (after our save/import the
  // route revalidates; picking up the new ids keeps the diff-upsert correct).
  const propsFingerprint = useMemo(() => fingerprint(toDrafts(entries)), [entries]);
  const lastAppliedProps = useRef(propsFingerprint);
  useEffect(() => {
    if (propsFingerprint !== lastAppliedProps.current) {
      lastAppliedProps.current = propsFingerprint;
      setDrafts(toDrafts(entries));
    }
  }, [propsFingerprint, entries]);

  const isDirty = useMemo(
    () => fingerprint(drafts) !== propsFingerprint,
    [drafts, propsFingerprint],
  );
  useEffect(() => {
    onHasChangesChange?.(isDirty);
  }, [isDirty, onHasChangesChange]);

  // Surface the import result banner once the fetcher settles.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.success && fetcher.data.actionType === "importGlossary") {
      setImportResult(
        (t.settings.glossaryImportSuccess || "{imported} entries imported ({skipped} rows skipped)")
          .replace("{imported}", String(fetcher.data.imported ?? 0))
          .replace("{skipped}", String(fetcher.data.skipped ?? 0)),
      );
    }
  }, [fetcher.state, fetcher.data, t]);

  // ── Draft mutations ────────────────────────────────────────────────────────

  function updateDraft(key: string, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function updateTranslation(key: string, locale: string, value: string) {
    setDrafts((prev) =>
      prev.map((d) =>
        d.key === key ? { ...d, translations: { ...d.translations, [locale]: value } } : d,
      ),
    );
  }

  function addEntry() {
    setDrafts((prev) => [
      ...prev,
      {
        key: nextKey(),
        id: "",
        sourceTerm: "",
        doNotTranslate: false,
        caseSensitive: false,
        translations: {},
      },
    ]);
  }

  function removeEntry(key: string) {
    setDrafts((prev) => prev.filter((d) => d.key !== key));
  }

  function discard() {
    setDrafts(toDrafts(entries));
  }

  // ── Validation (mirrors the server; shown inline per field) ───────────────

  function termError(draft: Draft): string | undefined {
    const term = draft.sourceTerm.trim();
    if (!term) return undefined; // empty rows are dropped on save
    if (hasForbiddenChars(term) || term.length > 200) {
      return t.settings.glossaryInvalidChars;
    }
    const dup = drafts.some(
      (d) => d.key !== draft.key && d.sourceTerm.trim().toLowerCase() === term.toLowerCase(),
    );
    if (dup) return t.settings.glossaryDuplicateTerm;
    return undefined;
  }

  function translationError(draft: Draft): string | undefined {
    const v = (draft.translations[activeLocale] || "").trim();
    if (v && (hasForbiddenChars(v) || v.length > 200)) {
      return t.settings.glossaryInvalidChars;
    }
    return undefined;
  }

  const hasErrors = drafts.some(
    (d) =>
      (d.sourceTerm.trim() &&
        (hasForbiddenChars(d.sourceTerm.trim()) || d.sourceTerm.trim().length > 200)) ||
      Object.values(d.translations).some((v) => v.trim() && (hasForbiddenChars(v.trim()) || v.trim().length > 200)) ||
      termError(d) === t.settings.glossaryDuplicateTerm,
  );

  // ── Actions ────────────────────────────────────────────────────────────────

  function save() {
    const payload = drafts
      .filter((d) => d.sourceTerm.trim() !== "")
      .map((d) => ({
        id: d.id || undefined,
        sourceTerm: d.sourceTerm.trim(),
        doNotTranslate: d.doNotTranslate,
        caseSensitive: d.caseSensitive,
        translations: d.translations,
      }));
    fetcher.submit(
      {
        actionType: "saveGlossary",
        sourceLocale: primaryShopLocale,
        entries: JSON.stringify(payload),
      },
      { method: "POST" },
    );
  }

  function exportCsv() {
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = "sourceTerm,locale,value,doNotTranslate,caseSensitive";
    const lines: string[] = [];
    for (const d of drafts) {
      if (!d.sourceTerm.trim()) continue;
      const flags = `${d.doNotTranslate},${d.caseSensitive}`;
      const translations = Object.entries(d.translations).filter(([, v]) => v.trim());
      if (translations.length === 0) {
        lines.push(`${cell(d.sourceTerm.trim())},,,${flags}`);
      } else {
        for (const [locale, value] of translations) {
          lines.push(`${cell(d.sourceTerm.trim())},${cell(locale)},${cell(value.trim())},${flags}`);
        }
      }
    }
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "glossary.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importCsvFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const csv = String(reader.result || "");
      setImportResult(null);
      fetcher.submit(
        { actionType: "importGlossary", sourceLocale: primaryShopLocale, csv },
        { method: "POST" },
      );
    };
    reader.readAsText(file);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const activeLanguageName = getLocalizedLanguageName(
    activeLocale,
    appLocale,
    shopLocales.find((l) => l.locale === activeLocale)?.name,
  );

  return (
    <BlockStack gap="400">
      <Banner tone="info">
        <Text as="p">{t.settings.glossaryScopeNote}</Text>
      </Banner>
      <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text as="h2" variant="headingLg">
            {t.settings.glossary}
          </Text>
          <InlineStack gap="200">
            <Button onClick={exportCsv} disabled={drafts.length === 0} size="slim">
              {t.settings.glossaryExportCsv}
            </Button>
            <Button onClick={() => fileInputRef.current?.click()} size="slim" loading={submitting}>
              {t.settings.glossaryImportCsv}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importCsvFile(file);
                e.target.value = "";
              }}
            />
          </InlineStack>
        </InlineStack>

        <Text as="p" variant="bodyMd" tone="subdued">
          {t.settings.glossaryDescription}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {t.settings.glossaryApplyNote}
        </Text>

        {fetcher.data && !fetcher.data.success && fetcher.data.error && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}
        {importResult && (
          <Banner tone="success" onDismiss={() => setImportResult(null)}>
            {importResult}
          </Banner>
        )}

        {/* Locale bar — same look as the content editors' locale buttons. */}
        <InlineStack gap="200" wrap>
          {shopLocales.map((locale) => (
            <Button
              key={locale.locale}
              size="slim"
              variant={activeLocale === locale.locale ? "primary" : undefined}
              onClick={() => setActiveLocale(locale.locale)}
            >
              {`${getLocalizedLanguageName(locale.locale, appLocale, locale.name)}${
                locale.primary ? ` (${t.settings.glossaryPrimarySuffix})` : ""
              }`}
            </Button>
          ))}
        </InlineStack>

        <Divider />

        {drafts.length === 0 ? (
          <EmptyState heading={t.settings.glossaryEmptyHeading} image="">
            <p>{t.settings.glossaryEmptyBody}</p>
          </EmptyState>
        ) : (
          <BlockStack gap="300">
            <InlineStack gap="400" blockAlign="center">
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text as="span" variant="bodySm" tone="subdued" fontWeight="semibold">
                  {t.settings.glossaryTermHeader}
                </Text>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {!isPrimaryView && (
                  <Text as="span" variant="bodySm" tone="subdued" fontWeight="semibold">
                    {(t.settings.glossaryTranslationHeader || "Desired translation ({language})").replace(
                      "{language}",
                      activeLanguageName,
                    )}
                  </Text>
                )}
              </div>
            </InlineStack>

            {drafts.map((draft) => (
              <InlineStack key={draft.key} gap="400" blockAlign="start" wrap={false}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isPrimaryView ? (
                    <TextField
                      label={t.settings.glossaryTermHeader}
                      labelHidden
                      value={draft.sourceTerm}
                      onChange={(v) => updateDraft(draft.key, { sourceTerm: v })}
                      placeholder={t.settings.glossaryTermPlaceholder}
                      autoComplete="off"
                      error={termError(draft)}
                      maxLength={200}
                    />
                  ) : (
                    <div style={{ paddingTop: "0.375rem" }}>
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="medium">
                          {draft.sourceTerm || "—"}
                        </Text>
                        {draft.doNotTranslate && (
                          <Badge tone="info">{t.settings.glossaryDoNotTranslateBadge}</Badge>
                        )}
                      </InlineStack>
                    </div>
                  )}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {isPrimaryView ? (
                    <InlineStack gap="400" blockAlign="center">
                      <div style={{ paddingTop: "0.375rem" }}>
                        <Checkbox
                          label={t.settings.glossaryDoNotTranslate}
                          checked={draft.doNotTranslate}
                          onChange={(v) => updateDraft(draft.key, { doNotTranslate: v })}
                        />
                      </div>
                      <div style={{ paddingTop: "0.375rem" }}>
                        <Checkbox
                          label={t.settings.glossaryCaseSensitive}
                          checked={draft.caseSensitive}
                          onChange={(v) => updateDraft(draft.key, { caseSensitive: v })}
                        />
                      </div>
                      <Button
                        icon={DeleteIcon}
                        variant="tertiary"
                        tone="critical"
                        accessibilityLabel={t.settings.glossaryDeleteEntry}
                        onClick={() => removeEntry(draft.key)}
                      />
                    </InlineStack>
                  ) : draft.doNotTranslate ? null : (
                    <TextField
                      label={t.settings.glossaryTranslationHeader}
                      labelHidden
                      value={draft.translations[activeLocale] || ""}
                      onChange={(v) => updateTranslation(draft.key, activeLocale, v)}
                      placeholder={t.settings.glossaryTranslationPlaceholder}
                      autoComplete="off"
                      error={translationError(draft)}
                      maxLength={200}
                    />
                  )}
                </div>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        {isPrimaryView ? (
          <InlineStack gap="200">
            <Button onClick={addEntry}>{`+ ${t.settings.glossaryAddEntry}`}</Button>
          </InlineStack>
        ) : (
          drafts.length > 0 && (
            <Text as="p" variant="bodySm" tone="subdued">
              {t.settings.glossaryTranslationPlaceholder}
            </Text>
          )
        )}
        {isPrimaryView && drafts.length > 0 && (
          <Text as="p" variant="bodySm" tone="subdued">
            {t.settings.glossarySwitchToForeign}
          </Text>
        )}

        <SaveDiscardButtons
          hasChanges={isDirty && !hasErrors}
          onSave={save}
          onDiscard={discard}
          saveText={t.common?.save || "Save"}
          discardText={t.common?.cancel || "Discard"}
          action="saveGlossary"
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData ?? null}
          isSavingCurrentItem={submitting && fetcher.formData?.get("actionType") === "saveGlossary"}
        />
      </BlockStack>
      </Card>
    </BlockStack>
  );
}
