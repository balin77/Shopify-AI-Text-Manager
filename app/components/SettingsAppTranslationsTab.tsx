/**
 * SettingsAppTranslationsTab — manage dynamic storefront translations.
 *
 * Merchant defines source→target text pairs per language; a theme app embed
 * applies them client-side on the storefront (DOM find-and-replace) for content
 * not stored in translatable Shopify fields (e.g. third-party app widgets).
 *
 * CRUD is immediate (per-row fetcher actions), consistent with the other list
 * settings tabs (Translations / SKU). A feature toggle gates the whole layer.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Select,
  Checkbox,
  Banner,
  Badge,
  Spinner,
  EmptyState,
} from "@shopify/polaris";
import type { Translation as I18nTranslation } from "~/i18n/de";

interface Pair {
  id: string;
  locale: string;
  scope: string;
  sourceText: string;
  targetText: string;
  source: string;
}

interface Candidate {
  id: string;
  locale: string;
  scope: string;
  sourceText: string;
  count: number;
}

interface LoadResult {
  success: boolean;
  actionType?: string;
  enabled?: boolean;
  collect?: boolean;
  translations?: Pair[];
  candidates?: Candidate[];
  targetLocales?: Array<{ locale: string; name?: string }>;
}

interface MutateResult {
  success: boolean;
  actionType?: string;
  row?: Pair;
  id?: string;
  error?: string;
}

interface AiResult {
  success: boolean;
  actionType?: string;
  rows?: Pair[];
  taskId?: string;
  error?: string;
}

interface Props {
  t: I18nTranslation;
}

export function SettingsAppTranslationsTab({ t }: Props) {
  const loadFetcher = useFetcher<LoadResult>();
  const mutateFetcher = useFetcher<MutateResult>();
  const aiFetcher = useFetcher<AiResult>();

  const [enabled, setEnabled] = useState(false);
  const [collect, setCollect] = useState(false);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [targetLocales, setTargetLocales] = useState<Array<{ locale: string; name?: string }>>([]);
  const [activeLocale, setActiveLocale] = useState("");
  const [newSource, setNewSource] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [aiSources, setAiSources] = useState("");
  const isAiTranslating = aiFetcher.state !== "idle";

  const ms = (t.settings ?? {}) as unknown as Record<string, string>;
  const tr = (key: string, fallback: string) => ms[key] ?? fallback;

  // Load once on mount.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    loadFetcher.submit({ actionType: "loadAppTranslations" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Absorb load result.
  useEffect(() => {
    if (loadFetcher.state !== "idle" || !loadFetcher.data?.success) return;
    const d = loadFetcher.data;
    if (d.actionType !== "loadAppTranslations") return;
    setEnabled(!!d.enabled);
    setCollect(!!d.collect);
    setPairs(d.translations ?? []);
    setCandidates(d.candidates ?? []);
    const locales = d.targetLocales ?? [];
    setTargetLocales(locales);
    setActiveLocale((prev) => prev || (locales[0]?.locale ?? ""));
  }, [loadFetcher.state, loadFetcher.data]);

  // Absorb mutation results into local state (avoid a full reload round-trip).
  useEffect(() => {
    if (mutateFetcher.state !== "idle" || !mutateFetcher.data?.success) return;
    const d = mutateFetcher.data;
    if (d.actionType === "upsertAppTranslation" && d.row) {
      const row = d.row;
      setPairs((prev) => {
        const rest = prev.filter((p) => p.id !== row.id);
        return [row, ...rest];
      });
      // A translated string is no longer a candidate.
      setCandidates((prev) => prev.filter((c) => !(c.locale === row.locale && c.sourceText === row.sourceText)));
      setNewSource("");
      setNewTarget("");
    } else if (d.actionType === "deleteAppTranslation" && d.id) {
      setPairs((prev) => prev.filter((p) => p.id !== d.id));
    } else if (d.actionType === "dismissAppTranslationCandidate" && d.id) {
      setCandidates((prev) => prev.filter((c) => c.id !== d.id));
    }
  }, [mutateFetcher.state, mutateFetcher.data]);

  // Merge AI-translated rows into local state + drop the candidates they cover.
  useEffect(() => {
    if (aiFetcher.state !== "idle" || !aiFetcher.data?.success) return;
    if (aiFetcher.data.actionType !== "aiTranslateAppTranslations") return;
    const rows = aiFetcher.data.rows ?? [];
    if (rows.length) {
      setPairs((prev) => {
        const map = new Map(prev.map((p) => [p.id, p]));
        for (const r of rows) map.set(r.id, r);
        return Array.from(map.values());
      });
      const translated = new Set(rows.map((r) => `${r.locale}::${r.sourceText}`));
      setCandidates((prev) => prev.filter((c) => !translated.has(`${c.locale}::${c.sourceText}`)));
    }
    setAiSources("");
  }, [aiFetcher.state, aiFetcher.data]);

  function aiTranslate() {
    const lines = aiSources.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!activeLocale || lines.length === 0) return;
    aiFetcher.submit(
      { actionType: "aiTranslateAppTranslations", locale: activeLocale, scope: "global", sources: JSON.stringify(lines) },
      { method: "post" },
    );
  }

  function toggleEnabled(value: boolean) {
    setEnabled(value);
    mutateFetcher.submit(
      { actionType: "saveAppTranslationEnabled", enabled: String(value) },
      { method: "post" },
    );
  }

  function toggleCollect(value: boolean) {
    setCollect(value);
    mutateFetcher.submit(
      { actionType: "saveAppTranslationCollect", collect: String(value) },
      { method: "post" },
    );
  }

  function dismissCandidate(id: string) {
    mutateFetcher.submit({ actionType: "dismissAppTranslationCandidate", id }, { method: "post" });
  }

  function useCandidate(text: string) {
    setNewSource(text);
    setNewTarget("");
  }

  function aiTranslateCandidates(sources: string[]) {
    if (!activeLocale || sources.length === 0) return;
    aiFetcher.submit(
      { actionType: "aiTranslateAppTranslations", locale: activeLocale, scope: "global", sources: JSON.stringify(sources) },
      { method: "post" },
    );
  }

  function addPair() {
    if (!activeLocale || !newSource.trim() || !newTarget.trim()) return;
    mutateFetcher.submit(
      { actionType: "upsertAppTranslation", locale: activeLocale, sourceText: newSource, targetText: newTarget, scope: "global" },
      { method: "post" },
    );
  }

  function deletePair(id: string) {
    mutateFetcher.submit({ actionType: "deleteAppTranslation", id }, { method: "post" });
  }

  const localeOptions = useMemo(
    () => targetLocales.map((l) => ({ label: l.name ? `${l.name} (${l.locale})` : l.locale, value: l.locale })),
    [targetLocales],
  );

  const visiblePairs = useMemo(
    () => pairs.filter((p) => p.locale === activeLocale).sort((a, b) => a.sourceText.localeCompare(b.sourceText)),
    [pairs, activeLocale],
  );

  const visibleCandidates = useMemo(
    () => candidates.filter((c) => c.locale === activeLocale).sort((a, b) => b.count - a.count),
    [candidates, activeLocale],
  );

  const isLoading = loadFetcher.state !== "idle" && pairs.length === 0 && !loadFetcher.data;
  const isMutating = mutateFetcher.state !== "idle";

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingLg">{tr("appTranslations", "App translations")}</Text>
          <Text as="p" tone="subdued" variant="bodyMd">
            {tr(
              "appTranslationsDescription",
              "Translate text rendered by third-party apps on your storefront that is not stored in translatable Shopify fields. Define source → target pairs per language; they are applied on your storefront.",
            )}
          </Text>
          <Banner tone="warning">
            <Text as="p" variant="bodyMd">
              {tr(
                "appTranslationsSeoNote",
                "These translations are applied in the browser and are NOT indexed by search engines. Use Shopify field translations for SEO-relevant content. Apps rendered inside iframes (e.g. Loox) cannot be translated.",
              )}
            </Text>
          </Banner>
          <Checkbox
            label={tr("appTranslationsEnable", "Enable dynamic storefront translation")}
            checked={enabled}
            onChange={toggleEnabled}
            disabled={isMutating}
          />
          <Checkbox
            label={tr("appTranslationsCollect", "Collect untranslated strings from the storefront")}
            helpText={tr(
              "appTranslationsCollectHelp",
              "When on, your storefront reports short untranslated UI strings it renders (filtered, never prices/emails) so you can review and translate them below. Off by default.",
            )}
            checked={collect}
            onChange={toggleCollect}
            disabled={isMutating}
          />
        </BlockStack>
      </Card>

      {mutateFetcher.data && mutateFetcher.data.success === false && (
        <Banner tone="critical">
          <Text as="p" variant="bodyMd">{mutateFetcher.data.error ?? t.common.error}</Text>
        </Banner>
      )}

      {aiFetcher.state === "idle" && aiFetcher.data && aiFetcher.data.success === false && (
        <Banner tone="critical">
          <Text as="p" variant="bodyMd">{aiFetcher.data.error ?? t.common.error}</Text>
        </Banner>
      )}

      {isLoading ? (
        <Card>
          <InlineStack gap="200" blockAlign="center">
            <Spinner size="small" accessibilityLabel="loading" />
            <Text as="span" tone="subdued">{t.common.loading ?? "Loading…"}</Text>
          </InlineStack>
        </Card>
      ) : targetLocales.length === 0 ? (
        <Card>
          <EmptyState heading={tr("appTranslationsNoLocalesHeading", "No additional languages")} image="">
            <Text as="p" tone="subdued">
              {tr("appTranslationsNoLocales", "Add more published languages to your Shopify store first.")}
            </Text>
          </EmptyState>
        </Card>
      ) : (
        <Card>
          <BlockStack gap="400">
            <Select
              label={tr("appTranslationsLanguage", "Language")}
              options={localeOptions}
              value={activeLocale}
              onChange={setActiveLocale}
            />

            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">{tr("appTranslationsAddHeading", "Add a translation")}</Text>
              <TextField
                label={tr("appTranslationsSource", "Original text")}
                value={newSource}
                onChange={setNewSource}
                autoComplete="off"
                multiline={2}
                placeholder={tr("appTranslationsSourcePlaceholder", "e.g. Write a review")}
              />
              <TextField
                label={tr("appTranslationsTarget", "Translation")}
                value={newTarget}
                onChange={setNewTarget}
                autoComplete="off"
                multiline={2}
              />
              <InlineStack align="end">
                <Button
                  variant="primary"
                  onClick={addPair}
                  loading={isMutating}
                  disabled={!newSource.trim() || !newTarget.trim() || !activeLocale}
                >
                  {tr("appTranslationsAdd", "Add")}
                </Button>
              </InlineStack>
            </BlockStack>

            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">{tr("appTranslationsAiHeading", "Translate with AI")}</Text>
              <TextField
                label={tr("appTranslationsAiSources", "Source strings (one per line)")}
                value={aiSources}
                onChange={setAiSources}
                autoComplete="off"
                multiline={4}
                helpText={tr("appTranslationsAiHelp", "Each line is translated into the selected language and added below. You can edit the results afterwards.")}
                placeholder={"Write a review\nAdd to cart\nVerified buyer"}
              />
              <InlineStack align="end">
                <Button
                  onClick={aiTranslate}
                  loading={isAiTranslating}
                  disabled={!aiSources.trim() || !activeLocale || isAiTranslating}
                >
                  ✨ {tr("appTranslationsAiButton", "Translate with AI")}
                </Button>
              </InlineStack>
            </BlockStack>

            {visibleCandidates.length > 0 && (
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingMd">{tr("appTranslationsDiscovered", "Discovered strings")}</Text>
                    <Badge tone="attention">{`${visibleCandidates.length}`}</Badge>
                  </InlineStack>
                  <Button
                    onClick={() => aiTranslateCandidates(visibleCandidates.map((c) => c.sourceText))}
                    loading={isAiTranslating}
                    disabled={isAiTranslating}
                  >
                    ✨ {tr("appTranslationsTranslateAllAi", "Translate all with AI")}
                  </Button>
                </InlineStack>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                        <th style={thStyle}>{tr("appTranslationsSource", "Original text")}</th>
                        <th style={{ ...thStyle, width: 70 }}>{tr("appTranslationsSeen", "Seen")}</th>
                        <th style={{ ...thStyle, width: 170 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleCandidates.map((c) => (
                        <tr key={c.id} style={{ borderBottom: "1px solid #f1f1f1" }}>
                          <td style={tdStyle}><Text as="span" variant="bodyMd">{c.sourceText}</Text></td>
                          <td style={tdStyle}><Text as="span" tone="subdued" variant="bodySm">{`${c.count}×`}</Text></td>
                          <td style={tdStyle}>
                            <InlineStack gap="100">
                              <Button size="micro" onClick={() => useCandidate(c.sourceText)} disabled={isMutating}>
                                {tr("appTranslationsUse", "Translate")}
                              </Button>
                              <Button size="micro" variant="tertiary" tone="critical" onClick={() => dismissCandidate(c.id)} disabled={isMutating}>
                                {tr("appTranslationsDismiss", "Dismiss")}
                              </Button>
                            </InlineStack>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            )}

            {visiblePairs.length === 0 ? (
              <Text as="p" tone="subdued">{tr("appTranslationsEmpty", "No entries yet for this language.")}</Text>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                      <th style={thStyle}>{tr("appTranslationsSource", "Original text")}</th>
                      <th style={thStyle}>{tr("appTranslationsTarget", "Translation")}</th>
                      <th style={{ ...thStyle, width: 90 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePairs.map((p) => (
                      <tr key={p.id} style={{ borderBottom: "1px solid #f1f1f1" }}>
                        <td style={tdStyle}>
                          <Text as="span" variant="bodyMd">{p.sourceText}</Text>{" "}
                          {p.source === "ai" && <Badge tone="info">AI</Badge>}
                        </td>
                        <td style={tdStyle}><Text as="span" variant="bodyMd">{p.targetText}</Text></td>
                        <td style={tdStyle}>
                          <Button
                            size="micro"
                            variant="tertiary"
                            tone="critical"
                            onClick={() => deletePair(p.id)}
                            disabled={isMutating}
                          >
                            {t.common.delete}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.75rem 0.5rem",
  fontWeight: 600,
  fontSize: "0.875rem",
};

const tdStyle: React.CSSProperties = {
  padding: "0.75rem 0.5rem",
  verticalAlign: "top",
};
