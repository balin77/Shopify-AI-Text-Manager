export interface StagedItem {
  uniqueId: string;
  previewUrl: string;
  resourceUrl: string;
  fileName: string;
  mimeType: string;
  progress: number;
  status: "uploading" | "ready" | "error";
  targetVariantId?: string;
}

export interface VariantWithGallery {
  id: string;              // gid://shopify/ProductVariant/...
  title: string;
  sku: string | null;
  position: number;
  galleryFileGids: string[];
  defaultImageUrl?: string;
  // GID → URL map fetched directly from Shopify references (not from DB cache).
  // Ensures gallery images display even when they're absent from the productImages prop.
  galleryImageMap?: Record<string, string>;
}

export interface ImageMeta {
  altText?: string | null;
  mimeType?: string;       // e.g. "image/webp", "image/jpeg"
}
