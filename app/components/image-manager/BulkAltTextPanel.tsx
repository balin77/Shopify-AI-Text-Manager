import { useCallback, useState, useEffect, useRef } from "react";
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
  Tooltip,
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

function fillTemplate(
  template: string,
  variant: VariantWithGallery,
  gidTranslations?: Record<string, string>,
): string {
  let result = template;
  for (const opt of variant.selectedOptions) {
    const translated = opt.optionValueGid && gidTranslations ? gidTranslations[opt.optionValueGid] : undefined;
    const value = translated ?? opt.value;
    result = result.replace(new RegExp(`\\{${escapeRegex(opt.name)}\\}`, "g"), value);
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

export function BulkAltTextPanel({ productId, productTitle, variants, shopLocales, primaryLocale, onApplySuccess }: Props) {
  const { t } = useI18n();
  const im = t.imageManager;
  const { showInfoBox } = useInfoBox();

  const [positions, setPositions] = useState<TemplatePosition[]>([
    { position: 1, label: "", templates: {} },
  ]);
  const [activeLocale, setActiveLocale] = useState(primaryLocale);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [translatingPositions, setTranslatingPositions] = useState<Set<number>>(new Set());
  const [isTranslatingAll, setIsTranslatingAll] = useState(false);
  const [optionTranslations, setOptionTranslations] = useState<Record<string, Record<string, string>>>({});
  const [excludedLocales, setExcludedLocales] = useState<Set<string>>(new Set());
  const [isApplyingAll, setIsApplyingAll] = useState(false);
  const [applyAllProgress, setApplyAllProgress] = useState<{ done: number; total: number } | null>(null);
  // Tracks which locale chip received a Ctrl+pointerdown so the subsequent click
  // doesn't also switch the active locale.
  const ctrlPressedRef = useRef<Record<string, boolean>>({});

  const variableChips = buildVariableChips(variants);
  const isPrimaryLocale = activeLocale === primaryLocale;
  const foreignLocales = shopLocales.filter(l => l !== primaryLocale);
  const hasMultipleLocales = shopLocales.length > 1;

  // Load saved templates whenever productId changes
  useEffect(() => {
    if (!productId) return;
    setIsLoading(true);
    fetch(`/api/alt-text-templates?productId=${encodeURIComponent(productId)}`)
      .then((r) => r.json())
      .then((data: AltTextTemplateRow[]) => {
        if (!Array.isArray(data) || data.length === 0) {
          setPositions([{ position: 1, label: "", templates: {} }]);
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
        setPositions(sorted.length > 0 ? sorted : [{ position: 1, label: "", templates: {} }]);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [productId]);

  // Fetch translated option values for foreign locales so the preview reflects
  // what the apply step will actually save. Handles both metaobject-linked options
  // (display_name) and plain text option values (ProductOptionValue.name).
  useEffect(() => {
    if (isPrimaryLocale) return;
    if (optionTranslations[activeLocale]) return;

    const seen = new Map<string, { optionValueGid: string; metaobjectGid: string | null }>();
    for (const v of variants.slice(0, 3)) {
      for (const opt of v.selectedOptions) {
        if (!opt.optionValueGid) continue;
        if (!seen.has(opt.optionValueGid)) {
          seen.set(opt.optionValueGid, {
            optionValueGid: opt.optionValueGid,
            metaobjectGid: opt.metaobjectGid ?? null,
          });
        }
      }
    }
    if (seen.size === 0) {
      // No GIDs to translate (e.g. variants without options) — record empty result
      // so the preview renders immediately with the primary-locale fallback.
      setOptionTranslations((prev) => ({ ...prev, [activeLocale]: {} }));
      return;
    }

    let cancelled = false;
    fetch("/api/option-value-translations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: activeLocale, options: Array.from(seen.values()) }),
    })
      .then((r) => r.json())
      .then((data: { translations?: Record<string, string> }) => {
        if (cancelled) return;
        setOptionTranslations((prev) => ({ ...prev, [activeLocale]: data.translations ?? {} }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeLocale, isPrimaryLocale, variants, optionTranslations]);

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
      const newValue = current + `{${variableName}}`;
      handleTemplateChange(positionIndex, newValue);
      // Explicitly save: onBlur fires BEFORE onClick so the blur-triggered save
      // would capture the old value (without the just-inserted variable).
      saveTemplate(positions[positionIndex], activeLocale, newValue);
    },
    [positions, activeLocale, handleTemplateChange, saveTemplate]
  );

  /** Translate one position (positionIndex) or all positions (null) */
  const handleTranslate = useCallback(
    async (positionIndex: number | null) => {
      if (!hasMultipleLocales) return;

      const toLocales = isPrimaryLocale ? foreignLocales : [activeLocale];
      if (toLocales.length === 0) return;

      // Source is always primary locale templates
      const positionsToTranslate = positionIndex === null
        ? positions
        : [positions[positionIndex]];

      const templates = positionsToTranslate
        .map((pos) => ({ position: pos.position, template: pos.templates[primaryLocale] ?? "" }))
        .filter((t) => t.template.length > 0);

      if (templates.length === 0) return;

      // Set loading state
      if (positionIndex === null) {
        setIsTranslatingAll(true);
      } else {
        setTranslatingPositions((prev) => new Set([...prev, positionIndex]));
      }

      try {
        const res = await fetch("/api/translate-alt-text-template", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templates, fromLocale: primaryLocale, toLocales, productId, productTitle }),
        });
        const data = await res.json();

        if (data.success) {
          const translationsMap = data.translations as Record<string, Array<{ position: number; template: string }>>;

          // Gather current positions snapshot for save calls
          const currentPositions = positions;

          setPositions((prev) => {
            const next = prev.map((pos) => ({ ...pos, templates: { ...pos.templates } }));
            for (const [locale, items] of Object.entries(translationsMap)) {
              for (const item of items) {
                const idx = next.findIndex((p) => p.position === item.position);
                if (idx >= 0) {
                  next[idx].templates[locale] = item.template;
                }
              }
            }
            return next;
          });

          // Auto-save translated templates to DB
          for (const [locale, items] of Object.entries(translationsMap)) {
            for (const item of items) {
              const pos = currentPositions.find((p) => p.position === item.position);
              if (pos && item.template) {
                saveTemplate(pos, locale, item.template).catch(() => {});
              }
            }
          }
        }
      } catch {}

      if (positionIndex === null) {
        setIsTranslatingAll(false);
      } else {
        setTranslatingPositions((prev) => {
          const next = new Set(prev);
          next.delete(positionIndex);
          return next;
        });
      }
    },
    [hasMultipleLocales, isPrimaryLocale, foreignLocales, activeLocale, positions, primaryLocale, saveTemplate]
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
        showInfoBox(
          (im?.altTextTemplateApplySuccess ?? "Alt texts applied successfully") +
            (data.applied != null ? ` (${data.applied})` : ""),
          "success"
        );
        onApplySuccess?.();
      } else {
        const detail = Array.isArray(data.errors) && data.errors.length > 0
          ? data.errors.join("\n")
          : (data.error ?? "Unknown error");
        showInfoBox(detail, "critical");
      }
    } catch (e: any) {
      const detail = e.message ?? "Unknown error";
      showInfoBox(detail, "critical");
    } finally {
      setIsApplying(false);
    }
  }, [productId, activeLocale, primaryLocale, variants, im, showInfoBox, onApplySuccess]);

  // Locales that "Apply to all languages" will write to. Primary is always included;
  // foreign locales can be Ctrl-clicked off via excludedLocales.
  const targetLocales = shopLocales.filter((l) => !excludedLocales.has(l));
  const allLocalesComplete =
    targetLocales.length > 0 &&
    targetLocales.every((loc) =>
      positions.every((pos) => (pos.templates[loc] ?? "").trim().length > 0)
    );

  const handleApplyToAllLocales = useCallback(async () => {
    if (targetLocales.length === 0) return;
    setIsApplyingAll(true);
    setApplyAllProgress({ done: 0, total: targetLocales.length });
    let totalApplied = 0;
    const allErrors: string[] = [];
    try {
      for (let i = 0; i < targetLocales.length; i++) {
        const loc = targetLocales[i];
        try {
          const res = await fetch("/api/apply-alt-text-templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productId, locale: loc, primaryLocale, scope: "all", variants }),
          });
          const data = await res.json();
          if (typeof data.applied === "number") totalApplied += data.applied;
          if (Array.isArray(data.errors)) {
            allErrors.push(...data.errors.map((e: string) => `[${loc.toUpperCase()}] ${e}`));
          } else if (!data.success && data.error) {
            allErrors.push(`[${loc.toUpperCase()}] ${data.error}`);
          }
        } catch (e: any) {
          allErrors.push(`[${loc.toUpperCase()}] ${e?.message ?? "Unknown error"}`);
        }
        setApplyAllProgress({ done: i + 1, total: targetLocales.length });
      }
      if (allErrors.length === 0) {
        const langWord = targetLocales.length === 1 ? "language" : "languages";
        showInfoBox(
          `${im?.altTextTemplateApplySuccess ?? "Alt texts applied successfully"} (${totalApplied}, ${targetLocales.length} ${langWord})`,
          "success"
        );
      } else {
        showInfoBox(allErrors.join("\n"), "critical");
      }
      // Refresh the gallery either way so any partial saves become visible.
      onApplySuccess?.();
    } finally {
      setIsApplyingAll(false);
      setApplyAllProgress(null);
    }
  }, [targetLocales, productId, primaryLocale, variants, im, showInfoBox, onApplySuccess]);

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

  const anyTranslating = isTranslatingAll || translatingPositions.size > 0;

  return (
    <BlockStack gap="400">
      <Box padding="300">
        <BlockStack gap="300">
          {/* Locale chip bar — click to switch active, Ctrl-click to exclude from "apply to all" */}
          {shopLocales.length > 1 && (
            <BlockStack gap="100">
              <Text variant="bodyMd" as="p" fontWeight="medium">
                {im?.altTextTemplates ?? "Alt Text Templates"}
              </Text>
              <InlineStack gap="200" wrap>
                {shopLocales.map((loc) => {
                  const isPrimary = loc === primaryLocale;
                  const isExcluded = excludedLocales.has(loc);
                  return (
                    <Button
                      key={loc}
                      size="slim"
                      pressed={loc === activeLocale}
                      tone={isExcluded && !isPrimary ? "critical" : undefined}
                      onPointerDown={(event: React.PointerEvent) => {
                        if (event.ctrlKey && !isPrimary) {
                          ctrlPressedRef.current[loc] = true;
                          event.preventDefault();
                          setExcludedLocales((prev) => {
                            const next = new Set(prev);
                            if (next.has(loc)) next.delete(loc);
                            else next.add(loc);
                            return next;
                          });
                        }
                      }}
                      onClick={() => {
                        if (ctrlPressedRef.current[loc]) {
                          ctrlPressedRef.current[loc] = false;
                          return;
                        }
                        setActiveLocale(loc);
                      }}
                    >
                      {loc.toUpperCase()}
                    </Button>
                  );
                })}
              </InlineStack>
              <Text variant="bodySm" as="p" tone="subdued">
                {im?.altTextTemplateCtrlClickExclude ?? "Ctrl-click to exclude a language from ‘apply to all’"}
              </Text>
            </BlockStack>
          )}

          {/* Translate All button — below locale selector */}
          {hasMultipleLocales && (
            <Button
              size="slim"
              onClick={() => handleTranslate(null)}
              loading={isTranslatingAll}
              disabled={anyTranslating && !isTranslatingAll}
            >
              🌍 {isTranslatingAll
                ? (im?.altTextTemplateTranslating ?? "Translating…")
                : (im?.altTextTemplateTranslateAll ?? "Translate all positions")}
            </Button>
          )}

          {/* Positions */}
          {positions.map((pos, idx) => {
            const templateValue = pos.templates[activeLocale] ?? "";
            const isThisTranslating = translatingPositions.has(idx);
            return (
              <BlockStack key={pos.position} gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingSm" as="h3">
                    {(im?.altTextTemplatePosition ?? "Position {n}").replace("{n}", String(idx + 1))}
                    {pos.label ? ` – ${pos.label}` : ""}
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    {hasMultipleLocales && (
                      <Button
                        size="slim"
                        variant="plain"
                        onClick={() => handleTranslate(idx)}
                        loading={isThisTranslating}
                        disabled={anyTranslating && !isThisTranslating}
                      >
                        🌍 {isThisTranslating
                          ? (im?.altTextTemplateTranslating ?? "Translating…")
                          : (im?.altTextTemplateTranslate ?? "Translate")}
                      </Button>
                    )}
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
                          onMouseDown={(e) => {
                            // Prevent the text field from losing focus (blur fires before click,
                            // which would save the old value without the inserted variable).
                            e.preventDefault();
                            insertVariable(idx, chip);
                          }}
                          title={`Insert {${chip}}`}
                        >
                          {`{${chip}}`}
                        </span>
                      ))}
                    </InlineStack>
                  </BlockStack>
                )}

                {/* Preview */}
                {previewVariants.length > 0 && templateValue && (() => {
                  const isResolvingTranslations = !isPrimaryLocale && optionTranslations[activeLocale] === undefined;
                  return (
                    <BlockStack gap="100">
                      <Text variant="bodySm" as="p" tone="subdued">
                        {im?.altTextTemplatePreview ?? "Preview"}
                      </Text>
                      {isResolvingTranslations ? (
                        <Spinner size="small" />
                      ) : (
                        previewVariants.map((v) => (
                          <InlineStack key={v.id} gap="100" blockAlign="center" wrap={false}>
                            <Badge>{v.title}</Badge>
                            <Text variant="bodySm" as="p">
                              {fillTemplate(templateValue, v, isPrimaryLocale ? undefined : optionTranslations[activeLocale])}
                            </Text>
                          </InlineStack>
                        ))
                      )}
                    </BlockStack>
                  );
                })()}

                {idx < positions.length - 1 && <Divider />}
              </BlockStack>
            );
          })}

          {/* Add position */}
          <Button icon={PlusIcon} onClick={handleAddPosition} variant="plain">
            {im?.altTextTemplateAddPosition ?? "Add position"}
          </Button>

          <Divider />

          {/* Apply buttons — single locale (always visible) and all locales (when multi-locale) */}
          <InlineStack gap="200" wrap>
            <Button
              variant="primary"
              onClick={handleApplyToAll}
              loading={isApplying}
              disabled={variants.length === 0 || isApplyingAll}
            >
              {isApplying
                ? (im?.altTextTemplateApplying ?? "Applying…")
                : hasMultipleLocales
                  ? (im?.altTextTemplateApplyToActiveLocale ?? "Apply to images in {locale}")
                      .replace("{locale}", activeLocale.toUpperCase())
                  : (im?.altTextTemplateApplyToAll ?? "Apply to all images")}
            </Button>

            {hasMultipleLocales && (() => {
              const disabled = !allLocalesComplete || variants.length === 0 || isApplying || isApplyingAll;
              const button = (
                <Button
                  variant="primary"
                  onClick={handleApplyToAllLocales}
                  loading={isApplyingAll}
                  disabled={disabled}
                >
                  {isApplyingAll
                    ? `${im?.altTextTemplateApplyingAllLocales ?? "Applying to all languages…"}${applyAllProgress ? ` (${applyAllProgress.done}/${applyAllProgress.total})` : ""}`
                    : (im?.altTextTemplateApplyToAllLocales ?? "Apply to images in all languages")}
                </Button>
              );
              return !allLocalesComplete && variants.length > 0 ? (
                <Tooltip content={im?.altTextTemplateAllLocalesIncomplete ?? "All positions need a template in every non-excluded language"}>
                  <div>{button}</div>
                </Tooltip>
              ) : (
                button
              );
            })()}
          </InlineStack>

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
