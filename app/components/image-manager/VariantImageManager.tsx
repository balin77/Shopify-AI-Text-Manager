import { useState, useCallback, useEffect, useMemo } from "react";
import { Text, Button, InlineStack, Spinner, Banner, Divider } from "@shopify/polaris";
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
  // url → { sourceVariantId: string | null } — null means product gallery
  const [selectedGalleryItems, setSelectedGalleryItems] = useState<Map<string, string | null>>(new Map());
  const [pendingVariantGalleries, setPendingVariantGalleries] = useState<Record<string, string[]>>({});
  const [webpError, setWebpError] = useState<string | null>(null);
  const fetcher = useFetcher();

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
        }));
        setVariants(mapped.sort((a, b) => a.position - b.position));
      })
      .catch(() => setVariantError("Varianten konnten nicht geladen werden."))
      .finally(() => setIsLoadingVariants(false));
  }, [productId]);

  // GID → URL and URL → GID maps
  const fileUrlMap: Record<string, string> = useMemo(() =>
    Object.fromEntries(productImages.map(img => [img.mediaId, img.url])),
    [productImages]
  );

  const urlToGid: Record<string, string> = useMemo(() =>
    Object.fromEntries(productImages.map(img => [img.url, img.mediaId])),
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

  const selectedGalleryUrls = useMemo(() => new Set(selectedGalleryItems.keys()), [selectedGalleryItems]);

  const makeSelectHandler = useCallback((sourceVariantId: string | null) =>
    (url: string, sel: boolean) => {
      setSelectedGalleryItems(m => {
        const next = new Map(m);
        if (sel) next.set(url, sourceVariantId);
        else next.delete(url);
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
        return img ? { mediaId: img.mediaId, position: idx } : null;
      })
      .filter(Boolean) as Array<{ mediaId: string; position: number }>;

    const galleries = Object.entries(pendingVariantGalleries).map(([variantId, fileGids]) => ({
      variantId, fileGids,
    }));
    onPendingChange?.(galleries, mediaOrder);
  }, [productImages, pendingVariantGalleries, onPendingChange]);

  const handleDropToVariant = useCallback((targetVariantId: string) => {
    // Collect GIDs from bulk items
    const bulkGids = bulkItems
      .filter(i => selectedBulkIds.has(i.uniqueId) && i.status === "ready")
      .map(i => i.resourceUrl);

    // Collect GIDs from selected gallery images
    const galleryGids = [...selectedGalleryItems.entries()]
      .map(([url]) => urlToGid[url])
      .filter(Boolean) as string[];

    const newGids = [...bulkGids, ...galleryGids];
    if (newGids.length === 0) return;

    setPendingVariantGalleries(p => {
      const existing = p[targetVariantId] ??
        variants.find(v => v.id === targetVariantId)?.galleryFileGids ?? [];
      return { ...p, [targetVariantId]: [...existing, ...newGids] };
    });

    if (activeAction === "move") {
      // Remove from bulk
      if (selectedBulkIds.size > 0) onRemoveBulk([...selectedBulkIds]);

      // Remove gallery images from their source variants
      const bySource = new Map<string, string[]>();
      for (const [url, sourceId] of selectedGalleryItems.entries()) {
        if (sourceId === null) continue; // product gallery — skip for now
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
    }

    onSetAction(null);
    setSelectedGalleryItems(new Map());
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
      urls.forEach(u => next.delete(u));
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
    } catch {
      setWebpError("WebP-Konvertierung konnte nicht gestartet werden.");
    }
  }, [productId, productImages]);

  const nonWebpCount = productImages.filter(i =>
    !i.url.toLowerCase().includes(".webp") &&
    !i.url.toLowerCase().includes("format=webp")
  ).length;

  const hasAnySelection = selectedBulkIds.size > 0 || selectedGalleryItems.size > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {webpError && (
        <Banner tone="critical" onDismiss={() => setWebpError(null)}>
          <p>{webpError}</p>
        </Banner>
      )}

      {/* Produktbilder allgemein */}
      <div>
        <Text as="h3" variant="headingSm">Produktbilder (allgemein)</Text>
        <div style={{ marginTop: 8 }}>
          <SortableImageGrid
            containerId="product"
            imageUrls={productImageOrder}
            imageMetas={imageMetas}
            onReorder={handleProductReorder}
            onSelect={makeSelectHandler(null)}
            selectedUrls={selectedGalleryUrls}
            isDropTarget={activeAction !== null}
          />
        </div>

        {/* Selection info bar for product gallery */}
        {selectedGalleryItems.size > 0 && (
          <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Text as="span" variant="bodySm" tone="subdued">
              {`${selectedGalleryItems.size} ausgewählt`}
            </Text>
            {!activeAction && (
              <>
                <Button
                  size="slim"
                  onClick={() => onSetAction("copy")}
                >
                  In Galerie kopieren
                </Button>
                <Button
                  size="slim"
                  onClick={() => onSetAction("move")}
                >
                  In Galerie verschieben
                </Button>
              </>
            )}
            <Button
              size="slim"
              variant="plain"
              onClick={() => setSelectedGalleryItems(new Map())}
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
              {activeAction === "copy" ? "Ziel wählen ↓" : "Ziel wählen ↓"}
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
            variants.map(v => (
              <VariantGallerySection
                key={v.id}
                variant={{
                  ...v,
                  galleryFileGids: pendingVariantGalleries[v.id] ?? v.galleryFileGids,
                }}
                fileUrlMap={fileUrlMap}
                imageMetas={imageMetas}
                activeAction={hasAnySelection ? activeAction : null}
                selectedUrls={selectedGalleryUrls}
                onSelect={makeSelectHandler(v.id)}
                onReorder={handleVariantReorder}
                onDrop={handleDropToVariant}
                onRemoveFromGallery={handleRemoveFromGallery}
                onGenerateAltFromSku={handleGenerateAltFromSku}
              />
            ))
          )}
        </div>
      </div>

      {/* WebP conversion */}
      {nonWebpCount > 0 && (
        <div>
          <Button size="slim" onClick={handleConvertToWebP}>
            {`${nonWebpCount} Bild${nonWebpCount !== 1 ? "er" : ""} → WebP konvertieren`}
          </Button>
        </div>
      )}
    </div>
  );
}
