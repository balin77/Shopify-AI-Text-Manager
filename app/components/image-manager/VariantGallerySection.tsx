import { useState, useRef, useMemo } from "react";
import { Text, Button, InlineStack, Collapsible, Badge, TextField, Banner } from "@shopify/polaris";
import { useDroppable } from "@dnd-kit/core";
import { useI18n } from "../../contexts/I18nContext";
import { PULSE_SYNC_EPOCH } from "../../utils/contentEditor.utils";
import { TIMING } from "../../constants/timing";
import { SortableImageGrid } from "./SortableImageGrid";
import { parseExternalVideoUrl } from "../../utils/mediaKind";
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
  onGenerateAltFromSku: (variantId: string, selectedGids: string[]) => void;
  onUploadToGallery: (variantId: string, files: File[]) => void;
  thumbSize?: number;
  forceOpen?: boolean;
  skipDndContext?: boolean;
  hasMainImage?: boolean;
  localAltTexts?: Record<string, string>;
  isAltTextLoading?: boolean;
  onAltTextChange?: (url: string, value: string) => void;
  onSaveAltText?: (url: string, altText: string) => void;
  onGenerateAltText?: (url: string) => void;
  onTranslateAltText?: (url: string, sourceAltText: string) => void;
  onTranslateAltToAllLocales?: (url: string, sourceAltText: string) => void;
  enabledLanguages?: string[];
  currentLanguage?: string;
  primaryLocale?: string;
  /** Effective YouTube/Vimeo URLs for this variant (server-loaded + local
   *  pending edits). Undefined falls back to `variant.externalVideoUrls`. */
  externalVideoUrls?: string[];
  onAddExternalVideoUrl?: (variantId: string, url: string) => void;
  onRemoveExternalVideoUrl?: (variantId: string, url: string) => void;
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
  forceOpen = false,
  skipDndContext = false,
  hasMainImage = true,
  localAltTexts,
  isAltTextLoading,
  onAltTextChange,
  onSaveAltText,
  onGenerateAltText,
  onTranslateAltText,
  onTranslateAltToAllLocales,
  enabledLanguages = [],
  currentLanguage,
  primaryLocale,
  externalVideoUrls,
  onAddExternalVideoUrl,
  onRemoveExternalVideoUrl,
}: VariantGallerySectionProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const isOpen = open || forceOpen;
  const { setNodeRef: setDropRef } = useDroppable({ id: variant.id });
  // Local input state for the YouTube / Vimeo URL row. We validate on
  // submit (parseExternalVideoUrl returns null for anything we can't safely
  // embed) so a paste of a tracking-laden URL still works as long as it
  // contains a parseable id.
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const effectiveExternalVideoUrls = externalVideoUrls ?? variant.externalVideoUrls ?? [];
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
  // In foreign locale don't fall back to primary locale value (would show wrong content)
  const currentAltText = singleSelectedUrl
    ? (isPrimaryLocale
      ? (localAltTexts?.[singleSelectedUrl] ?? imageMetas[singleSelectedUrl]?.altText ?? "")
      : (localAltTexts?.[singleSelectedUrl] ?? ""))
    : "";
  const primaryAltText = singleSelectedUrl ? (imageMetas[singleSelectedUrl]?.altText ?? "") : "";
  const hasTranslation = singleSelectedUrl
    ? (localAltTexts?.[singleSelectedUrl] !== undefined && localAltTexts[singleSelectedUrl] !== "")
    : false;

  const variantTitlePulseStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!hasMainImage) {
      return {
        animation: `pulseFadeIn 500ms ease-out forwards, pulse ${TIMING.HIGHLIGHT_DURATION_MS}ms ease-in-out infinite`,
        animationDelay: `0s, -${(Date.now() - PULSE_SYNC_EPOCH) % TIMING.HIGHLIGHT_DURATION_MS}ms`,
        borderRadius: 4,
        padding: "1px 4px",
      };
    }
    return undefined;
  }, [hasMainImage]);

  return (
    <div ref={setDropRef} style={{ borderBottom: "1px solid #e1e3e5", marginBottom: 4 }}>
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
        aria-expanded={isOpen}
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
          <span style={variantTitlePulseStyle}>
            <Text as="span" variant="headingSm">{variant.title}</Text>
          </span>
          {variant.sku && (
            <Text as="span" variant="bodySm" tone="subdued">SKU: {variant.sku}</Text>
          )}
          <Badge>{String(displayUrls.length)}</Badge>
        </InlineStack>
        <Text as="span" tone="subdued">{isOpen ? "▲" : "▼"}</Text>
      </div>

      <Collapsible open={isOpen} id={`variant-gallery-${variant.id}`} transition={{ duration: "150ms" }}>
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
            skipDndContext={skipDndContext}
            hasMainImage={hasMainImage}
            localAltTexts={localAltTexts}
            isPrimaryLocale={isPrimaryLocale}
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
          </div>

          {/* YouTube / Vimeo URL row — only rendered when wired by the parent
              (i.e. when onAddExternalVideoUrl is provided). These items are
              persisted to a separate metafield (variant_external_videos)
              because list.file_reference can't hold URLs; the storefront
              Liquid appends them after the file-backed items per variant. */}
          {onAddExternalVideoUrl && (
            <div style={{ marginTop: 10, padding: "10px 12px", background: "#f6f6f7", borderRadius: 6, border: "1px solid #e1e3e5" }}>
              <div style={{ marginBottom: 6 }}>
                <Text as="span" variant="bodySm" tone="subdued">
                  {t.imageManager.addExternalVideoTitle ?? "Add YouTube or Vimeo URL"}
                </Text>
              </div>
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <div style={{ flex: "1 1 240px", minWidth: 200 }}>
                  <TextField
                    label=""
                    labelHidden
                    autoComplete="off"
                    value={urlInput}
                    onChange={(v) => { setUrlInput(v); if (urlError) setUrlError(null); }}
                    placeholder={t.imageManager.addExternalVideoPlaceholder ?? "https://youtube.com/watch?v=…"}
                    error={urlError ?? undefined}
                  />
                </div>
                <Button
                  size="slim"
                  onClick={() => {
                    const parsed = parseExternalVideoUrl(urlInput);
                    if (!parsed) {
                      setUrlError(t.imageManager.externalVideoInvalid ?? "Not a recognised YouTube or Vimeo URL.");
                      return;
                    }
                    if (effectiveExternalVideoUrls.includes(parsed.canonicalUrl)) {
                      // Silent no-op for duplicates — re-adding the same URL
                      // would otherwise produce a noisy banner for nothing.
                      setUrlInput("");
                      return;
                    }
                    onAddExternalVideoUrl(variant.id, parsed.canonicalUrl);
                    setUrlInput("");
                    setUrlError(null);
                  }}
                >
                  {t.imageManager.addExternalVideoButton ?? "Add"}
                </Button>
              </InlineStack>
              {effectiveExternalVideoUrls.length > 0 && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {effectiveExternalVideoUrls.map((url) => {
                    const parsed = parseExternalVideoUrl(url);
                    const hostLabel = parsed?.host === "youtube" ? "YouTube" : parsed?.host === "vimeo" ? "Vimeo" : "Link";
                    return (
                      <div key={url} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", background: "white", borderRadius: 4, border: "1px solid #e1e3e5", fontSize: 12 }}>
                        <Badge tone="info">{hostLabel}</Badge>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#1f2937" }} title={url}>
                          {url}
                        </span>
                        {onRemoveExternalVideoUrl && (
                          <Button size="slim" variant="plain" tone="critical" onClick={() => onRemoveExternalVideoUrl(variant.id, url)}>
                            ×
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Alt text editor — only when exactly 1 image is selected */}
          {singleSelectedUrl && onSaveAltText && (
            <div style={{
              marginTop: 10,
              padding: "10px 12px",
              background: !isPrimaryLocale && !hasTranslation ? "#fff8f0" : "#f6f6f7",
              borderRadius: 6,
              border: `1px solid ${!isPrimaryLocale && !hasTranslation ? "#e6a817" : "#e1e3e5"}`,
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
                  placeholder={isPrimaryLocale ? t.imageManager.altTextPlaceholder : (primaryAltText || t.imageManager.altTextPlaceholder)}
                  style={{
                    flex: "1 1 200px",
                    minWidth: 180,
                    padding: "5px 8px",
                    fontSize: 13,
                    border: "1px solid #c9cccf",
                    borderRadius: 4,
                    outline: "none",
                    background: !isPrimaryLocale && !hasTranslation ? "#fff8f0" : "white",
                  }}
                  onFocus={(e) => { e.target.style.borderColor = "#005bd3"; e.target.style.background = "white"; }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "#c9cccf";
                    e.target.style.background = !isPrimaryLocale && !hasTranslation ? "#fff8f0" : "white";
                    if (skipNextBlurRef.current) {
                      skipNextBlurRef.current = false;
                      return;
                    }
                    onSaveAltText(singleSelectedUrl, e.target.value);
                  }}
                />
                <div style={{ display: "flex", gap: 4, flexShrink: 0, flexWrap: "wrap" }}>
                  {isPrimaryLocale && onGenerateAltText && (
                    <div onMouseDown={() => { skipNextBlurRef.current = true; }}>
                      <Button
                        size="slim"
                        disabled={isAltTextLoading}
                        loading={isAltTextLoading}
                        onClick={() => onGenerateAltText(singleSelectedUrl)}
                      >
                        {`✨ ${t.imageManager.aiGenerate}`}
                      </Button>
                    </div>
                  )}
                  {isPrimaryLocale && onTranslateAltToAllLocales && enabledLanguages.filter(l => l !== primaryLocale).length > 0 && (
                    <div onMouseDown={() => { skipNextBlurRef.current = true; }}>
                      <Button
                        size="slim"
                        disabled={isAltTextLoading}
                        loading={isAltTextLoading}
                        onClick={() => onTranslateAltToAllLocales(singleSelectedUrl, currentAltText)}
                      >
                        {`🌍 ${t.imageManager.translateAltAll}`}
                      </Button>
                    </div>
                  )}
                  {!isPrimaryLocale && onTranslateAltText && (
                    <div onMouseDown={() => { skipNextBlurRef.current = true; }}>
                      <Button
                        size="slim"
                        disabled={isAltTextLoading}
                        loading={isAltTextLoading}
                        onClick={() => onTranslateAltText(singleSelectedUrl, currentAltText)}
                      >
                        {`🌍 ${t.imageManager.translateAlt}`}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
              {!isPrimaryLocale && primaryAltText && (
                <div style={{ marginTop: 6, fontSize: 12, color: "#6d7175" }}>
                  <span style={{ fontWeight: 600 }}>{t.imageManager.primaryRef}: </span>
                  {primaryAltText}
                </div>
              )}
            </div>
          )}
        </div>
      </Collapsible>
    </div>
  );
}
