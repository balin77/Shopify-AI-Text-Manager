import { useCallback, useState, useEffect, useRef } from "react";
import { useFetcher } from "@remix-run/react";
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
  Card,
} from "@shopify/polaris";
import { PlusIcon, DeleteIcon } from "@shopify/polaris-icons";
import { useI18n } from "../../contexts/I18nContext";
import { useInfoBox } from "../../contexts/InfoBoxContext";
import { useAltTextOps } from "../../contexts/AltTextOpsContext";
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
  selectedGids?: string[];
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

export function BulkAltTextPanel({ productId, productTitle, variants, shopLocales, primaryLocale, onApplySuccess, selectedGids = [] }: Props) {
  const { t } = useI18n();
  const im = t.imageManager;
  const { showInfoBox } = useInfoBox();
  const skuFetcher = useFetcher<{ success: boolean; updated?: number; error?: string }>();
  const prevSkuFetcherData = useRef<typeof skuFetcher.data>(undefined);

  const [positions, setPositions] = useState<TemplatePosition[]>([
    { position: 1, label: "", templates: {} },
  ]);
  const [activeLocale, setActiveLocale] = useState(primaryLocale);
  const [isLoading, setIsLoading] = useState(false);
  const [optionTranslations, setOptionTranslations] = useState<Record<string, Record<string, string>>>({});
  const [excludedLocales, setExcludedLocales] = useState<Set<string>>(new Set());

  // Operation flags live in a product-scoped store so an apply/translate
  // started here keeps running — and keeps THIS product's buttons disabled —
  // even after the user switches to another product and back. `productId` is
  // captured by these callbacks at invocation time, so completions always
  // settle the product they were started on, never whichever is on screen.
  const { ops, patch: patchOps, setPositionTranslating, setApplyingLocale } = useAltTextOps(productId);
  // Per-locale: only the locale actually being applied shows loading/blocked,
  // so switching to another language frees its button immediately.
  const isApplyingActiveLocale = ops.applyingLocales.includes(activeLocale);
  const anyApplying = ops.applyingLocales.length > 0;
  const isApplyingAll = ops.applyingAll;
  const applyAllProgress = ops.applyAllProgress;
  const isTranslatingAll = ops.translatingAll;
  const translatingPositions = ops.translatingPositions;

  // Tracks the product currently on screen (updated every render, unlike the
  // productId captured in each callback's closure). Lets a completion that
  // started on product A skip the gallery refresh / scope its toast when the
  // user has since navigated to product B.
  const currentProductIdRef = useRef(productId);
  currentProductIdRef.current = productId;
  const isStillActive = useCallback(
    (startedProductId: string) => currentProductIdRef.current === startedProductId,
    []
  );
  // Prefix the toast with the *started* product's title when the user has
  // since navigated away, so a background completion isn't mistaken for the
  // product now on screen. `startedTitle` comes from the handler's closure
  // (bound to the product the op started on), never the current prop.
  const scopedMsg = useCallback(
    (msg: string, startedProductId: string, startedTitle: string) =>
      currentProductIdRef.current === startedProductId
        ? msg
        : `${startedTitle ? `${startedTitle}: ` : ""}${msg}`,
    []
  );
  // Tracks which locale chip received a Ctrl+pointerdown so the subsequent click
  // doesn't also switch the active locale.
  const ctrlPressedRef = useRef<Record<string, boolean>>({});

  const variableChips = buildVariableChips(variants);
  const isPrimaryLocale = activeLocale === primaryLocale;
  const foreignLocales = shopLocales.filter(l => l !== primaryLocale);
  const hasMultipleLocales = shopLocales.length > 1;

  const isSkuRunning = skuFetcher.state !== "idle";

  const handleSkuGenerate = useCallback((gids: string[]) => {
    if (!gids.length) return;
    const form = new FormData();
    form.append("action", "generateAltTextFromSku");
    form.append("productId", productId);
    gids.forEach(gid => form.append("mediaId", gid));
    skuFetcher.submit(form, { method: "post" });
  }, [productId, skuFetcher]);

  useEffect(() => {
    const data = skuFetcher.data;
    if (!data || data === prevSkuFetcherData.current) return;
    prevSkuFetcherData.current = data;
    if (data.success) {
      showInfoBox(im?.altTextFromSkuSuccess ?? "Alt texts from SKU applied", "success");
    } else {
      showInfoBox((im?.altTextFromSkuError ?? "Error: {error}").replace("{error}", data.error ?? ""), "critical");
    }
  }, [skuFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Variants still loading → don't lock the cache. Only mark "nothing to
      // translate" when variants are actually present but carry no option GIDs;
      // otherwise the guard above would prevent the effect from ever re-fetching
      // once variants populate, leaving the preview stuck on primary-locale values.
      if (variants.length > 0) {
        setOptionTranslations((prev) => ({ ...prev, [activeLocale]: {} }));
      }
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

      // Key the per-position spinner by the stable pos.position, not the array
      // index: removing/adding a position mid-translation shifts every later
      // index, which would strand the spinner on the wrong row.
      const posKey =
        positionIndex === null ? null : positions[positionIndex]?.position ?? null;

      // Set loading state (product-scoped). Per-position translations are
      // independent: starting one must not block the others.
      if (positionIndex === null) {
        patchOps({ translatingAll: true });
      } else if (posKey !== null) {
        setPositionTranslating(posKey, true);
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
        patchOps({ translatingAll: false });
      } else if (posKey !== null) {
        setPositionTranslating(posKey, false);
      }
    },
    [hasMultipleLocales, isPrimaryLocale, foreignLocales, activeLocale, positions, primaryLocale, productId, productTitle, saveTemplate, patchOps, setPositionTranslating]
  );

  const handleApplyToAll = useCallback(async () => {
    // Bind to the locale at click time: activeLocale can change while the
    // request is in flight, but this apply (and its button) belong to `loc`.
    const loc = activeLocale;
    if (ops.applyingLocales.includes(loc)) return; // reentrancy guard
    setApplyingLocale(loc, true);
    try {
      const res = await fetch("/api/apply-alt-text-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          locale: loc,
          primaryLocale,
          scope: "all",
          variants,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showInfoBox(
          scopedMsg(
            (im?.altTextTemplateApplySuccess ?? "Alt texts applied successfully") +
              (data.applied != null ? ` (${data.applied})` : ""),
            productId,
            productTitle
          ),
          "success"
        );
        if (isStillActive(productId)) onApplySuccess?.();
      } else {
        const detail = Array.isArray(data.errors) && data.errors.length > 0
          ? data.errors.join("\n")
          : (data.error ?? "Unknown error");
        showInfoBox(scopedMsg(detail, productId, productTitle), "critical");
      }
    } catch (e: any) {
      const detail = e.message ?? "Unknown error";
      showInfoBox(scopedMsg(detail, productId, productTitle), "critical");
    } finally {
      setApplyingLocale(loc, false);
    }
  }, [ops.applyingLocales, productId, productTitle, activeLocale, primaryLocale, variants, im, showInfoBox, onApplySuccess, setApplyingLocale, scopedMsg, isStillActive]);

  // Locales that "Apply to all languages" will write to. Primary is always included;
  // foreign locales can be Ctrl-clicked off via excludedLocales.
  const targetLocales = shopLocales.filter((l) => !excludedLocales.has(l));
  const allLocalesComplete =
    targetLocales.length > 0 &&
    targetLocales.every((loc) =>
      positions.every((pos) => (pos.templates[loc] ?? "").trim().length > 0)
    );

  const handleApplyToAllLocales = useCallback(async () => {
    if (ops.applyingAll) return; // reentrancy guard (double-click / keyboard)
    if (targetLocales.length === 0) return;
    const total = targetLocales.length;
    patchOps({ applyingAll: true, applyAllProgress: { done: 0, total } });
    let totalApplied = 0;
    const allErrors: string[] = [];
    try {
      // Send every locale to Shopify simultaneously. An earlier revision ran
      // the primary locale first and BLOCKED on it before starting the
      // foreign ones — but the primary apply can be slow (it triggers the
      // products/update webhook → product-sync), so the foreign locales (and
      // their tasks) only appeared minutes later, looking like "only the main
      // language was applied". Concurrency is what the feature is supposed to
      // do; the server-side DB-race retry already makes the parallel
      // sync-collision safe.
      let done = 0;
      const runLocale = async (loc: string) => {
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
        } finally {
          done += 1;
          patchOps({ applyAllProgress: { done, total } });
        }
      };

      await Promise.allSettled(targetLocales.map(runLocale));
      if (allErrors.length === 0) {
        const langWord = targetLocales.length === 1 ? "language" : "languages";
        showInfoBox(
          scopedMsg(
            `${im?.altTextTemplateApplySuccess ?? "Alt texts applied successfully"} (${totalApplied}, ${targetLocales.length} ${langWord})`,
            productId,
            productTitle
          ),
          "success"
        );
      } else {
        showInfoBox(scopedMsg(allErrors.join("\n"), productId, productTitle), "critical");
      }
      // Refresh the gallery only if this product is still on screen — a
      // background completion must not yank the gallery the user is now
      // looking at on another product.
      if (isStillActive(productId)) onApplySuccess?.();
    } finally {
      patchOps({ applyingAll: false, applyAllProgress: null });
    }
  }, [ops.applyingAll, targetLocales, productId, productTitle, primaryLocale, variants, im, showInfoBox, onApplySuccess, patchOps, scopedMsg, isStillActive]);

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
    <Card>
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
              disabled={isTranslatingAll}
            >
              🌍 {isTranslatingAll
                ? (im?.altTextTemplateTranslating ?? "Translating…")
                : (im?.altTextTemplateTranslateAll ?? "Translate all positions")}
            </Button>
          )}

          {/* Positions */}
          {positions.map((pos, idx) => {
            const templateValue = pos.templates[activeLocale] ?? "";
            const isThisTranslating = translatingPositions.includes(pos.position);
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
                        disabled={isThisTranslating || isTranslatingAll}
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
                        accessibilityLabel={im?.altTextTemplateRemovePosition ?? "Remove position"}
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

          {/* Apply buttons — single locale (always visible) and all locales (when multi-locale).
              Use a 2-column grid so both buttons have identical width. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: hasMultipleLocales ? "1fr 1fr" : "1fr",
              gap: 8,
            }}
          >
            <Button
              variant="primary"
              fullWidth
              onClick={handleApplyToAll}
              loading={isApplyingActiveLocale}
              disabled={variants.length === 0 || isApplyingAll || isApplyingActiveLocale}
            >
              {isApplyingActiveLocale
                ? (im?.altTextTemplateApplying ?? "Applying…")
                : hasMultipleLocales
                  ? (im?.altTextTemplateApplyToActiveLocale ?? "Apply to images in {locale}")
                      .replace("{locale}", activeLocale.toUpperCase())
                  : (im?.altTextTemplateApplyToAll ?? "Apply to all images")}
            </Button>

            {hasMultipleLocales && (() => {
              const disabled = !allLocalesComplete || variants.length === 0 || anyApplying || isApplyingAll;
              const button = (
                <Button
                  variant="primary"
                  fullWidth
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
          </div>

          {variants.length === 0 && (
            <Text variant="bodySm" as="p" tone="subdued">
              {im?.altTextTemplateNoVariants ?? "No variants found"}
            </Text>
          )}

          <Divider />

          {/* SKU alt text section */}
          <BlockStack gap="200">
            <Text variant="headingSm" as="h3">
              {im?.altTextFromSkuSection ?? "Alt text from SKU"}
            </Text>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              <Button
                fullWidth
                onClick={() => {
                  const allGids = variants.flatMap(v => v.galleryFileGids);
                  handleSkuGenerate(allGids);
                }}
                loading={isSkuRunning}
                disabled={variants.length === 0}
              >
                {isSkuRunning
                  ? (im?.altTextFromSkuRunning ?? "Applying…")
                  : (im?.altTextFromSkuAllBtn ?? "All")}
              </Button>
              <Button
                fullWidth
                onClick={() => handleSkuGenerate(selectedGids)}
                loading={isSkuRunning}
                disabled={selectedGids.length === 0}
              >
                {(im?.altTextFromSkuSelectedBtn ?? "Selected only ({n})")
                  .replace("{n}", String(selectedGids.length))}
              </Button>
            </div>
            {selectedGids.length === 0 && (
              <Text variant="bodySm" as="p" tone="subdued">
                {im?.altTextFromSkuNoSelection ?? "No images selected"}
              </Text>
            )}
          </BlockStack>
        </BlockStack>
    </Card>
  );
}
