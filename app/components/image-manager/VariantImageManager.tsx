import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Text, Button, InlineStack, Spinner, Banner, Divider, Card, BlockStack } from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import { SortableImageGrid } from "./SortableImageGrid";
import { VariantGallerySection } from "./VariantGallerySection";
import type { StagedItem, VariantWithGallery, ImageMeta } from "./types";

interface ProductImageRef {
  url: string;
  mediaId: string;
  id: string;
  altText?: string | null;
}

interface ImageManagerSettings {
  firstImageBig: boolean;
  showAltTags: boolean;
  autoAltText: boolean;
  thumbSize?: number;
}

interface VariantImageManagerProps {
  productId: string;
  productImages: ProductImageRef[];
  bulkItems: StagedItem[];
  activeAction: "copy" | "move" | null;
  selectedBulkIds: Set<string>;
  onRemoveBulk: (ids: string[]) => void;
  onSetAction: (action: "copy" | "move" | null) => void;
  imageManagerSettings: ImageManagerSettings;
  onPendingChange?: (variantGalleries: Array<{ variantId: string; fileGids: string[] }>, mediaOrder: Array<{ mediaId: string; position: number }>) => void;
}

export function VariantImageManager({
  productId,
  productImages,
  bulkItems,
  activeAction,
  selectedBulkIds,
  onRemoveBulk,
  onSetAction,
  imageManagerSettings,
  onPendingChange,
}: VariantImageManagerProps) {
  const [variants, setVariants] = useState<VariantWithGallery[]>([]);
  const [isLoadingVariants, setIsLoadingVariants] = useState(false);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [productImageOrder, setProductImageOrder] = useState<string[]>([]);
  // `${galleryId}::${url}` → sourceVariantId (null = product gallery)
  // Compound keys ensure same image URL selected in gallery A doesn't affect gallery B
  const [selectedGalleryItems, setSelectedGalleryItems] = useState<Map<string, string | null>>(new Map());
  const [pendingVariantGalleries, setPendingVariantGalleries] = useState<Record<string, string[]>>({});
  const [webpError, setWebpError] = useState<string | null>(null);
  const [isConvertingWebP, setIsConvertingWebP] = useState(false);
  const webpPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [thumbSize, setThumbSize] = useState(imageManagerSettings.thumbSize ?? 80);
  const thumbSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetcher = useFetcher();
  // Track current media order so we can include it whenever variant galleries change
  const pendingMediaOrderRef = useRef<Array<{ mediaId: string; position: number }>>([]);

  useEffect(() => {
    setProductImageOrder(productImages.map(i => i.url));
  }, [productImages]);

  useEffect(() => {
    if (!productId) return;
    setIsLoadingVariants(true);
    setVariantError(null);
    setPendingVariantGalleries({});
    setSelectedGalleryItems(new Map());

    fetch(`/api/product-variants?productId=${encodeURIComponent(productId)}`)
      .then(r => r.json())
      .then(({ variants: raw, error }) => {
        if (error) { setVariantError(error); return; }
        const mapped: VariantWithGallery[] = (raw ?? []).map((v: any) => ({
          id: v.shopifyGid ?? v.id,
          title: v.title,
          sku: v.sku,
          position: v.position,
          galleryFileGids: (() => {
            try { return JSON.parse(v.galleryJson || "[]"); } catch { return []; }
          })(),
          defaultImageUrl: v.image?.url ?? undefined,
        }));
        // Filter out Shopify's synthetic default variant (only variant, titled "Default Title")
        const realVariants = mapped.length === 1 && mapped[0].title === "Default Title"
          ? []
          : mapped;
        setVariants(realVariants.sort((a, b) => a.position - b.position));
      })
      .catch(() => setVariantError("Varianten konnten nicht geladen werden."))
      .finally(() => setIsLoadingVariants(false));
  }, [productId]);

  // Sync pendingVariantGalleries to parent whenever it changes
  useEffect(() => {
    if (Object.keys(pendingVariantGalleries).length === 0) return;
    const galleries = Object.entries(pendingVariantGalleries).map(([variantId, fileGids]) => ({
      variantId, fileGids,
    }));
    onPendingChange?.(galleries, pendingMediaOrderRef.current);
  }, [pendingVariantGalleries]); // eslint-disable-line react-hooks/exhaustive-deps

  const startWebPPolling = useCallback((pid: string) => {
    if (webpPollRef.current) clearInterval(webpPollRef.current);
    webpPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/running-field-tasks?resourceId=${encodeURIComponent(pid)}`);
        const { tasks } = await r.json();
        const active = (tasks ?? []).some((t: { type: string }) => t.type === "imageWebpConversion");
        if (!active) {
          clearInterval(webpPollRef.current!);
          webpPollRef.current = null;
          localStorage.removeItem(`webp_${pid}`);
          setIsConvertingWebP(false);
        }
      } catch {
        // keep polling on transient errors
      }
    }, 3000);
  }, []);

  // Resume polling on mount if a conversion was in progress
  useEffect(() => {
    if (!productId) return;
    const converting = localStorage.getItem(`webp_${productId}`);
    if (converting) {
      setIsConvertingWebP(true);
      startWebPPolling(productId);
    }
    return () => {
      if (webpPollRef.current) clearInterval(webpPollRef.current);
    };
  }, [productId, startWebPPolling]);

  // GID → URL and URL → GID maps (filter out entries with no mediaId)
  const fileUrlMap: Record<string, string> = useMemo(() =>
    Object.fromEntries(productImages.filter(img => img.mediaId).map(img => [img.mediaId, img.url])),
    [productImages]
  );

  const urlToGid: Record<string, string> = useMemo(() =>
    Object.fromEntries(productImages.filter(img => img.mediaId).map(img => [img.url, img.mediaId])),
    [productImages]
  );

  // Image metadata map (by URL)
  const imageMetas: Record<string, ImageMeta> = useMemo(() => {
    const map: Record<string, ImageMeta> = {};
    for (const img of productImages) {
      map[img.url] = { altText: img.altText };
    }
    return map;
  }, [productImages]);

  // All GIDs currently assigned to any variant gallery
  const assignedGids = useMemo(() => {
    const gids = new Set<string>();
    for (const v of variants) {
      const current = pendingVariantGalleries[v.id] ?? v.galleryFileGids;
      current.forEach(gid => gids.add(gid));
    }
    return gids;
  }, [variants, pendingVariantGalleries]);

  // Product image URLs to display (all or only unassigned)
  const displayedProductUrls = useMemo(() => {
    if (showAll || variants.length === 0) return productImageOrder;
    return productImageOrder.filter(url => {
      const gid = urlToGid[url];
      return !gid || !assignedGids.has(gid);
    });
  }, [showAll, productImageOrder, urlToGid, assignedGids, variants.length]);

  // Per-gallery selected URL sets — same URL in different galleries is independent
  const selectedUrlsByGallery = useMemo(() => {
    const map = new Map<string, Set<string>>();
    map.set("product", new Set());
    for (const v of variants) map.set(v.id, new Set());
    for (const [key] of selectedGalleryItems) {
      const sep = key.indexOf("::");
      if (sep === -1) continue;
      const galleryId = key.slice(0, sep);
      const url = key.slice(sep + 2);
      const s = map.get(galleryId);
      if (s) s.add(url);
    }
    return map;
  }, [selectedGalleryItems, variants]);

  const makeSelectHandler = useCallback((sourceVariantId: string | null) =>
    (url: string, sel: boolean) => {
      const galleryId = sourceVariantId ?? "product";
      const key = `${galleryId}::${url}`;
      setSelectedGalleryItems(m => {
        const next = new Map(m);
        if (sel) next.set(key, sourceVariantId);
        else next.delete(key);
        return next;
      });
    }, []);

  const handleVariantReorder = useCallback((variantId: string, newGids: string[]) => {
    setPendingVariantGalleries(p => ({ ...p, [variantId]: newGids }));
  }, []);

  const handleProductReorder = useCallback((newUrls: string[]) => {
    setProductImageOrder(newUrls);
    const mediaOrder = newUrls
      .map((url, idx) => {
        const img = productImages.find(i => i.url === url);
        return img?.mediaId ? { mediaId: img.mediaId, position: idx } : null;
      })
      .filter(Boolean) as Array<{ mediaId: string; position: number }>;

    pendingMediaOrderRef.current = mediaOrder;
    const galleries = Object.entries(pendingVariantGalleries).map(([variantId, fileGids]) => ({
      variantId, fileGids,
    }));
    onPendingChange?.(galleries, mediaOrder);
  }, [productImages, pendingVariantGalleries, onPendingChange]);

  // prepend=true → image lands at position 0 (main image slot, triggered by placeholder click)
  // prepend=false → image appended to end of gallery
  const handleDropToVariant = useCallback((targetVariantId: string, prepend = false) => {
    const bulkGids = bulkItems
      .filter(i => selectedBulkIds.has(i.uniqueId) && i.status === "ready")
      .map(i => i.resourceUrl);

    const galleryGids = [...new Set(
      [...selectedGalleryItems.keys()]
        .map(key => { const sep = key.indexOf("::"); return urlToGid[sep !== -1 ? key.slice(sep + 2) : key]; })
        .filter(Boolean) as string[]
    )];

    const newGids = [...bulkGids, ...galleryGids];
    if (newGids.length === 0) return;

    setPendingVariantGalleries(p => {
      const existing = p[targetVariantId] ??
        variants.find(v => v.id === targetVariantId)?.galleryFileGids ?? [];
      const merged = prepend ? [...newGids, ...existing] : [...existing, ...newGids];
      return { ...p, [targetVariantId]: merged };
    });

    if (activeAction === "move") {
      if (selectedBulkIds.size > 0) onRemoveBulk([...selectedBulkIds]);

      const bySource = new Map<string, string[]>();
      for (const [key, sourceId] of selectedGalleryItems.entries()) {
        if (sourceId === null) continue;
        const sep = key.indexOf("::");
        const url = sep !== -1 ? key.slice(sep + 2) : key;
        const gid = urlToGid[url];
        if (!gid) continue;
        if (!bySource.has(sourceId)) bySource.set(sourceId, []);
        bySource.get(sourceId)!.push(url);
      }
      for (const [srcVariantId, urls] of bySource.entries()) {
        if (srcVariantId === targetVariantId) continue;
        setPendingVariantGalleries(p => {
          const srcVariant = variants.find(v => v.id === srcVariantId);
          const current = p[srcVariantId] ?? srcVariant?.galleryFileGids ?? [];
          const urlSet = new Set(urls);
          return { ...p, [srcVariantId]: current.filter(gid => !urlSet.has(fileUrlMap[gid] ?? "")) };
        });
      }
      // Move ends the action and clears selection
      onSetAction(null);
      setSelectedGalleryItems(new Map());
    }
    // Copy: keep action mode + selection active so user can copy to multiple variants
  }, [bulkItems, selectedBulkIds, selectedGalleryItems, activeAction, variants, urlToGid, fileUrlMap, onRemoveBulk, onSetAction]);

  const handleRemoveFromGallery = useCallback((variantId: string, urls: string[]) => {
    const urlSet = new Set(urls);
    setPendingVariantGalleries(p => {
      const variant = variants.find(v => v.id === variantId);
      const current = p[variantId] ?? variant?.galleryFileGids ?? [];
      return { ...p, [variantId]: current.filter(gid => !urlSet.has(fileUrlMap[gid] ?? "")) };
    });
    setSelectedGalleryItems(m => {
      const next = new Map(m);
      urls.forEach(u => next.delete(`${variantId}::${u}`));
      return next;
    });
  }, [variants, fileUrlMap]);

  const handleGenerateAltFromSku = useCallback((variantId: string) => {
    const variant = variants.find(v => v.id === variantId);
    const gids = pendingVariantGalleries[variantId] ?? variant?.galleryFileGids ?? [];
    if (!gids.length) return;

    const form = new FormData();
    form.append("_action", "generateAltTextFromSku");
    form.append("productId", productId);
    gids.forEach(gid => form.append("mediaId", gid));
    fetcher.submit(form, { method: "post" });
  }, [variants, pendingVariantGalleries, productId, fetcher]);

  const handleConvertToWebP = useCallback(async () => {
    setWebpError(null);
    const nonWebp = productImages.filter(i =>
      !i.url.toLowerCase().includes(".webp") &&
      !i.url.toLowerCase().includes("format=webp")
    );
    if (nonWebp.length === 0) return;

    try {
      const res = await fetch("/api/convert-webp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          images: nonWebp.map(i => ({
            mediaId: i.mediaId,
            url: i.url,
            productImageId: i.id,
          })),
        }),
      });
      if (!res.ok) throw new Error();
      localStorage.setItem(`webp_${productId}`, "1");
      setIsConvertingWebP(true);
      startWebPPolling(productId);
    } catch {
      setWebpError("WebP-Konvertierung konnte nicht gestartet werden.");
    }
  }, [productId, productImages, startWebPPolling]);

  const handleUploadToVariant = useCallback(async (variantId: string, files: File[]) => {
    for (const file of files) {
      try {
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const { url, resourceUrl, error } = await res.json();
        if (error || !url) continue;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => resolve();
          xhr.onerror = () => reject();
          xhr.open("PUT", url);
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.send(file);
        });

        if (resourceUrl) {
          setPendingVariantGalleries(p => {
            const variant = variants.find(v => v.id === variantId);
            const current = p[variantId] ?? variant?.galleryFileGids ?? [];
            return { ...p, [variantId]: [...current, resourceUrl] };
          });
        }
      } catch {
        // silent — user can retry
      }
    }
  }, [variants]);

  const nonWebpCount = productImages.filter(i =>
    !i.url.toLowerCase().includes(".webp") &&
    !i.url.toLowerCase().includes("format=webp")
  ).length;

  const hasAnySelection = selectedBulkIds.size > 0 || selectedGalleryItems.size > 0;

  return (
    <Card padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">Image Manager</Text>
          <Button
            size="slim"
            variant="plain"
            onClick={() => setIsExpanded(e => !e)}
          >
            {isExpanded ? "Verkleinern ↑" : "Vergrößern ↓"}
          </Button>
        </InlineStack>

        <div style={{
          maxHeight: isExpanded ? "none" : 480,
          overflowY: isExpanded ? "visible" : "auto",
          overflowX: "hidden",
          paddingRight: isExpanded ? 0 : 4,
        }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {webpError && (
        <Banner tone="critical" onDismiss={() => setWebpError(null)}>
          <p>{webpError}</p>
        </Banner>
      )}

      {/* Produktbilder allgemein */}
      <div>
        <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h3" variant="headingSm">Produktfotos:</Text>
          {!isLoadingVariants && variants.length > 0 ? (
            <InlineStack gap="0" blockAlign="center">
              {(["all", "unassigned"] as const).map((mode, i) => {
                const label = mode === "all" ? "Alle" : "Nicht zugewiesen";
                const active = mode === "all" ? showAll : !showAll;
                return (
                  <span key={mode}>
                    {i > 0 && <span style={{ color: "#8c9196", padding: "0 4px" }}>·</span>}
                    <button
                      onClick={() => setShowAll(mode === "all")}
                      style={{
                        background: "none",
                        border: "none",
                        padding: "0 2px",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: active ? 700 : 400,
                        color: active ? "#202223" : "#6d7175",
                        borderBottom: active ? "2px solid #202223" : "2px solid transparent",
                        lineHeight: "20px",
                      }}
                    >
                      {label}
                    </button>
                  </span>
                );
              })}
            </InlineStack>
          ) : (
            <Text as="span" variant="headingSm" tone="subdued">Allgemein</Text>
          )}
        </InlineStack>
        <input
          type="range"
          min={80}
          max={200}
          step={10}
          value={thumbSize}
          onChange={(e) => {
            const val = Number(e.target.value);
            setThumbSize(val);
            if (thumbSaveTimer.current) clearTimeout(thumbSaveTimer.current);
            thumbSaveTimer.current = setTimeout(() => {
              fetch("/api/image-manager-settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ thumbSize: val }),
              }).catch(() => {});
            }, 600);
          }}
          style={{ width: 80, cursor: "pointer", accentColor: "#005bd3" }}
          aria-label="Bildgröße"
        />
        </InlineStack>
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={displayedProductUrls.length > 0 && displayedProductUrls.every(url => (selectedUrlsByGallery.get("product") ?? new Set()).has(url))}
            disabled={displayedProductUrls.length === 0}
            onChange={(e) => {
              const handler = makeSelectHandler(null);
              displayedProductUrls.forEach(url => handler(url, e.target.checked));
            }}
            style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#005bd3" }}
            aria-label="Alle Produktbilder auswählen"
          />
          <Text as="span" variant="bodySm" tone="subdued">Alle auswählen</Text>
        </div>
        <div style={{ marginTop: 8 }}>
          <SortableImageGrid
            containerId="product"
            imageUrls={displayedProductUrls}
            imageMetas={imageMetas}
            onReorder={handleProductReorder}
            onSelect={makeSelectHandler(null)}
            selectedUrls={selectedUrlsByGallery.get("product") ?? new Set()}
            isDropTarget={activeAction !== null}
            thumbSize={thumbSize}
          />
        </div>

        {/* Selection info bar for product gallery */}
        {selectedGalleryItems.size > 0 && (
          <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Text as="span" variant="bodySm" tone="subdued">
              {`${selectedGalleryItems.size} ausgewählt`}
            </Text>
            <Button
              size="slim"
              variant={activeAction === "copy" ? "primary" : "secondary"}
              onClick={() => onSetAction(activeAction === "copy" ? null : "copy")}
            >
              {activeAction === "copy" ? "Kopieren aktiv ✕" : "Kopieren"}
            </Button>
            <Button
              size="slim"
              variant={activeAction === "move" ? "primary" : "secondary"}
              onClick={() => onSetAction(activeAction === "move" ? null : "move")}
            >
              {activeAction === "move" ? "Verschieben aktiv ✕" : "Verschieben"}
            </Button>
            <Button
              size="slim"
              variant="plain"
              onClick={() => { setSelectedGalleryItems(new Map()); onSetAction(null); }}
            >
              Auswahl aufheben
            </Button>
          </div>
        )}
      </div>

      <Divider />

      {/* Varianten-Galerien */}
      <div>
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">Varianten-Galerien</Text>
          {hasAnySelection && activeAction && (
            <Text as="span" variant="bodySm" tone="subdued">
              {activeAction === "copy" ? "Kopieren: Galerie-Placeholder klicken" : "Verschieben: Galerie-Placeholder klicken"}
            </Text>
          )}
        </InlineStack>

        <div style={{ marginTop: 8 }}>
          {isLoadingVariants ? (
            <div style={{ padding: 16, display: "flex", justifyContent: "center" }}>
              <Spinner size="small" />
            </div>
          ) : variantError ? (
            <Banner tone="warning"><p>{variantError}</p></Banner>
          ) : variants.length === 0 ? (
            <Text as="p" tone="subdued">Keine Varianten gefunden.</Text>
          ) : (
            variants.map(v => {
              const storedGids = pendingVariantGalleries[v.id] ?? v.galleryFileGids;
              const mainGid = v.defaultImageUrl
                ? (urlToGid[v.defaultImageUrl] ??
                   Object.entries(urlToGid).find(([u]) =>
                     u.split("?")[0] === v.defaultImageUrl!.split("?")[0]
                   )?.[1])
                : undefined;
              const effectiveGids = mainGid && !storedGids.includes(mainGid)
                ? [mainGid, ...storedGids]
                : storedGids;
              return (
              <VariantGallerySection
                key={v.id}
                variant={{
                  ...v,
                  galleryFileGids: effectiveGids,
                }}
                fileUrlMap={fileUrlMap}
                imageMetas={imageMetas}
                activeAction={hasAnySelection ? activeAction : null}
                selectedUrls={selectedUrlsByGallery.get(v.id) ?? new Set()}
                onSelect={makeSelectHandler(v.id)}
                onReorder={handleVariantReorder}
                onDrop={handleDropToVariant}
                onRemoveFromGallery={handleRemoveFromGallery}
                onGenerateAltFromSku={handleGenerateAltFromSku}
                onUploadToGallery={handleUploadToVariant}
                thumbSize={thumbSize}
              />
              );
            })
          )}
        </div>
      </div>

      {/* WebP conversion */}
      {(nonWebpCount > 0 || isConvertingWebP) && (
        <div>
          <InlineStack gap="200" blockAlign="center">
            <Button size="slim" onClick={handleConvertToWebP} disabled={isConvertingWebP}>
              {isConvertingWebP
                ? "WebP-Konvertierung läuft…"
                : `${nonWebpCount} Bild${nonWebpCount !== 1 ? "er" : ""} → WebP konvertieren`}
            </Button>
            {isConvertingWebP && <Spinner size="small" />}
          </InlineStack>
        </div>
      )}
    </div>
  );
}
