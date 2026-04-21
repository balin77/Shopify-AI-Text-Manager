export interface ParsedMeta {
  productName: string;
  variants: string[];
  identifier: string;
}

export interface ParsedSku {
  productName: string;
  variants: string[];
}

/**
 * Parses a filename in the format:
 *   productname_variant1_variant2_..._identifier.ext
 * Returns productName, variants[], and identifier.
 *
 * Throws if the filename has fewer than 3 underscore-separated segments.
 */
export function parseFilename(filename: string): ParsedMeta {
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new Error("Filename must be a non-empty string.");
  }

  const nameWithoutExtension = filename.replace(/\.[^/.]+$/, "");
  const parts = nameWithoutExtension.split("_");

  if (parts.length < 3) {
    throw new Error(
      `Filename "${filename}" needs at least 3 segments (productName_variant_identifier).`
    );
  }

  const productName = parts[0].trim();
  const identifier = parts[parts.length - 1].trim();
  const rawVariants = parts.slice(1, parts.length - 1);
  const variants = rawVariants.map(v => v.trim()).filter(v => v.length > 0);

  if (!productName) throw new Error(`Empty productName in "${filename}".`);
  if (!identifier) throw new Error(`Empty identifier in "${filename}".`);
  if (variants.length !== rawVariants.length) {
    throw new Error(`Empty variant segment in "${filename}".`);
  }

  return { productName, variants, identifier };
}

/**
 * Parses a Shopify variant SKU in the format:
 *   productname_variant1_variant2_...
 */
export function parseSku(sku: string): ParsedSku {
  if (typeof sku !== "string" || sku.trim() === "") {
    throw new Error("SKU must be a non-empty string.");
  }
  const parts = sku.split("_");
  const productName = parts[0].trim();
  if (!productName) throw new Error(`Empty productName in SKU "${sku}".`);

  const variants = parts
    .slice(1)
    .map(v => v.trim())
    .filter(v => v.length > 0);

  return { productName, variants };
}
