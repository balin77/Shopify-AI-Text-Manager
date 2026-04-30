export interface StagedItemParsedMeta {
  productName: string;
  variants: string[];
  identifier: string;
}

export interface StagedItem {
  uniqueId: string;
  previewUrl: string;
  resourceUrl: string;
  fileName: string;
  mimeType: string;
  progress: number;
  status: "uploading" | "ready" | "error";
  targetVariantId?: string;
  /** Parsed from filename: productName_variant1_..._identifier.ext */
  parsedMeta?: StagedItemParsedMeta;
  /** "unassigned" = no SKU match, "assigned" = auto-matched, "manual" = user-placed */
  assignmentMode?: "unassigned" | "assigned" | "manual";
}

export interface VariantWithGallery {
  id: string;              // gid://shopify/ProductVariant/...
  title: string;
  sku: string | null;
  imageKey: string | null;
  position: number;
  galleryFileGids: string[];
  defaultImageUrl?: string;
}

export interface ImageMeta {
  altText?: string | null;
  mimeType?: string;       // e.g. "image/webp", "image/jpeg"
  isConverting?: boolean;  // true while a WebP conversion task is running for this image
}
