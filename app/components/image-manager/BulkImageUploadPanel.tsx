import { useCallback, useState, useMemo, useRef, useEffect } from "react";
import {
  DropZone,
  Text,
  Button,
  Icon,
  InlineStack,
  BlockStack,
  Badge,
  Collapsible,
  Card,
  Box,
  Divider,
  Select,
  TextField,
} from "@shopify/polaris";
import { QuestionCircleIcon } from "@shopify/polaris-icons";
import "../../styles/HelpTooltip.css";
import { useI18n } from "../../contexts/I18nContext";
import { parseFilename, parseSku } from "../../utils/parseFilenames";
import { BulkSortableList } from "./BulkSortableList";
import type { StagedItem, VariantWithGallery, VariantSelectedOption } from "./types";

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];

type SortMode = "identifier" | "sku" | "filename" | "custom";
type MatchMode = "sku" | "imageKey";
type LabelMode = "name" | "handle" | "memory";

/** Strip spaces and underscores — underscores are our separator so must not appear inside a segment. */
const cleanSeg = (s: string) => s.replace(/[\s_]+/g, "");

/** Return the chip display text for one option value (before key generation). */
function getOptionDisplay(
  opt: VariantSelectedOption,
  labelMode: LabelMode,
  override?: string,
  memoryMap: Record<string, string> = {},
): string {
  if (override !== undefined) return override;
  if (labelMode === "handle" && opt.handle) return opt.handle;
  if (labelMode === "memory") return memoryMap[opt.value] ?? opt.value;
  return opt.value;
}

/** Return the key-segment for one option value (spaces and underscores removed). */
function getOptionKeySegment(
  opt: VariantSelectedOption,
  labelMode: LabelMode,
  override?: string,
  memoryMap: Record<string, string> = {},
): string {
  if (override !== undefined) return cleanSeg(override);
  if (labelMode === "handle" && opt.handle) return cleanSeg(opt.handle);
  if (labelMode === "memory") return cleanSeg(memoryMap[opt.value] ?? opt.value);
  return cleanSeg(opt.value);
}

/**
 * Try to reverse-engineer per-option segments from a saved full key.
 * Returns an array of segments (one per option) or null if the format doesn't match.
 * Example: baseName="Box", key="Box_Peanut_S", 2 options → ["Peanut","S"]
 */
function extractSegmentsFromKey(
  fullKey: string,
  baseName: string,
  optCount: number,
): string[] | null {
  if (!fullKey || optCount === 0) return null;
  const prefix = cleanSeg(baseName.trim());
  let remaining = fullKey;
  if (prefix) {
    if (remaining.startsWith(prefix + "_")) {
      remaining = remaining.slice(prefix.length + 1);
    } else if (remaining === prefix) {
      return null;
    } else {
      return null;
    }
  }
  const parts = remaining.split("_");
  if (parts.length !== optCount) return null;
  return parts;
}

/** Build the full key for a variant given the current state. */
function buildVariantKey(
  baseName: string,
  variant: VariantWithGallery,
  labelMode: LabelMode,
  overrides: Record<number, string>,
  memoryMap: Record<string, string> = {},
): string {
  const opts = variant.selectedOptions.length > 0
    ? variant.selectedOptions
    : variant.title.split(" / ").map(v => ({ name: "", value: v, handle: null }));
  const parts = opts.map((opt, i) => getOptionKeySegment(opt, labelMode, overrides[i], memoryMap));
  return [baseName.trim(), ...parts].filter(Boolean).join("_");
}

/** Match a StagedItem against all variants using the selected field. */
function autoAssign(item: StagedItem, variants: VariantWithGallery[], matchMode: MatchMode): StagedItem {
  let meta: ReturnType<typeof parseFilename> | null = null;
  try {
    meta = parseFilename(item.fileName);
  } catch {
    return { ...item, assignmentMode: "unassigned" };
  }

  const match = variants.find(v => {
    const key = matchMode === "sku" ? v.sku : v.imageKey;
    if (!key) return false;
    try {
      const keyData = parseSku(key);
      return (
        keyData.productName === meta!.productName &&
        keyData.variants.length === meta!.variants.length &&
        keyData.variants.every((part, i) => part === meta!.variants[i])
      );
    } catch {
      return false;
    }
  });

  return {
    ...item,
    parsedMeta: meta,
    targetVariantId: match?.id,
    assignmentMode: match ? "assigned" : "unassigned",
  };
}

interface AltTextPositionTemplate {
  position: number;
  label: string;
  template: string;
}

interface BulkImageUploadPanelProps {
  items: StagedItem[];
  selectedUniqueIds: Set<string>;
  variants?: VariantWithGallery[];
  productTitle?: string;
  productId?: string;
  primaryLocale?: string;
  onItemsChange: (updater: (prev: StagedItem[]) => StagedItem[]) => void;
  onSelect: (uniqueId: string, selected: boolean) => void;
  onRemove: (uniqueIds: string[]) => void;
  onConfirm?: () => Promise<string | null>;
  isConfirming?: boolean;
}

export function BulkImageUploadPanel({
  items,
  selectedUniqueIds,
  variants = [],
  productTitle,
  productId,
  primaryLocale,
  onItemsChange,
  onSelect,
  onRemove,
  onConfirm,
  isConfirming = false,
}: BulkImageUploadPanelProps) {
  const { t } = useI18n();
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generatorDocsOpen, setGeneratorDocsOpen] = useState(false);
  const [sortListOpen, setSortListOpen] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("identifier");
  // Alt text template block state
  const [altTextOpen, setAltTextOpen] = useState(false);
  const [applyOnUpload, setApplyOnUpload] = useState(false);
  const [altTextPositions, setAltTextPositions] = useState<AltTextPositionTemplate[]>([
    { position: 0, label: "", template: "" },
  ]);

  // Matching & generation state
  const [matchMode, setMatchMode] = useState<MatchMode>("sku");
  const [labelMode, setLabelMode] = useState<LabelMode>("name");
  const [baseName, setBaseName] = useState("");
  // optionOverrides[variantId][optionIndex] = override string
  const [optionOverrides, setOptionOverrides] = useState<Record<string, Record<number, string>>>({});
  // Which chip is currently being edited inline: { variantId, optionIndex }
  const [editingChip, setEditingChip] = useState<{ variantId: string; optionIndex: number } | null>(null);
  const [editingChipValue, setEditingChipValue] = useState("");

  // Key inputs (what will be saved / matched against)
  const [localKeys, setLocalKeys] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Memory: optionValue (display name) → last saved key segment
  const [memoryMap, setMemoryMap] = useState<Record<string, string>>({});
  useEffect(() => {
    fetch("/api/option-value-memory")
      .then(r => r.json())
      .then(d => setMemoryMap(d.memory ?? {}))
      .catch(() => {});
  }, []);

  // Load alt text templates for this product
  useEffect(() => {
    if (!productId) return;
    fetch(`/api/alt-text-templates?productId=${encodeURIComponent(productId)}`)
      .then(r => r.json())
      .then((data: Array<{ position: number; positionLabel: string; locale: string; template: string }>) => {
        if (!Array.isArray(data) || data.length === 0) return;
        // Only use primary locale templates, grouped by position
        const posMap = new Map<number, AltTextPositionTemplate>();
        for (const row of data) {
          if ((primaryLocale && row.locale !== primaryLocale) || (!primaryLocale && row.locale !== "en")) continue;
          if (!posMap.has(row.position)) {
            posMap.set(row.position, { position: row.position, label: row.positionLabel ?? "", template: row.template });
          }
        }
        const sorted = Array.from(posMap.values()).sort((a, b) => a.position - b.position);
        if (sorted.length > 0) setAltTextPositions(sorted);
      })
      .catch(() => {});
  }, [productId, primaryLocale]);

  // Initialize localKeys when variants load
  useEffect(() => {
    if (variants.length === 0) return;
    setLocalKeys(prev => {
      const next = { ...prev };
      variants.forEach(v => {
        if (!(v.id in next)) {
          next[v.id] = (matchMode === "sku" ? v.sku : v.imageKey) ?? "";
        }
      });
      return next;
    });
  }, [variants]); // eslint-disable-line react-hooks/exhaustive-deps

  // Effective variants (local key edits overlaid on props) for matching
  const effectiveVariants = useMemo(() => variants.map(v => ({
    ...v,
    sku: matchMode === "sku" ? (localKeys[v.id] ?? v.sku) : v.sku,
    imageKey: matchMode === "imageKey" ? (localKeys[v.id] ?? v.imageKey) : v.imageKey,
  })), [variants, localKeys, matchMode]);

  const effectiveVariantsRef = useRef(effectiveVariants);
  const matchModeRef = useRef(matchMode);
  useEffect(() => { effectiveVariantsRef.current = effectiveVariants; }, [effectiveVariants]);
  useEffect(() => { matchModeRef.current = matchMode; }, [matchMode]);

  const handleMatchModeChange = useCallback((newMode: MatchMode) => {
    setMatchMode(newMode);
    const next: Record<string, string> = {};
    variants.forEach(v => { next[v.id] = (newMode === "sku" ? v.sku : v.imageKey) ?? ""; });
    setLocalKeys(next);
    onItemsChange(prev => prev.map(item =>
      item.assignmentMode !== "manual"
        ? autoAssign(item, variants.map(v => ({
            ...v,
            sku: newMode === "sku" ? (next[v.id] ?? v.sku) : v.sku,
            imageKey: newMode === "imageKey" ? (next[v.id] ?? v.imageKey) : v.imageKey,
          })), newMode)
        : item
    ));
  }, [variants, onItemsChange]);

  // Chip inline editing
  const handleChipClick = useCallback((variantId: string, optionIndex: number, currentDisplay: string) => {
    setEditingChip({ variantId, optionIndex });
    setEditingChipValue(optionOverrides[variantId]?.[optionIndex] ?? currentDisplay);
  }, [optionOverrides]);

  const handleChipEditCommit = useCallback(() => {
    if (!editingChip) return;
    const { variantId, optionIndex } = editingChip;
    setOptionOverrides(prev => ({
      ...prev,
      [variantId]: { ...(prev[variantId] ?? {}), [optionIndex]: editingChipValue },
    }));
    setEditingChip(null);
  }, [editingChip, editingChipValue]);

  // Generate key values for all variants and fill localKeys
  const handleGenerate = useCallback(() => {
    if (!baseName.trim() || variants.length === 0) return;
    const generated: Record<string, string> = {};
    variants.forEach(v => {
      generated[v.id] = buildVariantKey(baseName, v, labelMode, optionOverrides[v.id] ?? {}, memoryMap);
    });
    setLocalKeys(generated);
  }, [baseName, variants, labelMode, optionOverrides, memoryMap]);

  const handleSaveAll = useCallback(async () => {
    const updates = variants
      .map(v => ({ variantId: v.id, value: localKeys[v.id] ?? "" }))
      .filter(u => u.value.trim() !== "");
    if (updates.length === 0) return;

    // Collect memory entries by decomposing the actually-saved key back into per-option segments.
    // This is reliable regardless of how the key was set (generated, manually typed, or chip override).
    const seenOptionValues = new Set<string>();
    const memoryEntries: Array<{ optionValue: string; savedAs: string }> = [];
    variants.forEach(v => {
      const key = localKeys[v.id] ?? "";
      if (!key.trim()) return;
      const opts = v.selectedOptions.length > 0
        ? v.selectedOptions
        : v.title.split(" / ").map(val => ({ name: "", value: val, handle: null }));
      const segments = extractSegmentsFromKey(key, baseName, opts.length);
      if (!segments) return;
      opts.forEach((opt, i) => {
        if (!opt.value || seenOptionValues.has(opt.value) || !segments[i]) return;
        seenOptionValues.add(opt.value);
        memoryEntries.push({ optionValue: opt.value, savedAs: segments[i] });
      });
    });

    setSaveError(null);
    setIsSaving(true);
    try {
      const r = await fetch("/api/update-variant-match-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: matchMode, updates, memoryEntries }),
      });
      let body: { ok: boolean; errors?: string[] } = { ok: false };
      try { body = await r.json(); } catch { /* non-JSON response */ }

      if (r.ok && body.ok) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2500);
        if (memoryEntries.length > 0) {
          setMemoryMap(prev => {
            const next = { ...prev };
            memoryEntries.forEach(({ optionValue, savedAs }) => { next[optionValue] = savedAs; });
            return next;
          });
        }
        onItemsChange(prev => prev.map(item =>
          item.assignmentMode !== "manual"
            ? autoAssign(item, effectiveVariantsRef.current, matchModeRef.current)
            : item
        ));
      } else {
        const msg = body.errors?.join(" · ") || `Save failed (HTTP ${r.status})`;
        setSaveError(msg);
      }
    } catch (err: any) {
      setSaveError(`Network error: ${err?.message ?? "could not reach server"}`);
    } finally {
      setIsSaving(false);
    }
  }, [variants, localKeys, baseName, matchMode, labelMode, memoryMap, onItemsChange]);

  const handleDrop = useCallback(async (_dropFiles: File[], acceptedFiles: File[]) => {
    const validFiles = acceptedFiles.filter(f => ALLOWED_MIME.includes(f.type));
    if (validFiles.length === 0) return;

    const newItems: StagedItem[] = validFiles.map(file => ({
      uniqueId: crypto.randomUUID(),
      previewUrl: URL.createObjectURL(file),
      resourceUrl: "",
      fileName: file.name,
      mimeType: file.type,
      progress: 0,
      status: "uploading" as const,
      assignmentMode: "unassigned" as const,
    }));

    const assignedItems = newItems.map(item =>
      autoAssign(item, effectiveVariantsRef.current, matchModeRef.current)
    );
    onItemsChange(prev => [...prev, ...assignedItems]);

    await Promise.all(validFiles.map(async (file, i) => {
      const item = assignedItems[i];
      console.log("[BulkUpload] requesting staged URL", { filename: file.name, mimeType: file.type, fileSize: file.size });
      try {
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const stagedJson = await res.json();
        const { url, resourceUrl, error } = stagedJson;
        console.log("[BulkUpload] staged-upload response", { httpStatus: res.status, url, resourceUrl, error });
        if (error || !url) {
          console.error("[BulkUpload] staged-upload failed", { error, url });
          onItemsChange(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              onItemsChange(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, progress: pct } : it));
            }
          };
          xhr.onload = () => {
            console.log("[BulkUpload] XHR PUT completed", { filename: file.name, status: xhr.status, responseText: xhr.responseText.slice(0, 200) });
            if (xhr.status >= 200 && xhr.status < 300) {
              console.log("[BulkUpload] upload OK → resourceUrl", resourceUrl);
              onItemsChange(prev => prev.map(it =>
                it.uniqueId === item.uniqueId ? { ...it, status: "ready" as const, progress: 100, resourceUrl } : it
              ));
              resolve();
            } else {
              console.error("[BulkUpload] XHR PUT failed", { status: xhr.status, responseText: xhr.responseText.slice(0, 500) });
              onItemsChange(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
              reject(new Error(`Upload failed: HTTP ${xhr.status}`));
            }
          };
          xhr.onerror = () => {
            console.error("[BulkUpload] XHR network error", { filename: file.name });
            onItemsChange(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
            reject(new Error("Upload network error"));
          };
          console.log("[BulkUpload] XHR PUT →", url);
          xhr.open("PUT", url);
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.send(file);
        });
      } catch (err) {
        console.error("[BulkUpload] unexpected error", err);
        onItemsChange(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
      }
    }));
  }, [onItemsChange]);

  const selectedItems = items.filter(i => selectedUniqueIds.has(i.uniqueId));
  const hasSelected = selectedItems.length > 0;
  const hasReady = items.some(i => i.status === "ready");
  const assignedCount = items.filter(i => i.assignmentMode === "assigned").length;
  const unassignedCount = items.filter(i => i.assignmentMode === "unassigned" || !i.assignmentMode).length;

  const foreignProductNames = useMemo(() => {
    if (!productTitle) return [] as string[];
    const normalize = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, "");
    const currentNorm = normalize(productTitle);
    const seen = new Set<string>();
    for (const item of items) {
      const pn = item.parsedMeta?.productName;
      if (pn && !seen.has(pn)) {
        const pnNorm = normalize(pn);
        if (!currentNorm.includes(pnNorm) && !pnNorm.includes(currentNorm)) {
          seen.add(pn);
        }
      }
    }
    return [...seen];
  }, [items, productTitle]);
  const variantTitleMap = useMemo(() => Object.fromEntries(variants.map(v => [v.id, v.title])), [variants]);
  const handlesAvailable = useMemo(
    () => variants.some(v => v.selectedOptions.some(o => o.handle !== null)),
    [variants]
  );

  const sortedItems = useMemo(() => {
    if (sortMode === "custom") return [...items];
    const copy = [...items];
    if (sortMode === "identifier") {
      copy.sort((a, b) => (a.parsedMeta?.identifier ?? a.fileName).localeCompare(b.parsedMeta?.identifier ?? b.fileName, undefined, { numeric: true }));
    } else if (sortMode === "sku") {
      copy.sort((a, b) => ((a.parsedMeta?.productName ?? "") + (a.parsedMeta?.variants?.join("") ?? "")).localeCompare((b.parsedMeta?.productName ?? "") + (b.parsedMeta?.variants?.join("") ?? "")));
    } else {
      copy.sort((a, b) => a.fileName.localeCompare(b.fileName));
    }
    return copy;
  }, [items, sortMode]);

  const assignedByVariant = useMemo(() => {
    const map: Record<string, StagedItem[]> = {};
    for (const item of items) {
      if (item.targetVariantId) {
        if (!map[item.targetVariantId]) map[item.targetVariantId] = [];
        map[item.targetVariantId].push(item);
      }
    }
    return map;
  }, [items]);

  const handleReorder = useCallback((newOrder: StagedItem[]) => {
    setSortMode("custom");
    onItemsChange(() => newOrder);
  }, [onItemsChange]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Settings Card */}
      <Card>
        <BlockStack gap="300">
          {/* Match mode with help icon */}
          <BlockStack gap="100">
            <InlineStack gap="100" blockAlign="center">
              <Text as="span" variant="bodySm" fontWeight="semibold">{t.imageManager.bulkMatchModeLabel}</Text>
              <button
                className="help-tooltip-trigger"
                type="button"
                style={{ marginLeft: 2 }}
                aria-label={t.imageManager.bulkDocsTitle}
                onClick={() => setDocsOpen(o => !o)}
              >
                <Icon source={QuestionCircleIcon} tone="interactive" />
              </button>
            </InlineStack>
            <Select
              label={t.imageManager.bulkMatchModeLabel}
              labelHidden
              options={[
                { label: t.imageManager.bulkMatchModeSku, value: "sku" },
                { label: t.imageManager.bulkMatchModeImageKey, value: "imageKey" },
              ]}
              value={matchMode}
              onChange={v => handleMatchModeChange(v as MatchMode)}
            />
            <Collapsible open={docsOpen} id="bulk-docs" transition={{ duration: "200ms", timingFunction: "ease-in-out" }}>
              <Box paddingBlockStart="200">
                <Card background="bg-surface-secondary">
                  <Box padding="400">
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm" fontWeight="semibold">{t.imageManager.bulkDocsTitle}</Text>
                      <Text as="p" variant="bodySm">{t.imageManager.bulkDocsBody}</Text>
                      <Box padding="200" background="bg-surface" borderRadius="100">
                        <code style={{ fontFamily: "monospace", fontSize: 12 }}>
                          ProductName_Variant1_Variant2_..._Identifier.ext
                        </code>
                      </Box>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {matchMode === "sku" ? t.imageManager.bulkDocsExampleSku : t.imageManager.bulkDocsExampleImageKey}
                      </Text>
                      {matchMode === "imageKey" && (
                        <Text as="p" variant="bodySm" tone="subdued">{t.imageManager.bulkDocsImageKeyHint}</Text>
                      )}
                      <Text as="p" variant="bodySm" tone="critical">{t.imageManager.bulkDocsCaseSensitive}</Text>
                    </BlockStack>
                  </Box>
                </Card>
              </Box>
            </Collapsible>
          </BlockStack>

          <InlineStack gap="200" blockAlign="center">
            <div
              role="button"
              tabIndex={0}
              onClick={() => setGeneratorOpen(o => !o)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setGeneratorOpen(o => !o); }}
              style={{ cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <Text as="span" variant="bodySm" fontWeight="semibold">
                {matchMode === "sku" ? t.imageManager.bulkGeneratorTitleSku : t.imageManager.bulkGeneratorTitle}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">{generatorOpen ? "▲" : "▼"}</Text>
            </div>
            <button
              className="help-tooltip-trigger"
              type="button"
              style={{ marginLeft: 0 }}
              aria-label={t.imageManager.bulkGeneratorDocsTitle}
              onClick={() => {
                if (!generatorOpen) setGeneratorOpen(true);
                setGeneratorDocsOpen(o => !o);
              }}
            >
              <Icon source={QuestionCircleIcon} tone="interactive" />
            </button>
          </InlineStack>

          <Collapsible open={generatorOpen} id="bulk-generator" transition={{ duration: "150ms" }}>
            <BlockStack gap="300">
              {/* Generator documentation (hidden by default, toggled by ? button) */}
              <Collapsible open={generatorDocsOpen} id="bulk-generator-docs" transition={{ duration: "150ms" }}>
                <Card background="bg-surface-secondary">
                  <Box padding="300">
                    <BlockStack gap="200">
                      <Text as="h4" variant="bodySm" fontWeight="semibold">{t.imageManager.bulkGeneratorDocsTitle}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">{t.imageManager.bulkGeneratorDocsBody}</Text>
                      <Box padding="200" background="bg-surface" borderRadius="100">
                        <code style={{ fontFamily: "monospace", fontSize: 12 }}>{t.imageManager.bulkGeneratorDocsFormat}</code>
                      </Box>
                      <Text as="p" variant="bodySm" tone="subdued">{t.imageManager.bulkGeneratorDocsExample}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">{t.imageManager.bulkGeneratorDocsHandleNote}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">{t.imageManager.bulkGeneratorDocsOverrideNote}</Text>
                    </BlockStack>
                  </Box>
                </Card>
              </Collapsible>

              {/* Base name + label mode */}
              <InlineStack gap="200" blockAlign="end">
                <div style={{ flex: 1 }}>
                  <TextField
                    label={t.imageManager.bulkGeneratorBaseName}
                    value={baseName}
                    onChange={setBaseName}
                    placeholder={t.imageManager.bulkGeneratorBaseNamePlaceholder}
                    autoComplete="off"
                  />
                </div>
                <div style={{ minWidth: 150 }}>
                  <Select
                    label={t.imageManager.bulkLabelModeLabel}
                    options={[
                      { label: t.imageManager.bulkLabelModeName, value: "name" },
                      { label: t.imageManager.bulkLabelModeHandle, value: "handle" },
                      { label: t.imageManager.bulkLabelModeMemory, value: "memory" },
                    ]}
                    value={labelMode}
                    onChange={v => setLabelMode(v as LabelMode)}
                  />
                </div>
                <Button
                  onClick={handleGenerate}
                  disabled={!baseName.trim() || variants.length === 0}
                >
                  {t.imageManager.bulkGeneratorButton}
                </Button>
              </InlineStack>
              {labelMode === "handle" && !handlesAvailable && variants.length > 0 && (
                <Text as="p" variant="bodySm" tone="caution">
                  {t.imageManager.bulkNoHandlesInfo}
                </Text>
              )}

              {/* Per-variant rows */}
              {variants.length > 0 && (
                <BlockStack gap="200">
                  {variants.map(v => {
                    const opts = v.selectedOptions.length > 0
                      ? v.selectedOptions
                      : v.title.split(" / ").map(val => ({ name: "", value: val, handle: null }));
                    return (
                      <InlineStack key={v.id} gap="200" blockAlign="center">
                        {/* Option value chips */}
                        <div style={{ minWidth: 130, flexShrink: 0, display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center" }}>
                          {opts.map((opt, i) => {
                            const display = getOptionDisplay(opt, labelMode, optionOverrides[v.id]?.[i], memoryMap);
                            const isEditing = editingChip?.variantId === v.id && editingChip?.optionIndex === i;
                            const hasHandle = opt.handle !== null;
                            const hasOverride = optionOverrides[v.id]?.[i] !== undefined;
                            const hasMemory = !hasOverride && labelMode === "memory" && !!memoryMap[opt.value];
                            const chipColor = hasOverride ? "#005bd3"
                              : hasMemory ? "#7c3aed"
                              : (hasHandle && labelMode === "handle") ? "#008060"
                              : "#202223";
                            const chipBorder = hasOverride ? "2px solid #005bd3"
                              : hasMemory ? "1px solid #7c3aed"
                              : "1px dashed #8c9196";
                            return (
                              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                                {i > 0 && <span style={{ color: "#8c9196", fontSize: 11 }}>/</span>}
                                {isEditing ? (
                                  <input
                                    autoFocus
                                    value={editingChipValue}
                                    onChange={e => setEditingChipValue(e.target.value)}
                                    onBlur={handleChipEditCommit}
                                    onKeyDown={e => { if (e.key === "Enter") handleChipEditCommit(); if (e.key === "Escape") setEditingChip(null); }}
                                    style={{
                                      width: Math.max(40, editingChipValue.length * 8),
                                      fontSize: 12,
                                      border: "1px solid #005bd3",
                                      borderRadius: 3,
                                      padding: "1px 4px",
                                      outline: "none",
                                    }}
                                  />
                                ) : (
                                  <span
                                    title={t.imageManager.bulkOverrideTooltip}
                                    onClick={() => handleChipClick(v.id, i, display)}
                                    style={{
                                      fontSize: 12,
                                      cursor: "pointer",
                                      borderBottom: chipBorder,
                                      color: chipColor,
                                      padding: "0 1px",
                                    }}
                                  >
                                    {display}
                                  </span>
                                )}
                              </span>
                            );
                          })}
                        </div>

                        {/* Key input */}
                        <div style={{ flex: 1 }}>
                          <TextField
                            label=""
                            labelHidden
                            value={localKeys[v.id] ?? ""}
                            onChange={val => setLocalKeys(prev => ({ ...prev, [v.id]: val }))}
                            placeholder={t.imageManager.bulkGeneratorVariantKey}
                            autoComplete="off"
                          />
                        </div>
                      </InlineStack>
                    );
                  })}

                  <BlockStack gap="100">
                    {saveError && (
                      <Text as="p" variant="bodySm" tone="critical">{saveError}</Text>
                    )}
                    <InlineStack align="end" gap="300" blockAlign="center">
                      {saveSuccess && (
                        <Text as="span" variant="bodySm" tone="success">{t.imageManager.bulkGeneratorSuccess}</Text>
                      )}
                      <Button variant="primary" size="slim" onClick={handleSaveAll} loading={isSaving} disabled={isSaving}>
                        {t.imageManager.bulkGeneratorSaveAll}
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              )}
            </BlockStack>
          </Collapsible>
        </BlockStack>
      </Card>

      {/* Drop Zone */}
      <DropZone onDrop={handleDrop} accept={ALLOWED_MIME.join(",")} allowMultiple>
        <DropZone.FileUpload actionTitle={t.imageManager.uploadTitle} actionHint="JPG, PNG, GIF, WebP, SVG" />
      </DropZone>

      {items.length > 0 && (
        <>
          {variants.length > 0 && (
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="success">{t.imageManager.bulkAssigned.replace("{count}", String(assignedCount))}</Badge>
              {unassignedCount > 0 && (
                <Badge tone="attention">{t.imageManager.bulkUnassigned.replace("{count}", String(unassignedCount))}</Badge>
              )}
            </InlineStack>
          )}

          <InlineStack gap="200" blockAlign="center">
            <Select
              label={t.imageManager.bulkSortLabel}
              labelInline
              options={[
                { label: t.imageManager.bulkSortIdentifier, value: "identifier" },
                { label: t.imageManager.bulkSortSku, value: "sku" },
                { label: t.imageManager.bulkSortFilename, value: "filename" },
                ...(sortMode === "custom" ? [{ label: t.imageManager.bulkSortCustom ?? "Custom", value: "custom" }] : []),
              ]}
              value={sortMode}
              onChange={v => setSortMode(v as SortMode)}
            />
            <Button size="slim" variant={sortListOpen ? "primary" : "secondary"} onClick={() => setSortListOpen(o => !o)}>
              {sortListOpen ? t.imageManager.bulkSortListOpen : t.imageManager.bulkSortListClose}
            </Button>
          </InlineStack>

          {sortListOpen && (
            <BulkSortableList items={sortedItems} variantTitles={variantTitleMap} onReorder={handleReorder} onRemove={onRemove} />
          )}

          {!sortListOpen && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {sortedItems.map(item => {
                const variantTitle = item.targetVariantId ? variantTitleMap[item.targetVariantId] : null;
                return (
                  <div
                    key={item.uniqueId}
                    style={{ position: "relative", width: 72, cursor: "pointer", borderRadius: 6, outline: selectedUniqueIds.has(item.uniqueId) ? "2px solid #005bd3" : "2px solid transparent" }}
                    onClick={() => onSelect(item.uniqueId, !selectedUniqueIds.has(item.uniqueId))}
                    title={variantTitle ? `→ ${variantTitle}` : item.fileName}
                  >
                    <img src={item.previewUrl} alt={item.fileName} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6, display: "block" }} />
                    {item.status === "uploading" && (
                      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
                        <div style={{ height: 4, background: "#e1e3e5", borderRadius: "0 0 6px 6px", overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${item.progress}%`, background: "#005bd3", transition: "width 0.3s" }} />
                        </div>
                      </div>
                    )}
                    {item.status === "error" && (
                      <div style={{ position: "absolute", inset: 0, background: "rgba(212,44,37,0.3)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6 }}>
                        <Text as="span" tone="critical" variant="bodyLg">!</Text>
                      </div>
                    )}
                    {item.assignmentMode && (
                      <div style={{ position: "absolute", top: 0, left: 0, right: 0, background: item.assignmentMode === "assigned" ? "rgba(0,128,96,0.85)" : "rgba(142,31,11,0.75)", color: "white", fontSize: 9, fontWeight: 700, padding: "2px 4px", borderRadius: "6px 6px 0 0", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", lineHeight: "14px" }}>
                        {item.assignmentMode === "assigned" && variantTitle ? variantTitle : item.assignmentMode === "assigned" ? "✓" : "?"}
                      </div>
                    )}
                    {selectedUniqueIds.has(item.uniqueId) && (
                      <div style={{ position: "absolute", top: 18, right: 3, width: 18, height: 18, borderRadius: "50%", background: "#005bd3", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ color: "white", fontSize: 11, lineHeight: 1 }}>✓</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {Object.keys(assignedByVariant).length > 0 && !sortListOpen && (
            <>
              <Divider />
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">{t.imageManager.bulkPreviewTitle}</Text>
                {Object.entries(assignedByVariant).map(([variantId, variantItems]) => (
                  <Card key={variantId} padding="300">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" fontWeight="semibold">{variantTitleMap[variantId] ?? variantId}</Text>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {variantItems.map(item => (
                          <img key={item.uniqueId} src={item.previewUrl} alt={item.parsedMeta?.identifier ?? item.fileName} style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, border: "1px solid #e1e3e5" }} title={`ID: ${item.parsedMeta?.identifier ?? item.fileName}`} />
                        ))}
                      </div>
                    </BlockStack>
                  </Card>
                ))}
                {unassignedCount > 0 && (
                  <Card padding="300">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" fontWeight="semibold" tone="caution">
                        {t.imageManager.bulkPreviewUnassigned.replace("{count}", String(unassignedCount))}
                      </Text>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {items.filter(i => i.assignmentMode === "unassigned" || !i.assignmentMode).map(item => (
                          <img key={item.uniqueId} src={item.previewUrl} alt={item.fileName} style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, border: "2px solid #ffc453" }} title={item.fileName} />
                        ))}
                      </div>
                    </BlockStack>
                  </Card>
                )}
                {foreignProductNames.length > 0 && (
                  <div style={{ padding: "8px 12px", background: "#fff3cd", borderRadius: 6, border: "1px solid #ffc453" }}>
                    <Text as="p" variant="bodySm" tone="caution">
                      {(t.imageManager.bulkForeignProductWarning ?? "Warning: These images may belong to a different product ({names}).").replace("{names}", foreignProductNames.join(", "))}
                    </Text>
                  </div>
                )}
              </BlockStack>
            </>
          )}

          {/* Alt Text Template block (collapsible) */}
          {productId && (
            <>
              <Divider />
              <div style={{ padding: "0 4px" }}>
                <button
                  style={{ background: "none", border: "none", cursor: "pointer", padding: "4px 0", display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "#303030" }}
                  onClick={() => setAltTextOpen(o => !o)}
                >
                  <span style={{ fontSize: 11, color: "#616161" }}>{altTextOpen ? "▼" : "▶"}</span>
                  {t.imageManager?.altTextTemplates ?? "Alt Text Templates"}
                </button>
                <Collapsible id="alt-text-block" open={altTextOpen} transition={{ duration: "150ms", timingFunction: "ease" }}>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t.imageManager?.altTextTemplateVariableHint ?? "Available variables"}:{" "}
                      {Array.from(new Set(variants.flatMap(v => v.selectedOptions.map(o => o.name)))).map(n => `{${n}}`).join(", ")}
                    </Text>
                    {altTextPositions.map((pos, idx) => (
                      <BlockStack key={pos.position} gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <TextField
                            label={(t.imageManager?.altTextTemplatePosition ?? "Position {n}").replace("{n}", String(idx + 1))}
                            value={pos.template}
                            placeholder={t.imageManager?.altTextTemplatePlaceholder ?? "e.g. Elegant {Color} vase"}
                            onChange={v => {
                              setAltTextPositions(prev => prev.map((p, i) => i === idx ? { ...p, template: v } : p));
                            }}
                            onBlur={() => {
                              if (!productId || !primaryLocale) return;
                              fetch("/api/alt-text-templates", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ productId, position: pos.position, positionLabel: pos.label, locale: primaryLocale, template: pos.template }),
                              }).catch(() => {});
                            }}
                            autoComplete="off"
                          />
                          {altTextPositions.length > 1 && (
                            <Button
                              size="slim"
                              tone="critical"
                              variant="plain"
                              onClick={async () => {
                                if (productId) {
                                  await fetch(`/api/alt-text-templates?productId=${encodeURIComponent(productId)}&position=${pos.position}`, { method: "DELETE" }).catch(() => {});
                                }
                                setAltTextPositions(prev => prev.filter((_, i) => i !== idx));
                              }}
                            >✕</Button>
                          )}
                        </InlineStack>
                      </BlockStack>
                    ))}
                    <Button
                      size="slim"
                      variant="plain"
                      onClick={() => {
                        const maxPos = altTextPositions.length > 0 ? Math.max(...altTextPositions.map(p => p.position)) : -1;
                        setAltTextPositions(prev => [...prev, { position: maxPos + 1, label: "", template: "" }]);
                      }}
                    >
                      + {t.imageManager?.altTextTemplateAddPosition ?? "Add position"}
                    </Button>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={applyOnUpload}
                        onChange={e => setApplyOnUpload(e.target.checked)}
                      />
                      {t.imageManager?.altTextTemplateApplyOnUpload ?? "Apply after upload"}
                    </label>
                  </BlockStack>
                </Collapsible>
              </div>
            </>
          )}

          {/* Sticky action bar */}
          <div style={{ position: "sticky", bottom: 0, zIndex: 2, background: "var(--p-color-bg-surface)", borderTop: "1px solid var(--p-color-border)", borderRadius: "0 0 var(--p-border-radius-300) var(--p-border-radius-300)", padding: "10px 12px" }}>
            <BlockStack gap="100">
              {confirmError && (
                <Text as="p" variant="bodySm" tone="critical">
                  {(t.imageManager.bulkApplyError ?? "Error saving: {error}").replace("{error}", confirmError)}
                </Text>
              )}
              <InlineStack gap="200">
                <Button size="slim" tone="critical" onClick={() => onRemove([...selectedUniqueIds])} disabled={!hasSelected}>{t.imageManager.remove.replace(" ({count})", "")}</Button>
                {onConfirm && (
                  <Button
                    size="slim"
                    variant="primary"
                    disabled={!hasReady || isConfirming}
                    loading={isConfirming}
                    onClick={async () => {
                      setConfirmError(null);
                      const err = await onConfirm();
                      if (err) {
                        setConfirmError(err);
                        return;
                      }
                      // Apply alt text templates after successful upload if checkbox is active
                      if (applyOnUpload && productId && primaryLocale && variants.length > 0) {
                        try {
                          // Re-fetch fresh variant data so newly uploaded images are included
                          const varRes = await fetch(`/api/product-variants?productId=${encodeURIComponent(productId)}`);
                          const varData = await varRes.json();
                          const freshVariants = varData.variants ?? variants;
                          await fetch("/api/apply-alt-text-templates", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              productId,
                              locale: primaryLocale,
                              primaryLocale,
                              scope: "all",
                              variants: freshVariants,
                            }),
                          });
                        } catch {}
                      }
                    }}
                  >
                    {t.imageManager.bulkApplyButton ?? "Save images now"}
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </div>
        </>
      )}
    </div>
  );
}
