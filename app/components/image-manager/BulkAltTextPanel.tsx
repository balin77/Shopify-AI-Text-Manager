import { useCallback, useState, useEffect } from "react";
import {
  Text,
  Button,
  BlockStack,
  InlineStack,
  TextField,
  Badge,
  Spinner,
  Divider,
  Box,
  Select,
} from "@shopify/polaris";
import { PlusIcon, DeleteIcon } from "@shopify/polaris-icons";
import { useI18n } from "../../contexts/I18nContext";
import { useInfoBox } from "../../contexts/InfoBoxContext";
import type { VariantWithGallery } from "./types";

export interface AltTextTemplateRow {
  position: number;
  positionLabel: string;
  locale: string;
  template: string;
}

interface TemplatePosition {
  position: number;
  label: string;
  /** Templates keyed by locale */
  templates: Record<string, string>;
}

interface Props {
  productId: string;
  productTitle: string;
  variants: VariantWithGallery[];
  shopLocales: string[];
  primaryLocale: string;
  onApplySuccess?: () => void;
}

function fillTemplate(template: string, variant: VariantWithGallery): string {
  let result = template;
  for (const opt of variant.selectedOptions) {
    result = result.replace(new RegExp(`\\{${escapeRegex(opt.name)}\\}`, "g"), opt.value);
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildVariableChips(variants: VariantWithGallery[]): string[] {
  const seen = new Set<string>();
  for (const v of variants) {
    for (const opt of v.selectedOptions) {
      seen.add(opt.name);
    }
  }
  return Array.from(seen);
}

export function BulkAltTextPanel({ productId, variants, shopLocales, primaryLocale, onApplySuccess }: Props) {
  const { t } = useI18n();
  const im = t.imageManager;
  const { showInfoBox } = useInfoBox();

  const [positions, setPositions] = useState<TemplatePosition[]>([
    { position: 0, label: "", templates: {} },
  ]);
  const [activeLocale, setActiveLocale] = useState(primaryLocale);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const variableChips = buildVariableChips(variants);

  // Load saved templates whenever productId changes
  useEffect(() => {
    if (!productId) return;
    setIsLoading(true);
    fetch(`/api/alt-text-templates?productId=${encodeURIComponent(productId)}`)
      .then((r) => r.json())
      .then((data: AltTextTemplateRow[]) => {
        if (!Array.isArray(data) || data.length === 0) {
          setPositions([{ position: 0, label: "", templates: {} }]);
          return;
        }
        // Group by position
        const posMap = new Map<number, TemplatePosition>();
        for (const row of data) {
          if (!posMap.has(row.position)) {
            posMap.set(row.position, {
              position: row.position,
              label: row.positionLabel ?? "",
              templates: {},
            });
          }
          posMap.get(row.position)!.templates[row.locale] = row.template;
        }
        const sorted = Array.from(posMap.values()).sort((a, b) => a.position - b.position);
        setPositions(sorted.length > 0 ? sorted : [{ position: 0, label: "", templates: {} }]);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [productId]);

  const saveTemplate = useCallback(
    async (pos: TemplatePosition, locale: string, value: string) => {
      try {
        await fetch("/api/alt-text-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId,
            position: pos.position,
            positionLabel: pos.label,
            locale,
            template: value,
          }),
        });
      } catch {}
    },
    [productId]
  );

  const handleTemplateChange = useCallback(
    (positionIndex: number, value: string) => {
      setPositions((prev) => {
        const next = [...prev];
        next[positionIndex] = {
          ...next[positionIndex],
          templates: { ...next[positionIndex].templates, [activeLocale]: value },
        };
        return next;
      });
    },
    [activeLocale]
  );

  const handleTemplateBlur = useCallback(
    (positionIndex: number) => {
      const pos = positions[positionIndex];
      const value = pos.templates[activeLocale] ?? "";
      saveTemplate(pos, activeLocale, value);
    },
    [positions, activeLocale, saveTemplate]
  );

  const handleLabelChange = useCallback((positionIndex: number, label: string) => {
    setPositions((prev) => {
      const next = [...prev];
      next[positionIndex] = { ...next[positionIndex], label };
      return next;
    });
  }, []);

  const handleLabelBlur = useCallback(
    (positionIndex: number) => {
      const pos = positions[positionIndex];
      for (const locale of Object.keys(pos.templates)) {
        if (pos.templates[locale]) {
          saveTemplate(pos, locale, pos.templates[locale]);
        }
      }
    },
    [positions, saveTemplate]
  );

  const handleAddPosition = useCallback(() => {
    setPositions((prev) => {
      const maxPos = prev.length > 0 ? Math.max(...prev.map((p) => p.position)) : -1;
      return [...prev, { position: maxPos + 1, label: "", templates: {} }];
    });
  }, []);

  const handleRemovePosition = useCallback(
    async (positionIndex: number) => {
      const pos = positions[positionIndex];
      try {
        await fetch(
          `/api/alt-text-templates?productId=${encodeURIComponent(productId)}&position=${pos.position}`,
          { method: "DELETE" }
        );
      } catch {}
      setPositions((prev) => prev.filter((_, i) => i !== positionIndex));
    },
    [positions, productId]
  );

  const insertVariable = useCallback(
    (positionIndex: number, variableName: string) => {
      const current = positions[positionIndex].templates[activeLocale] ?? "";
      handleTemplateChange(positionIndex, current + `{${variableName}}`);
    },
    [positions, activeLocale, handleTemplateChange]
  );

  const handleApplyToAll = useCallback(async () => {
    setIsApplying(true);
    try {
      const res = await fetch("/api/apply-alt-text-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          locale: activeLocale,
          primaryLocale,
          scope: "all",
          variants,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showInfoBox(im?.altTextTemplateApplySuccess ?? "Alt texts applied successfully", "success");
        onApplySuccess?.();
      } else {
        const msg = (im?.altTextTemplateApplyError ?? "Error: {error}").replace(
          "{error}",
          data.error ?? "unknown"
        );
        showInfoBox(msg, "critical");
      }
    } catch (e: any) {
      const msg = (im?.altTextTemplateApplyError ?? "Error: {error}").replace(
        "{error}",
        e.message ?? "unknown"
      );
      showInfoBox(msg, "critical");
    } finally {
      setIsApplying(false);
    }
  }, [productId, activeLocale, primaryLocale, variants, im, showInfoBox, onApplySuccess]);

  const localeOptions = shopLocales.map((l) => ({ label: l.toUpperCase(), value: l }));
  const previewVariants = variants.slice(0, 3);

  if (isLoading) {
    return (
      <Box padding="400">
        <InlineStack align="center">
          <Spinner size="small" />
        </InlineStack>
      </Box>
    );
  }

  return (
    <BlockStack gap="400">
      <Box padding="300">
        <BlockStack gap="300">
          {/* Locale selector */}
          {shopLocales.length > 1 && (
            <Select
              label={im?.altTextTemplates ?? "Alt Text Templates"}
              options={localeOptions}
              value={activeLocale}
              onChange={setActiveLocale}
            />
          )}


          {/* Positions */}
          {positions.map((pos, idx) => {
            const templateValue = pos.templates[activeLocale] ?? "";
            return (
              <BlockStack key={pos.position} gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingSm" as="h3">
                    {(im?.altTextTemplatePosition ?? "Position {n}").replace("{n}", String(idx + 1))}
                    {pos.label ? ` – ${pos.label}` : ""}
                  </Text>
                  {positions.length > 1 && (
                    <Button
                      icon={DeleteIcon}
                      tone="critical"
                      variant="plain"
                      onClick={() => handleRemovePosition(idx)}
                      accessibilityLabel="Remove position"
                    />
                  )}
                </InlineStack>

                <TextField
                  label={im?.altTextTemplatePositionLabel ?? "Position label"}
                  value={pos.label}
                  onChange={(v) => handleLabelChange(idx, v)}
                  onBlur={() => handleLabelBlur(idx)}
                  autoComplete="off"
                />

                <TextField
                  label="Template"
                  value={templateValue}
                  onChange={(v) => handleTemplateChange(idx, v)}
                  onBlur={() => handleTemplateBlur(idx)}
                  placeholder={im?.altTextTemplatePlaceholder ?? "e.g. Elegant {Color} vase"}
                  multiline={2}
                  autoComplete="off"
                />

                {/* Variable chips */}
                {variableChips.length > 0 && (
                  <BlockStack gap="100">
                    <Text variant="bodySm" as="p" tone="subdued">
                      {im?.altTextTemplateVariableHint ?? "Available variables"}
                    </Text>
                    <InlineStack gap="100" wrap>
                      {variableChips.map((chip) => (
                        <span
                          key={chip}
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            background: "#f1f2f3",
                            borderRadius: 4,
                            fontSize: 12,
                            cursor: "pointer",
                            border: "1px solid #c9cccf",
                            userSelect: "none",
                          }}
                          onClick={() => insertVariable(idx, chip)}
                          title={`Insert {${chip}}`}
                        >
                          {`{${chip}}`}
                        </span>
                      ))}
                    </InlineStack>
                  </BlockStack>
                )}

                {/* Preview */}
                {previewVariants.length > 0 && templateValue && (
                  <BlockStack gap="100">
                    <Text variant="bodySm" as="p" tone="subdued">
                      {im?.altTextTemplatePreview ?? "Preview"}
                    </Text>
                    {previewVariants.map((v) => (
                      <InlineStack key={v.id} gap="100" blockAlign="center" wrap={false}>
                        <Badge>{v.title}</Badge>
                        <Text variant="bodySm" as="p">
                          {fillTemplate(templateValue, v)}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}

                {idx < positions.length - 1 && <Divider />}
              </BlockStack>
            );
          })}

          {/* Add position */}
          <Button icon={PlusIcon} onClick={handleAddPosition} variant="plain">
            {im?.altTextTemplateAddPosition ?? "Add position"}
          </Button>

          <Divider />

          {/* Apply to all button */}
          <Button
            variant="primary"
            onClick={handleApplyToAll}
            loading={isApplying}
            disabled={variants.length === 0}
          >
            {isApplying
              ? (im?.altTextTemplateApplying ?? "Applying…")
              : (im?.altTextTemplateApplyToAll ?? "Apply to all images")}
          </Button>

          {variants.length === 0 && (
            <Text variant="bodySm" as="p" tone="subdued">
              {im?.altTextTemplateNoVariants ?? "No variants found"}
            </Text>
          )}
        </BlockStack>
      </Box>
    </BlockStack>
  );
}
