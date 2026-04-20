import { useState, useRef } from "react";
import { Text, Button, InlineStack, Collapsible, Badge } from "@shopify/polaris";
import { useI18n } from "../../contexts/I18nContext";
import { SortableImageGrid } from "./SortableImageGrid";
import type { VariantWithGallery, ImageMeta } from "./types";

interface VariantGallerySectionProps {
  variant: VariantWithGallery;
  fileUrlMap: Record<string, string>;
  imageMetas?: Record<string, ImageMeta>;
  activeAction: "copy" | "move" | null;
  selectedUrls: Set<string>;
  onSelect: (url: string, selected: boolean) => void;
  onReorder: (variantId: string, newGids: string[]) => void;
  onDrop: (targetVariantId: string, prepend?: boolean) => void;
  onRemoveFromGallery: (variantId: string, urls: string[]) => void;
  onGenerateAltFromSku: (variantId: string) => void;
  onUploadToGallery: (variantId: string, files: File[]) => void;
  thumbSize?: number;
  localAltTexts?: Record<string, string>;
  isAltTextLoading?: boolean;
  onAltTextChange?: (url: string, value: string) => void;
  onSaveAltText?: (url: string, altText: string) => void;
  onGenerateAltText?: (url: string) => void;
  onTranslateAltText?: (url: string, sourceAltText: string) => void;
  currentLanguage?: string;
  primaryLocale?: string;
}

export function VariantGallerySection({
  variant,
  fileUrlMap,
  imageMetas = {},
  activeAction,
  selectedUrls,
  onSelect,
  onReorder,
  onDrop,
  onRemoveFromGallery,
  onGenerateAltFromSku,
  onUploadToGallery,
  thumbSize = 80,
  localAltTexts,
  isAltTextLoading,
  onAltTextChange,
  onSaveAltText,
  onGenerateAltText,
  onTranslateAltText,
  currentLanguage,
  primaryLocale,
}: VariantGallerySectionProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const skipNextBlurRef = useRef(false);

  const urls = variant.galleryFileGids
    .map(gid => fileUrlMap[gid])
    .filter(Boolean) as string[];

  const displayUrls = urls.length > 0 ? urls : variant.galleryFileGids
    .filter(gid => gid.startsWith("http"))
    .slice(0, 10);

  const urlToGid = Object.fromEntries(
    Object.entries(fileUrlMap).map(([gid, url]) => [url, gid])
  );

  const localSelectedUrls = displayUrls.filter(url => selectedUrls.has(url));
  const hasLocalSelection = localSelectedUrls.length > 0;
  const isAllSelected = displayUrls.length > 0 && displayUrls.every(url => selectedUrls.has(url));
  const isPrimaryLocale = !currentLanguage || currentLanguage === primaryLocale;

  const singleSelectedUrl = localSelectedUrls.length === 1 ? localSelectedUrls[0] : null;
  const currentAltText = singleSelectedUrl
    ? (localAltTexts?.[singleSelectedUrl] ?? imageMetas[singleSelectedUrl]?.altText ?? "")
    : "";

  return (
    <div style={{ borderBottom: "1px solid #e1e3e5", marginBottom: 4 }}>
      <div
        role="button"
        tabIndex={0}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 0",
          cursor: "pointer",
        }}
        onClick={() => setOpen(o => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen(o => !o); }}
      >
        <InlineStack gap="200" align="center" blockAlign="center">
          <input
            type="checkbox"
            checked={isAllSelected}
            disabled={displayUrls.length === 0}
            onChange={(e) => {
              e.stopPropagation();
              displayUrls.forEach(url => onSelect(url, e.target.checked));
            }}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#005bd3", flexShrink: 0 }}
            aria-label={t.imageManager.selectAllVariantLabel.replace("{title}", variant.title)}
          />
          <Text as="span" variant="headingSm">{variant.title}</Text>
          {variant.sku && (
            <Text as="span" variant="bodySm" tone="subdued">SKU: {variant.sku}</Text>
          )}
          <Badge>{String(displayUrls.length)}</Badge>
        </InlineStack>
        <Text as="span" tone="subdued">{open ? "▲" : "▼"}</Text>
      </div>

      <Collapsible open={open} id={`variant-gallery-${variant.id}`} transition={{ duration: "150ms" }}>
        <div style={{ paddingBottom: 12 }}>
          <SortableImageGrid
            containerId={variant.id}
            imageUrls={displayUrls}
            imageMetas={imageMetas}
            onReorder={(newUrls) => {
              const newGids = newUrls.map(u => urlToGid[u] ?? u).filter(Boolean);
              onReorder(variant.id, newGids);
            }}
            onSelect={onSelect}
            selectedUrls={selectedUrls}
            isDropTarget={activeAction !== null || hasLocalSelection}
            activeAction={activeAction}
            onDropToPlaceholder={() => onDrop(variant.id, true)}
            onUploadToGallery={(files) => onUploadToGallery(variant.id, files)}
            thumbSize={thumbSize}
          />

          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {hasLocalSelection && (
              <Button
                size="slim"
                tone="critical"
                variant="secondary"
                onClick={() => onRemoveFromGallery(variant.id, localSelectedUrls)}
              >
                {t.imageManager.remove.replace("{count}", String(localSelectedUrls.length))}
              </Button>
            )}
            {variant.sku && (
              <Button size="slim" onClick={() => onGenerateAltFromSku(variant.id)}>
                {t.imageManager.altTextFromSku}
              </Button>
            )}
          </div>

          {/* Alt text editor — only when exactly 1 image is selected */}
          {singleSelectedUrl && onSaveAltText && (
            <div style={{
              marginTop: 10,
              padding: "10px 12px",
              background: "#f6f6f7",
              borderRadius: 6,
              border: "1px solid #e1e3e5",
            }}>
              <div style={{ marginBottom: 6 }}>
                <Text as="span" variant="bodySm" tone="subdued">
                  {t.imageManager.altTextForSelected}
                </Text>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="text"
                  value={currentAltText}
                  onChange={(e) => onAltTextChange?.(singleSelectedUrl, e.target.value)}
                  placeholder={t.imageManager.altTextPlaceholder}
                  style={{
                    flex: "1 1 200px",
                    minWidth: 180,
                    padding: "5px 8px",
                    fontSize: 13,
                    border: "1px solid #c9cccf",
                    borderRadius: 4,
                    outline: "none",
                    background: "white",
                  }}
                  onFocus={(e) => { e.target.style.borderColor = "#005bd3"; }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "#c9cccf";
                    if (skipNextBlurRef.current) {
                      skipNextBlurRef.current = false;
                      return;
                    }
                    onSaveAltText(singleSelectedUrl, e.target.value);
                  }}
                />
                <div style={{ display: "flex", gap: 4, flexShrink: 0, flexWrap: "wrap" }}>
                  {isPrimaryLocale && onGenerateAltText && (
                    <Button
                      size="slim"
                      disabled={isAltTextLoading}
                      loading={isAltTextLoading}
                      onMouseDown={() => { skipNextBlurRef.current = true; }}
                      onClick={() => onGenerateAltText(singleSelectedUrl)}
                    >
                      {`✨ ${t.imageManager.aiGenerate}`}
                    </Button>
                  )}
                  {!isPrimaryLocale && onTranslateAltText && (
                    <Button
                      size="slim"
                      disabled={isAltTextLoading}
                      loading={isAltTextLoading}
                      onMouseDown={() => { skipNextBlurRef.current = true; }}
                      onClick={() => onTranslateAltText(singleSelectedUrl, currentAltText)}
                    >
                      {`🌍 ${t.imageManager.translateAlt}`}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </Collapsible>
    </div>
  );
}
