import { useCallback, useState, useMemo } from "react";
import {
  DropZone,
  Text,
  Button,
  InlineStack,
  BlockStack,
  Badge,
  Collapsible,
  Card,
  Box,
  Divider,
  Select,
} from "@shopify/polaris";
import { InfoIcon } from "@shopify/polaris-icons";
import { useI18n } from "../../contexts/I18nContext";
import { parseFilename, parseSku } from "../../utils/parseFilenames";
import { BulkSortableList } from "./BulkSortableList";
import type { StagedItem, VariantWithGallery } from "./types";

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];

type SortMode = "identifier" | "sku" | "filename";

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

/** Match a StagedItem against all variants by SKU and set targetVariantId + parsedMeta. */
function autoAssign(item: StagedItem, variants: VariantWithGallery[]): StagedItem {
  let meta: ReturnType<typeof parseFilename> | null = null;
  try {
    meta = parseFilename(item.fileName);
  } catch {
    return { ...item, assignmentMode: "unassigned" };
  }

  const match = variants.find(v => {
    if (!v.sku) return false;
    try {
      const skuData = parseSku(v.sku);
      return (
        skuData.productName === meta!.productName &&
        skuData.variants.length === meta!.variants.length &&
        skuData.variants.every((part, i) => part === meta!.variants[i])
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
  const [sortListOpen, setSortListOpen] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("identifier");

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

    // Auto-assign immediately so UI shows badges right away
    const assignedItems = newItems.map(item => autoAssign(item, variants));

    onItemsChange(prev => [...prev, ...assignedItems]);

    await Promise.all(validFiles.map(async (file, i) => {
      const item = assignedItems[i];
      try {
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type,
            fileSize: file.size,
          }),
        });
        const { url, resourceUrl, error } = await res.json();

        if (error || !url) {
          onItemsChange(prev => prev.map(it =>
            it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it
          ));
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              onItemsChange(prev => prev.map(it =>
                it.uniqueId === item.uniqueId ? { ...it, progress: pct } : it
              ));
            }
          };
          xhr.onload = () => {
            onItemsChange(prev => prev.map(it =>
              it.uniqueId === item.uniqueId
                ? { ...it, status: "ready" as const, progress: 100, resourceUrl }
                : it
            ));
            resolve();
          };
          xhr.onerror = () => {
            onItemsChange(prev => prev.map(it =>
              it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it
            ));
            reject();
          };
          xhr.open("PUT", url);
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.send(file);
        });
      } catch {
        onItemsChange(prev => prev.map(it =>
          it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it
        ));
      }
    }));
  }, [onItemsChange, variants]);

  const selectedItems = items.filter(i => selectedUniqueIds.has(i.uniqueId));
  const hasSelected = selectedItems.length > 0;

  const assignedCount = items.filter(i => i.assignmentMode === "assigned").length;
  const unassignedCount = items.filter(i => i.assignmentMode === "unassigned" || !i.assignmentMode).length;

  // Build variant title lookup map
  const variantTitleMap = useMemo(
    () => Object.fromEntries(variants.map(v => [v.id, v.title])),
    [variants]
  );

  // Sort items based on selected mode
  const sortedItems = useMemo(() => {
    const copy = [...items];
    if (sortMode === "identifier") {
      copy.sort((a, b) => {
        const ia = a.parsedMeta?.identifier ?? a.fileName ?? "";
        const ib = b.parsedMeta?.identifier ?? b.fileName ?? "";
        return ia.localeCompare(ib, undefined, { numeric: true });
      });
    } else if (sortMode === "sku") {
      copy.sort((a, b) => {
        const sa = (a.parsedMeta?.productName ?? "") + (a.parsedMeta?.variants?.join("") ?? "");
        const sb = (b.parsedMeta?.productName ?? "") + (b.parsedMeta?.variants?.join("") ?? "");
        return sa.localeCompare(sb);
      });
    } else {
      copy.sort((a, b) => a.fileName.localeCompare(b.fileName));
    }
    return copy;
  }, [items, sortMode]);

  // Preview: group assigned items by variant
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

  const hasVariantAssignments = Object.keys(assignedByVariant).length > 0;

  const handleReorder = useCallback((newOrder: StagedItem[]) => {
    onItemsChange(() => newOrder);
  }, [onItemsChange]);

  const handleRemoveSingle = useCallback((uniqueId: string) => {
    onRemove([uniqueId]);
  }, [onRemove]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Documentation Section */}
      <div>
        <Button
          icon={InfoIcon}
          variant="plain"
          onClick={() => setDocsOpen(o => !o)}
          ariaExpanded={docsOpen}
          ariaControls="bulk-docs"
        >
          {docsOpen ? "Dokumentation ausblenden" : "Automatische Zuordnung – Hilfe"}
        </Button>
        <Collapsible open={docsOpen} id="bulk-docs" transition={{ duration: "200ms", timingFunction: "ease-in-out" }}>
          <Box paddingBlockStart="300">
            <Card background="bg-surface-secondary">
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm" fontWeight="semibold">
                    Automatische Varianten-Zuordnung
                  </Text>
                  <Text as="p" variant="bodySm">
                    Bilder werden automatisch der richtigen Variante zugeordnet, wenn der Dateiname folgendem Format entspricht:
                  </Text>
                  <Box padding="200" background="bg-surface" borderRadius="100">
                    <code style={{ fontFamily: "monospace", fontSize: 12 }}>
                      Produktname_Variante1_Variante2_..._Identifier.ext
                    </code>
                  </Box>
                  <Text as="p" variant="bodySm" tone="subdued">
                    <strong>Beispiel:</strong> <code>Tshirt_Blue_M_001.jpg</code>
                    <br />
                    Produktname: <code>Tshirt</code> | Varianten: <code>Blue</code>, <code>M</code> | Identifier: <code>001</code>
                    <br />
                    Passende SKU: <code>Tshirt_Blue_M</code>
                  </Text>
                  <Text as="p" variant="bodySm" tone="critical">
                    Gross-/Kleinschreibung und Reihenfolge der Varianten müssen exakt mit der SKU übereinstimmen.
                  </Text>
                </BlockStack>
              </Box>
            </Card>
          </Box>
        </Collapsible>
      </div>

      {/* Drop Zone */}
      <DropZone onDrop={handleDrop} accept={ALLOWED_MIME.join(",")} allowMultiple>
        <DropZone.FileUpload actionTitle={t.imageManager.uploadTitle} actionHint="JPG, PNG, GIF, WebP, SVG" />
      </DropZone>

      {items.length > 0 && (
        <>
          {/* Assignment summary */}
          {variants.length > 0 && (
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="success">{`${assignedCount} zugewiesen`}</Badge>
              {unassignedCount > 0 && (
                <Badge tone="attention">{`${unassignedCount} nicht zugewiesen`}</Badge>
              )}
            </InlineStack>
          )}

          {/* Sort controls */}
          <InlineStack gap="200" blockAlign="center">
            <Select
              label="Sortierung"
              labelInline
              options={[
                { label: "Nach Identifier", value: "identifier" },
                { label: "Nach SKU", value: "sku" },
                { label: "Nach Dateiname", value: "filename" },
              ]}
              value={sortMode}
              onChange={v => setSortMode(v as SortMode)}
            />
            <Button
              size="slim"
              variant={sortListOpen ? "primary" : "secondary"}
              onClick={() => setSortListOpen(o => !o)}
            >
              {sortListOpen ? "Listenansicht schließen" : "Reihenfolge anpassen"}
            </Button>
          </InlineStack>

          {/* Sortable list view */}
          {sortListOpen && (
            <BulkSortableList
              items={sortedItems}
              variantTitles={variantTitleMap}
              onReorder={handleReorder}
              onRemove={handleRemoveSingle}
            />
          )}

          {/* Thumbnail grid */}
          {!sortListOpen && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {sortedItems.map(item => {
                const variantTitle = item.targetVariantId ? variantTitleMap[item.targetVariantId] : null;
                return (
                  <div
                    key={item.uniqueId}
                    style={{
                      position: "relative",
                      width: 72,
                      cursor: "pointer",
                      borderRadius: 6,
                      outline: selectedUniqueIds.has(item.uniqueId) ? "2px solid #005bd3" : "2px solid transparent",
                    }}
                    onClick={() => onSelect(item.uniqueId, !selectedUniqueIds.has(item.uniqueId))}
                    title={variantTitle ? `→ ${variantTitle}` : item.fileName}
                  >
                    <img
                      src={item.previewUrl}
                      alt={item.fileName}
                      style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6, display: "block" }}
                    />

                    {/* Progress bar */}
                    {item.status === "uploading" && (
                      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
                        <div style={{ height: 4, background: "#e1e3e5", borderRadius: "0 0 6px 6px", overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${item.progress}%`, background: "#005bd3", transition: "width 0.3s" }} />
                        </div>
                      </div>
                    )}

                    {/* Error overlay */}
                    {item.status === "error" && (
                      <div style={{
                        position: "absolute", inset: 0, background: "rgba(212,44,37,0.3)",
                        display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6,
                      }}>
                        <Text as="span" tone="critical" variant="bodyLg">!</Text>
                      </div>
                    )}

                    {/* Assignment badge */}
                    {item.assignmentMode && (
                      <div style={{
                        position: "absolute", top: 0, left: 0, right: 0,
                        background: item.assignmentMode === "assigned" ? "rgba(0,128,96,0.85)" : "rgba(142,31,11,0.75)",
                        color: "white", fontSize: 9, fontWeight: 700,
                        padding: "2px 4px", borderRadius: "6px 6px 0 0",
                        textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap",
                        lineHeight: "14px",
                      }}>
                        {item.assignmentMode === "assigned" && variantTitle ? variantTitle : item.assignmentMode === "assigned" ? "✓" : "?"}
                      </div>
                    )}

                    {/* Selection checkmark */}
                    {selectedUniqueIds.has(item.uniqueId) && (
                      <div style={{
                        position: "absolute", top: 18, right: 3, width: 18, height: 18,
                        borderRadius: "50%", background: "#005bd3",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <span style={{ color: "white", fontSize: 11, lineHeight: 1 }}>✓</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Variant assignment preview */}
          {hasVariantAssignments && !sortListOpen && (
            <>
              <Divider />
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  Vorschau: Zuordnung zu Varianten
                </Text>
                {Object.entries(assignedByVariant).map(([variantId, variantItems]) => (
                  <Card key={variantId} padding="300">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        {variantTitleMap[variantId] ?? variantId}
                      </Text>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {variantItems.map(item => (
                          <div key={item.uniqueId} style={{ position: "relative" }}>
                            <img
                              src={item.previewUrl}
                              alt={item.parsedMeta?.identifier ?? item.fileName}
                              style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, border: "1px solid #e1e3e5" }}
                              title={`ID: ${item.parsedMeta?.identifier ?? item.fileName}`}
                            />
                          </div>
                        ))}
                      </div>
                    </BlockStack>
                  </Card>
                ))}
                {unassignedCount > 0 && (
                  <Card padding="300">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" fontWeight="semibold" tone="caution">
                        Nicht zugewiesen ({unassignedCount})
                      </Text>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {items.filter(i => i.assignmentMode === "unassigned" || !i.assignmentMode).map(item => (
                          <img
                            key={item.uniqueId}
                            src={item.previewUrl}
                            alt={item.fileName}
                            style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, border: "2px solid #ffc453" }}
                            title={item.fileName}
                          />
                        ))}
                      </div>
                    </BlockStack>
                  </Card>
                )}
              </BlockStack>
            </>
          )}

          {/* Actions */}
          <InlineStack gap="200">
            <Button
              size="slim"
              pressed={activeAction === "copy"}
              onClick={() => onSetAction(activeAction === "copy" ? null : "copy")}
              disabled={!hasSelected}
            >
              {t.imageManager.copy}
            </Button>
            <Button
              size="slim"
              pressed={activeAction === "move"}
              onClick={() => onSetAction(activeAction === "move" ? null : "move")}
              disabled={!hasSelected}
            >
              {t.imageManager.move}
            </Button>
            <Button
              size="slim"
              tone="critical"
              onClick={() => onRemove([...selectedUniqueIds])}
              disabled={!hasSelected}
            >
              {t.imageManager.remove.replace(" ({count})", "")}
            </Button>
          </InlineStack>
        </>
      )}
    </div>
  );
}
