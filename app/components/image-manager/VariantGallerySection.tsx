import { useState } from "react";
import { Text, Button, InlineStack, Collapsible } from "@shopify/polaris";
import { SortableImageGrid } from "./SortableImageGrid";
import type { VariantWithGallery } from "./types";

interface VariantGallerySectionProps {
  variant: VariantWithGallery;
  fileUrlMap: Record<string, string>;
  activeAction: "copy" | "move" | null;
  selectedUrls: Set<string>;
  onSelect: (url: string, selected: boolean) => void;
  onReorder: (variantId: string, newGids: string[]) => void;
  onDrop: (targetVariantId: string) => void;
  onGenerateAltFromSku: (variantId: string) => void;
}

export function VariantGallerySection({
  variant,
  fileUrlMap,
  activeAction,
  selectedUrls,
  onSelect,
  onReorder,
  onDrop,
  onGenerateAltFromSku,
}: VariantGallerySectionProps) {
  const [open, setOpen] = useState(false);

  const urls = variant.galleryFileGids
    .map(gid => fileUrlMap[gid])
    .filter(Boolean) as string[];

  // Fallback: wenn keine GID-Mapping, versuche GID selbst als URL
  const displayUrls = urls.length > 0 ? urls : variant.galleryFileGids
    .filter(gid => gid.startsWith("http"))
    .slice(0, 10);

  const urlToGid = Object.fromEntries(
    Object.entries(fileUrlMap).map(([gid, url]) => [url, gid])
  );

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
          <Text as="span" variant="headingSm">{variant.title}</Text>
          {variant.sku && (
            <Text as="span" variant="bodySm" tone="subdued">SKU: {variant.sku}</Text>
          )}
          <Text as="span" variant="bodySm" tone="subdued">({displayUrls.length} Bilder)</Text>
        </InlineStack>
        <Text as="span" tone="subdued">{open ? "▲" : "▼"}</Text>
      </div>

      <Collapsible open={open} id={`variant-gallery-${variant.id}`} transition={{ duration: "150ms" }}>
        <div style={{ paddingBottom: 12 }}>
          <SortableImageGrid
            containerId={variant.id}
            imageUrls={displayUrls}
            onReorder={(newUrls) => {
              const newGids = newUrls.map(u => urlToGid[u] ?? u).filter(Boolean);
              onReorder(variant.id, newGids);
            }}
            onSelect={onSelect}
            selectedUrls={selectedUrls}
            isDropTarget={activeAction !== null}
          />

          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {activeAction && (
              <Button size="slim" variant="secondary" onClick={() => onDrop(variant.id)}>
                {activeAction === "copy" ? "Hierhin kopieren" : "Hierhin verschieben"}
              </Button>
            )}
            {variant.sku && (
              <Button size="slim" onClick={() => onGenerateAltFromSku(variant.id)}>
                Alt-Text aus SKU
              </Button>
            )}
          </div>
        </div>
      </Collapsible>
    </div>
  );
}
