/**
 * A metaobject field of Shopify type `rich_text_field`, shown and NOT edited.
 *
 * Deliberate (§6.5): the stored value is a JSON document, and a half rich-text
 * editor that damages that structure is worse than no editor. What is shown is
 * the plain-text preview `richTextPreview` extracts, and the note says where
 * the field can actually be changed -- a field that is simply missing looks
 * like a bug, one with a reason is an explanation.
 *
 * The server refuses a write to this type as well, so nothing here relies on
 * the control staying read-only.
 */

import { BlockStack, Text } from "@shopify/polaris";
import type { FieldRenderProps } from "~/types/content-editor.types";

export function MetaobjectRichTextField({ field, value, t }: FieldRenderProps) {
  const content = (t as { content?: Record<string, string> } | undefined)?.content ?? {};
  return (
    <BlockStack gap="150">
      <Text as="span" variant="bodyMd" fontWeight="medium">
        {field.label}
      </Text>
      <div
        style={{
          padding: "0.5rem 0.75rem",
          background: "var(--p-color-bg-surface-secondary)",
          borderRadius: "6px",
          border: "1px solid var(--p-color-border)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        <Text as="p" variant="bodySm" tone={value ? "base" : "subdued"}>
          {value || "—"}
        </Text>
      </div>
      <Text as="span" variant="bodySm" tone="subdued">
        {content.metaobjectEntryRichTextHint || "Rich text is shown only — edit it in the Shopify admin."}
      </Text>
    </BlockStack>
  );
}
