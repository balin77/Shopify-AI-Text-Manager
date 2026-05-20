import { useState, useRef, useMemo } from "react";
import { Text, Button, InlineStack, Collapsible, Badge } from "@shopify/polaris";
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
  /** Effective 3D model URLs (.glb) for this variant — same contract as
   *  externalVideoUrls. Models are rendered inside the sortable grid with a
   *  3D badge; the SortableImageGrid resolves the right thumbnail variant. */
  threeDModelUrls?: string[];
  onRemoveThreeDModelUrl?: (variantId: string, url: string) => void;
  /** Opens the parent's Browse-Files modal targeted at this variant. The
   *  parent owns the modal so its selection callback can update pending
   *  gallery state without re-mounting on every variant. */
  onBrowseLibrary?: () => void;
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
  // onAddExternalVideoUrl / onRemoveExternalVideoUrl are kept on the
  // interface for backward compatibility but no longer used inside this
  // component: the URL row was moved into the central add-media modal,
  // which routes additions/removals through the parent's pending state
  // via its own callbacks. They survive in the props so any consumer that
  // still passes them compiles unchanged.
  threeDModelUrls,
  // onRemoveThreeDModelUrl is kept on the interface but unused here —
  // removal flows through onRemoveFromGallery, same as files and external
  // videos. Parent inspects the URL pattern (.glb) to route to the right
  // metafield.
  onBrowseLibrary,
}: VariantGallerySectionProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const isOpen = open || forceOpen;
  const { setNodeRef: setDropRef } = useDroppable({ id: variant.id });
  const effectiveExternalVideoUrls = externalVideoUrls ?? variant.externalVideoUrls ?? [];
  const effectiveThreeDModelUrls = threeDModelUrls ?? variant.threeDModelUrls ?? [];
  const skipNextBlurRef = useRef(false);

  const urls = variant.galleryFileGids
    .map(gid => fileUrlMap[gid])
    .filter(Boolean) as string[];

  // Voll-mix: external video URLs render as additional tiles inside the same
  // sortable grid as file-backed items, so the merchant can drag-reorder
  // across both kinds. variant_gallery_order (json) holds the persisted
  // sequence; the parent reorder handler splits the dropped result back into
  // the per-kind pending state slots. URLs always sort after files on first
  // paint — the order metafield can move them anywhere except position 0.
  const fileUrlList = urls.length > 0 ? urls : variant.galleryFileGids
    .filter(gid => gid.startsWith("http"))
    .slice(0, 10);
  const orderedUrls = useMemo(() => {
    // If the variant has a saved order, honour it: emit items in the saved
    // sequence, skipping any references that no longer resolve (file deleted
    // / URL removed). Falls back to "files first, then URLs, then models"
    // when missing.
    const knownFileSet = new Set(fileUrlList);
    const knownUrlSet = new Set(effectiveExternalVideoUrls);
    const knownModelSet = new Set(effectiveThreeDModelUrls);
    const raw = variant.galleryOrderJson;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Array<{ kind: string; value: string }>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const out: string[] = [];
          const seenFiles = new Set<string>();
          const seenUrls = new Set<string>();
          const seenModels = new Set<string>();
          for (const entry of parsed) {
            if (entry?.kind === "file") {
              const fileUrl = fileUrlMap[entry.value];
              if (fileUrl && knownFileSet.has(fileUrl) && !seenFiles.has(fileUrl)) {
                out.push(fileUrl);
                seenFiles.add(fileUrl);
              }
            } else if (entry?.kind === "url") {
              if (knownUrlSet.has(entry.value) && !seenUrls.has(entry.value)) {
                out.push(entry.value);
                seenUrls.add(entry.value);
              }
            } else if (entry?.kind === "model") {
              if (knownModelSet.has(entry.value) && !seenModels.has(entry.value)) {
                out.push(entry.value);
                seenModels.add(entry.value);
              }
            }
          }
          // Append anything the order JSON didn't cover (new uploads / URLs /
          // models added since the last save) so they're still visible.
          for (const u of fileUrlList) if (!seenFiles.has(u)) out.push(u);
          for (const u of effectiveExternalVideoUrls) if (!seenUrls.has(u)) out.push(u);
          for (const u of effectiveThreeDModelUrls) if (!seenModels.has(u)) out.push(u);
          return out;
        }
      } catch { /* fall through to default */ }
    }
    return [...fileUrlList, ...effectiveExternalVideoUrls, ...effectiveThreeDModelUrls];
    // effective*Urls are referenced via closure; we recompute when any of
    // these inputs change so the merchant sees the latest mix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant.galleryOrderJson, fileUrlList.join("|"), effectiveExternalVideoUrls.join("|"), effectiveThreeDModelUrls.join("|"), fileUrlMap]);

  const displayUrls = orderedUrls;

  // Augment the parent's imageMetas with synthetic entries for external
  // video URLs and 3D model URLs — the parent only populates entries for
  // product images, so without this the SortableThumbnail dispatch would
  // fall back to <img> and try to load a YouTube watch-page URL or a .glb
  // binary as an image (broken icon).
  const enrichedImageMetas = useMemo(() => {
    if (effectiveExternalVideoUrls.length === 0 && effectiveThreeDModelUrls.length === 0) return imageMetas;
    const out: Record<string, ImageMeta> = { ...imageMetas };
    for (const u of effectiveExternalVideoUrls) {
      if (out[u]?.kind === "external_video") continue;
      const parsed = parseExternalVideoUrl(u);
      out[u] = {
        ...(out[u] ?? {}),
        kind: "external_video",
        externalHost: parsed?.host === "youtube" ? "YouTube" : parsed?.host === "vimeo" ? "Vimeo" : undefined,
        altText: (out[u]?.altText ?? variant.title),
      };
    }
    for (const u of effectiveThreeDModelUrls) {
      if (out[u]?.kind === "model") continue;
      out[u] = {
        ...(out[u] ?? {}),
        kind: "model",
        altText: (out[u]?.altText ?? variant.title),
      };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageMetas, effectiveExternalVideoUrls.join("|"), effectiveThreeDModelUrls.join("|"), variant.title]);

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
            imageMetas={enrichedImageMetas}
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
            onOpenPicker={onBrowseLibrary}
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
            {/* The standalone "Browse existing files" button and the
                YouTube/Vimeo URL row used to live here. Both have moved
                into the central add-media modal — opened by clicking the
                placeholder tile in the gallery grid above (onOpenPicker on
                the SortableImageGrid). One entry point, one mental model. */}
          </div>

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
