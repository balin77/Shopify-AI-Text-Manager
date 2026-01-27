/**
 * Templates Field Factory
 *
 * Generates FieldDefinition[] dynamically from template translatableContent
 */

import type { FieldDefinition, FieldType } from "../types/content-editor.types";

interface TranslatableContentItem {
  key: string;
  value: string;
}

/**
 * Creates FieldDefinition array from translatableContent
 */
export function createTemplateFieldDefinitions(
  translatableContent: TranslatableContentItem[] | undefined
): FieldDefinition[] {
  if (!translatableContent || !Array.isArray(translatableContent)) {
    return [];
  }

  // Filter out null/undefined items to prevent "Cannot read properties of null" errors
  return translatableContent.filter((item) => item != null).map((item) => ({
    key: item.key,
    type: detectFieldType(item.value),
    label: extractReadableName(item.key),
    translationKey: item.key, // For templates, key IS the translation key
    supportsAI: true,
    supportsFormatting: false, // Templates don't support formatting
    supportsTranslation: true,
    aiInstructionsKey: "themeContent",
  }));
}

/**
 * Detects if content is HTML or plain text
 */
export function detectFieldType(value: string): FieldType {
  if (!value) return "text";
  return /<(p|h[1-6]|div|span|ul|ol|li|br|strong|em|a|b|i|u)\b[^>]*>/i.test(value)
    ? "html"
    : "text";
}

/**
 * Extracts a human-readable name from a theme key
 * (Moved from ThemeContentViewer.tsx for reuse)
 */
export function extractReadableName(key: string): string {
  let name = key;

  // Remove section prefixes
  name = name.replace(/^section\.(article|collection|index|password|product|page)\.json\./i, "");
  name = name.replace(/^section\.(article|collection|index|password|product|page)\./i, "");

  // Remove collections.json prefix
  name = name.replace(/^collections\.json\./i, "");

  // Remove group.json prefix
  name = name.replace(/^group\.json\./i, "");

  // Remove bar prefix
  name = name.replace(/^bar\./i, "");

  // Remove "Settings Categories:" prefix
  name = name.replace(/^Settings Categories:\s*/i, "");

  // Remove trailing IDs (like :3syj88j, .heading:3jfch, etc.)
  name = name.replace(/:[a-z0-9]+$/i, "");
  name = name.replace(/\.[a-z0-9_]+:[a-z0-9]+$/i, "");

  // Remove common suffixes
  name = name.replace(/\.(heading|text|label|title)$/i, "");

  // Get the last meaningful part
  const parts = name.split(".");
  if (parts.length > 1) {
    // Take the last 2-3 parts for context
    name = parts.slice(-2).join(" › ");
  }

  // Convert underscores to spaces and capitalize
  name = name.replace(/_/g, " ");
  name = name
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  return name || key; // Fallback to original key if parsing fails
}

/**
 * Gets field value from a template item
 * Templates store values in translatableContent array
 */
export function getTemplateFieldValue(item: any, fieldKey: string): string {
  if (!item?.translatableContent) return "";

  const content = item.translatableContent.find((c: any) => c.key === fieldKey);
  return content?.value || "";
}
