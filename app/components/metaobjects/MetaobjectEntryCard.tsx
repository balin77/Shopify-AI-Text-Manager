/**
 * ONE entry of a metaobject type, as a card.
 *
 * The metaobjects page used to render one bare text input per entry -- the
 * entry was a form FIELD, so there was no level at which it was an object and
 * therefore nowhere to put "delete this", "here are its other fields" or a
 * swatch. This card is that level. Collapsed it looks like the row it replaced,
 * which is why the change costs the merchant nothing.
 *
 * Three things it says that the old row could not:
 *
 * - **Fields this app cannot edit are NAMED, with their type.** A field that
 *   silently disappears looks like a bug; one with a reason is an explanation.
 *   Same rule as the definitions the create form refuses to offer.
 * - **Whether the entry is in use, three-valued.** "0 products" and "we do not
 *   know" are different answers, and only the first of them makes deleting
 *   safe. An empty product cache is not evidence -- it offers a sync instead.
 * - **Why delete is disabled**, on the button itself, rather than after the
 *   merchant has typed the entry's name into a confirmation dialog.
 */

import type { ReactNode } from "react";
import { BlockStack, Badge, Button, Card, InlineStack, Text, Tooltip } from "@shopify/polaris";
import { SwatchPreview } from "./SwatchPreview";
import type { OptionValueSwatch } from "~/services/product-option-swatch.shared";

/** What the page knows about an entry's usage as a product option value. */
export type MetaobjectEntryUsage =
  | { state: "loading" }
  /** The product cache answered. `products` may legitimately be 0. */
  | { state: "known"; products: number }
  /** Nothing to count from -- NOT the same as zero. */
  | { state: "unknown"; reason: "noProducts" | "lookupFailed" };

export interface MetaobjectEntryCardTexts {
  handleLabel?: string;
  noEditableFields?: string;
  unsupportedTitle?: string;
  unsupportedHint?: string;
  deleteLabel?: string;
  deleteUsageUnknown?: string;
  deleteInUse?: string;
  usageChecking?: string;
  usageNone?: string;
  usageKnown?: string;
  usageUnknown?: string;
  syncProducts?: string;
  createdBadge?: string;
  readOnlyDefinition?: string;
  readOnlyUnknown?: string;
}

interface Props {
  entryId: string;
  title: string;
  handle?: string;
  /** Colour / image the entry's own fields describe, for the header dot. */
  swatch?: OptionValueSwatch | null;
  /** Fields of the definition this app has no editor for: name + Shopify type. */
  unsupportedFields: Array<{ label: string; fieldType: string }>;
  /** The rendered controls for the fields it CAN edit. */
  children: ReactNode[];
  /** Highlighted because it was just created. */
  justCreated?: boolean;
  usage?: MetaobjectEntryUsage;
  onDelete?: () => void;
  onSyncProducts?: () => void;
  /** Set when the whole entry is read-only (its definition refuses our writes). */
  readOnlyReason?: "refused" | "unknown";
  t?: MetaobjectEntryCardTexts;
}

export function MetaobjectEntryCard({
  entryId,
  title,
  handle,
  swatch,
  unsupportedFields,
  children,
  justCreated = false,
  usage,
  onDelete,
  onSyncProducts,
  readOnlyReason,
  t = {},
}: Props) {
  // Deleting is only offered once we KNOW the entry is unused. "Unknown" is
  // treated exactly like "in use": a delete whose consequences nobody can name
  // is the one this whole card exists to prevent.
  const deleteBlockedReason =
    !usage || usage.state === "loading"
      ? t.usageChecking || "Checking usage…"
      : usage.state === "unknown"
        ? t.deleteUsageUnknown || "We do not know whether this entry is in use — sync your products first."
        : usage.products > 0
          ? (t.deleteInUse || "{products} product(s) use this entry as an option value. Remove it there first.").replace(
              "{products}",
              String(usage.products),
            )
          : null;

  const usageLine =
    !usage || usage.state === "loading"
      ? t.usageChecking || "Checking usage…"
      : usage.state === "unknown"
        ? t.usageUnknown || "Usage unknown — no products are cached."
        : usage.products === 0
          ? t.usageNone || "No product uses this entry as an option value."
          : (t.usageKnown || "{products} product(s) use this entry as an option value.").replace(
              "{products}",
              String(usage.products),
            );

  const deleteButton = onDelete ? (
    <Button size="slim" tone="critical" disabled={!!deleteBlockedReason} onClick={onDelete}>
      {t.deleteLabel || "Delete entry"}
    </Button>
  ) : null;

  return (
    <Card padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap={false} gap="200">
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <SwatchPreview name={title} swatch={swatch} />
            <BlockStack gap="050">
              <InlineStack gap="150" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  {title}
                </Text>
                {justCreated && <Badge tone="success">{t.createdBadge || "Just created"}</Badge>}
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                {handle ? `${t.handleLabel || "Handle"}: ${handle}` : entryId.split("/").pop()}
              </Text>
            </BlockStack>
          </InlineStack>

          {deleteButton && (
            // A DISABLED control dispatches no pointer events, so a bare
            // Tooltip around it never opens — the wrapper span is what makes
            // the reason readable at all.
            deleteBlockedReason ? (
              <Tooltip content={deleteBlockedReason} dismissOnMouseOut preferredPosition="below">
                <span style={{ display: "inline-block" }}>{deleteButton}</span>
              </Tooltip>
            ) : (
              deleteButton
            )
          )}
        </InlineStack>

        {readOnlyReason && (
          <Text as="p" variant="bodySm" tone="subdued">
            {readOnlyReason === "refused"
              ? t.readOnlyDefinition || "This app cannot change entries of this definition."
              : t.readOnlyUnknown || "Whether this definition is writable is unknown — reload to find out."}
          </Text>
        )}

        {children.length > 0 ? (
          <BlockStack gap="300">{children}</BlockStack>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            {t.noEditableFields || "None of this entry's fields can be edited here."}
          </Text>
        )}

        {unsupportedFields.length > 0 && (
          <BlockStack gap="050">
            <Text as="span" variant="bodySm" fontWeight="medium" tone="subdued">
              {t.unsupportedTitle || "Not editable here"}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {unsupportedFields.map((f) => `${f.label} (${f.fieldType || "?"})`).join(", ")}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {t.unsupportedHint || "This app has no editor for these field types. Edit them in the Shopify admin."}
            </Text>
          </BlockStack>
        )}

        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="bodySm" tone="subdued">
            {usageLine}
          </Text>
          {usage?.state === "unknown" && onSyncProducts && (
            <Button size="micro" variant="plain" onClick={onSyncProducts}>
              {t.syncProducts || "Sync products"}
            </Button>
          )}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
