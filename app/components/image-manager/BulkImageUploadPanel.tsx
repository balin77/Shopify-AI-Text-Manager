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

type SortMode = "identifier" | "sku" | "filename";
type MatchMode = "sku" | "imageKey";
type LabelMode = "name" | "handle";

/** Return the chip display text for one option value (before key generation). */
function getOptionDisplay(opt: VariantSelectedOption, labelMode: LabelMode, override?: string): string {
  if (override !== undefined) return override;
  if (labelMode === "handle" && opt.handle) return opt.handle;
  return opt.value;
}

/** Return the key-segment for one option value (space-removal applied for non-overrides). */
function getOptionKeySegment(opt: VariantSelectedOption, labelMode: LabelMode, override?: string): string {
  if (override !== undefined) return override.replace(/\s+/g, "");
  if (labelMode === "handle" && opt.handle) return opt.handle;
  return opt.value.replace(/\s+/g, "");
}

/** Build the full key for a variant given the current state. */
function buildVariantKey(
  baseName: string,
  variant: VariantWithGallery,
  labelMode: LabelMode,
  overrides: Record<number, string>,
): string {
  const opts = variant.selectedOptions.length > 0
    ? variant.selectedOptions
    : variant.title.split(" / ").map(v => ({ name: "", value: v, handle: null }));
  const parts = opts.map((opt, i) => getOptionKeySegment(opt, labelMode, overrides[i]));
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

interface BulkImageUploadPanelProps {
  items: StagedItem[];
  selectedUniqueIds: Set<string>;
  activeAction: "copy" | "move" | null;
  variants?: VariantWithGallery[];
  onItemsChange: (updater: (prev: StagedItem[]) => StagedItem[]) => void;
  onSelect: (uniqueId: string, selected: boolean) => void;
  onSetAction: (action: "copy" | "move" | null) => void;
  onRemove: (uniqueIds: string[]) => void;
}

export function BulkImageUploadPanel({
  items,
  selectedUniqueIds,
  activeAction,
  variants = [],
  onItemsChange,
  onSelect,
  onSetAction,
  onRemove,
}: BulkImageUploadPanelProps) {
  const { t } = useI18n();
  const [docsOpen, setDocsOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generatorDocsOpen, setGeneratorDocsOpen] = useState(false);
  const [sortListOpen, setSortListOpen] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("identifier");

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
      generated[v.id] = buildVariantKey(baseName, v, labelMode, optionOverrides[v.id] ?? {});
    });
    setLocalKeys(generated);
  }, [baseName, variants, labelMode, optionOverrides]);

  const handleSaveAll = useCallback(async () => {
    const updates = variants
      .map(v => ({ variantId: v.id, value: localKeys[v.id] ?? "" }))
      .filter(u => u.value.trim() !== "");
    if (updates.length === 0) return;

    setIsSaving(true);
    try {
      const r = await fetch("/api/update-variant-match-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: matchMode, updates }),
      });
      if (r.ok) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2500);
        onItemsChange(prev => prev.map(item =>
          item.assignmentMode !== "manual"
            ? autoAssign(item, effectiveVariantsRef.current, matchModeRef.current)
            : item
        ));
      }
    } finally {
      setIsSaving(false);
    }
  }, [variants, localKeys, matchMode, onItemsChange]);

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
      try {
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const { url, resourceUrl, error } = await res.json();
        if (error || !url) {
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
            onItemsChange(prev => prev.map(it =>
              it.uniqueId === item.uniqueId ? { ...it, status: "ready" as const, progress: 100, resourceUrl } : it
            ));
            resolve();
          };
          xhr.onerror = () => {
            onItemsChange(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
            reject();
          };
          xhr.open("PUT", url);
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.send(file);
        });
      } catch {
        onItemsChange(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
      }
    }));
  }, [onItemsChange]);

  const selectedItems = items.filter(i => selectedUniqueIds.has(i.uniqueId));
  const hasSelected = selectedItems.length > 0;
  const assignedCount = items.filter(i => i.assignmentMode === "assigned").length;
  const unassignedCount = items.filter(i => i.assignmentMode === "unassigned" || !i.assignmentMode).length;
  const variantTitleMap = useMemo(() => Object.fromEntries(variants.map(v => [v.id, v.title])), [variants]);
  const handlesAvailable = useMemo(
    () => variants.some(v => v.selectedOptions.some(o => o.handle !== null)),
    [variants]
  );

  const sortedItems = useMemo(() => {
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

  const handleReorder = useCallback((newOrder: StagedItem[]) => { onItemsChange(() => newOrder); }, [onItemsChange]);
  const handleRemoveSingle = useCallback((uniqueId: string) => { onRemove([uniqueId]); }, [onRemove]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Documentation (collapsible) */}
      <div>
        <Button icon={QuestionCircleIcon} variant="plain" onClick={() => setDocsOpen(o => !o)} ariaExpanded={docsOpen} ariaControls="bulk-docs">
          {docsOpen ? t.imageManager.bulkDocsToggleHide : t.imageManager.bulkDocsToggleShow}
        </Button>
        <Collapsible open={docsOpen} id="bulk-docs" transition={{ duration: "200ms", timingFunction: "ease-in-out" }}>
          <Box paddingBlockStart="300">
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
      </div>

      {/* Settings Card */}
      <Card>
        <BlockStack gap="300">
          {/* Always visible: match mode + generator toggle */}
          <Select
            label={t.imageManager.bulkMatchModeLabel}
            options={[
              { label: t.imageManager.bulkMatchModeSku, value: "sku" },
              { label: t.imageManager.bulkMatchModeImageKey, value: "imageKey" },
            ]}
            value={matchMode}
            onChange={v => handleMatchModeChange(v as MatchMode)}
          />

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
                            const display = getOptionDisplay(opt, labelMode, optionOverrides[v.id]?.[i]);
                            const isEditing = editingChip?.variantId === v.id && editingChip?.optionIndex === i;
                            const hasHandle = opt.handle !== null;
                            const hasOverride = optionOverrides[v.id]?.[i] !== undefined;
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
                                      borderBottom: hasOverride ? "2px solid #005bd3" : "1px dashed #8c9196",
                                      color: hasOverride ? "#005bd3" : (hasHandle && labelMode === "handle" ? "#008060" : "#202223"),
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

                  <InlineStack align="end" gap="300" blockAlign="center">
                    {saveSuccess && (
                      <Text as="span" variant="bodySm" tone="success">{t.imageManager.bulkGeneratorSuccess}</Text>
                    )}
                    <Button variant="primary" size="slim" onClick={handleSaveAll} loading={isSaving} disabled={isSaving}>
                      {t.imageManager.bulkGeneratorSaveAll}
                    </Button>
                  </InlineStack>
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
              ]}
              value={sortMode}
              onChange={v => setSortMode(v as SortMode)}
            />
            <Button size="slim" variant={sortListOpen ? "primary" : "secondary"} onClick={() => setSortListOpen(o => !o)}>
              {sortListOpen ? t.imageManager.bulkSortListOpen : t.imageManager.bulkSortListClose}
            </Button>
          </InlineStack>

          {sortListOpen && (
            <BulkSortableList items={sortedItems} variantTitles={variantTitleMap} onReorder={handleReorder} onRemove={handleRemoveSingle} />
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
              </BlockStack>
            </>
          )}

          <InlineStack gap="200">
            <Button size="slim" pressed={activeAction === "copy"} onClick={() => onSetAction(activeAction === "copy" ? null : "copy")} disabled={!hasSelected}>{t.imageManager.copy}</Button>
            <Button size="slim" pressed={activeAction === "move"} onClick={() => onSetAction(activeAction === "move" ? null : "move")} disabled={!hasSelected}>{t.imageManager.move}</Button>
            <Button size="slim" tone="critical" onClick={() => onRemove([...selectedUniqueIds])} disabled={!hasSelected}>{t.imageManager.remove.replace(" ({count})", "")}</Button>
          </InlineStack>
        </>
      )}
    </div>
  );
}
