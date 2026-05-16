import { useMemo, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Badge,
  Banner,
  EmptyState,
} from "@shopify/polaris";
import type { Translation as I18nTranslation } from "~/i18n/de";

interface GroupedFieldTranslationEntry {
  id: string;
  fieldKey: string;
  sourceLocale: string;
  sourceValueNorm: string;
  sourceValue: string;
  targetLocale: string;
  translatedValue: string;
  source: string;
  updatedAt: string | Date;
}

interface Props {
  groupedFieldTranslations: GroupedFieldTranslationEntry[];
  primaryShopLocale: string;
  t: I18nTranslation;
}

interface GroupedRow {
  sourceLocale: string;
  sourceValueNorm: string;
  sourceValue: string;
  byLocale: Record<string, GroupedFieldTranslationEntry>;
}

function buildRows(entries: GroupedFieldTranslationEntry[]): GroupedRow[] {
  const rowMap = new Map<string, GroupedRow>();
  for (const entry of entries) {
    if (entry.fieldKey !== "productType") continue;
    const key = `${entry.sourceLocale}::${entry.sourceValueNorm}`;
    let row = rowMap.get(key);
    if (!row) {
      row = {
        sourceLocale: entry.sourceLocale,
        sourceValueNorm: entry.sourceValueNorm,
        sourceValue: entry.sourceValue,
        byLocale: {},
      };
      rowMap.set(key, row);
    }
    row.byLocale[entry.targetLocale] = entry;
  }
  return Array.from(rowMap.values()).sort((a, b) =>
    a.sourceValue.localeCompare(b.sourceValue),
  );
}

export function SettingsTranslationsTab({
  groupedFieldTranslations,
  primaryShopLocale,
  t,
}: Props) {
  const fetcher = useFetcher<{ ok: boolean; synced?: number; failed?: number; total?: number; error?: string }>();
  const [filter, setFilter] = useState("");
  const [editValues, setEditValues] = useState<Record<string, string>>({});

  const rows = useMemo(() => buildRows(groupedFieldTranslations), [groupedFieldTranslations]);

  const targetLocales = useMemo(() => {
    const set = new Set<string>();
    for (const e of groupedFieldTranslations) {
      if (e.fieldKey === "productType") set.add(e.targetLocale);
    }
    return Array.from(set).sort();
  }, [groupedFieldTranslations]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return rows;
    const f = filter.trim().toLowerCase();
    return rows.filter(
      (row) =>
        row.sourceValue.toLowerCase().includes(f) ||
        Object.values(row.byLocale).some((e) => e.translatedValue.toLowerCase().includes(f)),
    );
  }, [rows, filter]);

  function submit(intent: Record<string, unknown>) {
    fetcher.submit(intent as Record<string, string>, {
      method: "post",
      action: "/api/grouped-field-translations",
      encType: "application/json",
    });
  }

  function handleSave(entry: GroupedFieldTranslationEntry) {
    const newValue = (editValues[entry.id] ?? entry.translatedValue).trim();
    if (!newValue || newValue === entry.translatedValue) return;
    submit({ intent: "update", id: entry.id, translatedValue: newValue });
  }

  function handleDelete(entry: GroupedFieldTranslationEntry) {
    submit({ intent: "delete", id: entry.id });
  }

  function handleDeleteRow(row: GroupedRow) {
    submit({
      intent: "deleteGroup",
      fieldKey: "productType",
      sourceLocale: row.sourceLocale,
      sourceValueNorm: row.sourceValueNorm,
    });
  }

  const isSubmitting = fetcher.state !== "idle";
  const showSyncBanner =
    fetcher.state === "idle" && fetcher.data?.ok && typeof fetcher.data?.synced === "number";

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingLg">
            {t.settings.translations}
          </Text>
          <Text as="p" tone="subdued" variant="bodyMd">
            {t.settings.translationsDescription}
          </Text>
        </BlockStack>
      </Card>

      {showSyncBanner && (
        <Banner tone={fetcher.data?.failed ? "warning" : "success"}>
          <Text as="p" variant="bodyMd">
            {(t.settings.translationsResyncResult ?? "Re-sync: {synced} updated, {failed} failed of {total}")
              .replace("{synced}", String(fetcher.data?.synced ?? 0))
              .replace("{failed}", String(fetcher.data?.failed ?? 0))
              .replace("{total}", String(fetcher.data?.total ?? 0))}
          </Text>
        </Banner>
      )}

      {fetcher.data && fetcher.data.ok === false && (
        <Banner tone="critical">
          <Text as="p" variant="bodyMd">
            {fetcher.data.error ?? t.common.error}
          </Text>
        </Banner>
      )}

      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingMd">
              {t.settings.translationsProductType}
            </Text>
            <Badge tone="info">{`${rows.length}`}</Badge>
          </InlineStack>

          <TextField
            label={t.settings.translationsSearchLabel}
            labelHidden
            placeholder={t.settings.translationsSearchPlaceholder}
            value={filter}
            onChange={setFilter}
            autoComplete="off"
          />

          {filtered.length === 0 ? (
            <EmptyState
              heading={t.settings.translationsEmptyHeading}
              image=""
            >
              <Text as="p" tone="subdued">
                {t.settings.translationsEmptyBody}
              </Text>
            </EmptyState>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                    <th style={thStyle}>
                      {t.settings.translationsSourceColumn} ({primaryShopLocale})
                    </th>
                    {targetLocales.map((loc) => (
                      <th key={loc} style={thStyle}>
                        {loc.toUpperCase()}
                      </th>
                    ))}
                    <th style={{ ...thStyle, width: 90 }}>{t.settings.translationsActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <tr
                      key={`${row.sourceLocale}::${row.sourceValueNorm}`}
                      style={{ borderBottom: "1px solid #f1f1f1" }}
                    >
                      <td style={tdStyle}>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {row.sourceValue}
                        </Text>
                      </td>
                      {targetLocales.map((loc) => {
                        const entry = row.byLocale[loc];
                        if (!entry) {
                          return (
                            <td key={loc} style={tdStyle}>
                              <Text as="span" tone="subdued">
                                —
                              </Text>
                            </td>
                          );
                        }
                        const draft = editValues[entry.id] ?? entry.translatedValue;
                        const dirty = draft.trim() !== entry.translatedValue && draft.trim().length > 0;
                        return (
                          <td key={loc} style={tdStyle}>
                            <BlockStack gap="100">
                              <TextField
                                label=""
                                labelHidden
                                value={draft}
                                onChange={(v) =>
                                  setEditValues((prev) => ({ ...prev, [entry.id]: v }))
                                }
                                autoComplete="off"
                                disabled={isSubmitting}
                              />
                              <InlineStack gap="100" align="start">
                                <Badge
                                  tone={
                                    entry.source === "user"
                                      ? "success"
                                      : entry.source === "imported"
                                        ? "info"
                                        : undefined
                                  }
                                >
                                  {(t.settings.translationsSourceLabels as Record<string, string>)?.[entry.source] ?? entry.source}
                                </Badge>
                                {dirty && (
                                  <Button
                                    size="micro"
                                    variant="primary"
                                    onClick={() => handleSave(entry)}
                                    disabled={isSubmitting}
                                  >
                                    {t.settings.translationsSaveAndResync}
                                  </Button>
                                )}
                                <Button
                                  size="micro"
                                  variant="tertiary"
                                  tone="critical"
                                  onClick={() => handleDelete(entry)}
                                  disabled={isSubmitting}
                                >
                                  {t.common.delete}
                                </Button>
                              </InlineStack>
                            </BlockStack>
                          </td>
                        );
                      })}
                      <td style={tdStyle}>
                        <Button
                          size="micro"
                          variant="tertiary"
                          tone="critical"
                          onClick={() => handleDeleteRow(row)}
                          disabled={isSubmitting}
                        >
                          {t.settings.translationsDeleteRow}
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
