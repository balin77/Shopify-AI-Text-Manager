import { useState, useCallback, useEffect } from "react";
import { Text, Button, InlineStack, Spinner, Banner, Divider } from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import { SortableImageGrid } from "./SortableImageGrid";
import { VariantGallerySection } from "./VariantGallerySection";
import type { StagedItem, VariantWithGallery } from "./types";

interface ProductImageRef {
  url: string;
  mediaId: string;
  id: string;
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
  // Callback damit der Parent den Apply-State kennt
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
  const [selectedGalleryUrls, setSelectedGalleryUrls] = useState<Set<string>>(new Set());
  const [pendingVariantGalleries, setPendingVariantGalleries] = useState<Record<string, string[]>>({});
  const [webpError, setWebpError] = useState<string | null>(null);
  const fetcher = useFetcher();

  // Initialer Bild-Order aus productImages
  useEffect(() => {
    setProductImageOrder(productImages.map(i => i.url));
  }, [productImages]);

  // Varianten laden wenn Produkt wechselt
  useEffect(() => {
    if (!productId) return;
    setIsLoadingVariants(true);
    setVariantError(null);
    setPendingVariantGalleries({});

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

  // GID → URL Mapping aus productImages
  const fileUrlMap: Record<string, string> = Object.fromEntries(
    productImages.map(img => [img.mediaId, img.url])
  );

  const handleVariantReorder = useCallback((variantId: string, newGids: string[]) => {
    setPendingVariantGalleries(p => ({ ...p, [variantId]: newGids }));
  }, []);

  const handleProductReorder = useCallback((newUrls: string[]) => {
    setProductImageOrder(newUrls);
    const mediaOrder = newUrls.map((url, idx) => {
      const img = productImages.find(i => i.url === url);
      return img ? { mediaId: img.mediaId, position: idx } : null;
    }).filter(Boolean) as Array<{ mediaId: string; position: number }>;

    const galleries = Object.entries(pendingVariantGalleries).map(([variantId, fileGids]) => ({
      variantId, fileGids,
    }));
    onPendingChange?.(galleries, mediaOrder);
  }, [productImages, pendingVariantGalleries, onPendingChange]);

  const handleDropToVariant = useCallback((targetVariantId: string) => {
    const selectedItems = bulkItems.filter(
      i => selectedBulkIds.has(i.uniqueId) && i.status === "ready"
    );
    if (selectedItems.length === 0) return;

    const newGids = selectedItems.map(i => i.resourceUrl);
    setPendingVariantGalleries(p => {
      const existing = p[targetVariantId] ??
        variants.find(v => v.id === targetVariantId)?.galleryFileGids ?? [];
      return { ...p, [targetVariantId]: [...existing, ...newGids] };
    });

    if (activeAction === "move") {
      onRemoveBulk([...selectedBulkIds]);
    }
    onSetAction(null);
  }, [bulkItems, selectedBulkIds, activeAction, variants, onRemoveBulk, onSetAction]);

  const handleGenerateAltFromSku = useCallback((variantId: string) => {
    const variant = variants.find(v => v.id === variantId);
    const gids = pendingVariantGalleries[variantId] ?? variant?.galleryFileGids ?? [];
    if (!gids.length) return;

    // Ersten GID als mediaId verwenden
    const form = new FormData();
    form.append("_action", "generateAltTextFromSku");
    form.append("productId", productId);
    form.append("mediaId", gids[0]);
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

  const handleGallerySelect = useCallback((url: string, sel: boolean) => {
    setSelectedGalleryUrls(s => {
      const next = new Set(s);
      sel ? next.add(url) : next.delete(url);
      return next;
    });
  }, []);

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
            onReorder={handleProductReorder}
            onSelect={handleGallerySelect}
            selectedUrls={selectedGalleryUrls}
            isDropTarget={activeAction !== null}
          />
        </div>
      </div>

      <Divider />

      {/* Varianten-Galerien */}
      <div>
        <Text as="h3" variant="headingSm">Varianten-Galerien</Text>
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
                activeAction={activeAction}
                selectedUrls={selectedGalleryUrls}
                onSelect={handleGallerySelect}
                onReorder={handleVariantReorder}
                onDrop={handleDropToVariant}
                onGenerateAltFromSku={handleGenerateAltFromSku}
              />
            ))
          )}
        </div>
      </div>

      {/* Aktionen */}
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
