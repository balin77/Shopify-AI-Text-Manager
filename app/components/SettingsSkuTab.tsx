import { useMemo, useState } from "react";
import { useFetcher } from "react-router";
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

interface OptionValueMemoryEntry {
  optionValue: string;
  savedAs: string;
}

interface Props {
  optionValueMemory: OptionValueMemoryEntry[];
  t: I18nTranslation;
}

export function SettingsSkuTab({ optionValueMemory, t }: Props) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [filter, setFilter] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});

  const filtered = useMemo(() => {
    if (!filter.trim()) return optionValueMemory;
    const f = filter.trim().toLowerCase();
    return optionValueMemory.filter(
      (m) =>
        m.optionValue.toLowerCase().includes(f) ||
        m.savedAs.toLowerCase().includes(f),
    );
  }, [optionValueMemory, filter]);

  function submit(body: Record<string, unknown>) {
    fetcher.submit(body as Record<string, string>, {
      method: "post",
      action: "/api/option-value-memory",
      encType: "application/json",
    });
  }

  function handleSave(entry: OptionValueMemoryEntry) {
    const next = (edits[entry.optionValue] ?? entry.savedAs).trim();
    if (!next || next === entry.savedAs) return;
    submit({ intent: "update", optionValue: entry.optionValue, savedAs: next });
  }

  function handleDelete(entry: OptionValueMemoryEntry) {
    submit({ intent: "delete", optionValue: entry.optionValue });
  }

  const isSubmitting = fetcher.state !== "idle";

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingLg">
            {t.settings.sku}
          </Text>
          <Text as="p" tone="subdued" variant="bodyMd">
            {t.settings.skuDescription}
          </Text>
        </BlockStack>
      </Card>

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
              {t.settings.skuMatchKeys}
            </Text>
            <Badge tone="info">{`${optionValueMemory.length}`}</Badge>
          </InlineStack>

          <TextField
            label={t.settings.skuSearchLabel}
            labelHidden
            placeholder={t.settings.skuSearchPlaceholder}
            value={filter}
            onChange={setFilter}
            autoComplete="off"
          />

          {filtered.length === 0 ? (
            <EmptyState heading={t.settings.skuEmptyHeading} image="">
              <Text as="p" tone="subdued">
                {t.settings.skuEmptyBody}
              </Text>
            </EmptyState>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                    <th style={thStyle}>{t.settings.skuOptionValue}</th>
                    <th style={thStyle}>{t.settings.skuSavedAs}</th>
                    <th style={{ ...thStyle, width: 220 }}>{t.settings.skuActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry) => {
                    const draft = edits[entry.optionValue] ?? entry.savedAs;
                    const dirty = draft.trim() !== entry.savedAs && draft.trim().length > 0;
                    return (
                      <tr key={entry.optionValue} style={{ borderBottom: "1px solid #f1f1f1" }}>
                        <td style={tdStyle}>
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {entry.optionValue}
                          </Text>
                        </td>
                        <td style={tdStyle}>
                          <TextField
                            label=""
                            labelHidden
                            value={draft}
                            onChange={(v) =>
                              setEdits((prev) => ({ ...prev, [entry.optionValue]: v }))
                            }
                            autoComplete="off"
                            disabled={isSubmitting}
                          />
                        </td>
                        <td style={tdStyle}>
                          <InlineStack gap="100">
                            {dirty && (
                              <Button
                                size="micro"
                                variant="primary"
                                onClick={() => handleSave(entry)}
                                disabled={isSubmitting}
                              >
                                {t.common?.save ?? "Save"}
                              </Button>
                            )}
                            <Button
                              size="micro"
                              variant="tertiary"
                              tone="critical"
                              onClick={() => handleDelete(entry)}
                              disabled={isSubmitting}
                            >
                              {t.common?.delete ?? "Delete"}
                            </Button>
                          </InlineStack>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Text as="p" tone="subdued" variant="bodySm">
            {t.settings.skuFormatHint}
          </Text>
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
