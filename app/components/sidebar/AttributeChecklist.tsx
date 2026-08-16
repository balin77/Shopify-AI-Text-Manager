/**
 * PLAN_CONTENT_CREATION §2 — the "Attributes" sidebar tab.
 *
 * Shows the NON-SEO completeness of an item: status, channels, tags, vendor,
 * category, membership, price. Disjoint from the score tab by construction
 * (§0.6) — that one judges title length, SEO title, descriptions and alt-text
 * coverage, none of which appears here.
 *
 * ── Two rules the rendering has to keep ─────────────────────────────────────
 * 1. "Unknown" is not a quiet "missing". A row whose data has never been
 *    synced renders grey with its own explanation and a reload, because the
 *    alternative — red — is a confident wrong answer for every shop that has
 *    not re-synced since Phase 0. The judgement lives in
 *    `attribute-checklist.shared.ts`; this file only paints it.
 * 2. In a FOREIGN locale the whole tab is read-only with a reason. Tags,
 *    vendor and category are not translatable (only title, body_html, handle,
 *    meta_*, summary_html and product_type are), so a merchant acting on a
 *    finding here while a translation is selected would be editing the primary
 *    value from a screen that says otherwise — the "lost save" feeling §2.4
 *    warns about.
 */

import { BlockStack, InlineStack, Text, Button, Banner, Box } from "@shopify/polaris";
import type { AttributeRow, AttributeStatus } from "~/services/attribute-checklist.shared";

export interface AttributeChecklistTexts {
  heading?: string;
  unknownBanner?: string;
  reload?: string;
  foreignLocale?: string;
  adminHint?: string;
  /** Row labels, keyed like the row's `key`. */
  rows?: Record<string, string>;
  /** Status words for the value column when there is no value to show. */
  statuses?: Partial<Record<AttributeStatus, string>>;
}

export interface AttributeChecklistProps {
  rows: AttributeRow[];
  /** True when a reload would actually change something (§2.4). */
  needsSync: boolean;
  onReload?: () => void;
  /** Set in a foreign locale — the whole tab goes read-only with this reason. */
  readOnlyReason?: string | null;
  /** Phase 3 wires this to focus the field; absent means rows are not clickable. */
  onJumpToField?: (field: string) => void;
  adminUrl?: string;
  t?: AttributeChecklistTexts;
}

const DOT: Record<AttributeStatus, { color: string; label: string }> = {
  ok: { color: "#008060", label: "✓" },
  missing: { color: "#d72c0d", label: "✗" },
  warning: { color: "#b98900", label: "!" },
  // Grey and hollow: it reads as "not looked at", which is what it means.
  unknown: { color: "#8c9196", label: "?" },
};

export function AttributeChecklist({
  rows,
  needsSync,
  onReload,
  readOnlyReason,
  onJumpToField,
  adminUrl,
  t = {},
}: AttributeChecklistProps) {
  return (
    <BlockStack gap="300">
      {readOnlyReason && (
        <Banner tone="info">
          <p>{readOnlyReason}</p>
        </Banner>
      )}

      {needsSync && (
        <Banner tone="warning">
          <BlockStack gap="200">
            <Text as="p">
              {t.unknownBanner ||
                "These details have not been fetched for this item yet. Reload it to see them — the grey entries are unknown, not missing."}
            </Text>
            {onReload && <Button onClick={onReload}>{t.reload || "Reload this item"}</Button>}
          </BlockStack>
        </Banner>
      )}

      <BlockStack gap="100">
        {rows.map((row) => {
          const dot = DOT[row.status];
          const label = t.rows?.[row.key] ?? row.key;
          const clickable = !readOnlyReason && !!row.jumpToField && !!onJumpToField && row.status !== "unknown";

          const content = (
            <InlineStack gap="200" blockAlign="center" wrap={false}>
              <span
                aria-hidden
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  flexShrink: 0,
                  color: "white",
                  background: dot.color,
                  fontSize: 11,
                  lineHeight: 1,
                }}
              >
                {dot.label}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text as="span" variant="bodySm" truncate>{label}</Text>
              </div>
              {row.value !== undefined && (
                <Text as="span" variant="bodySm" tone="subdued">{row.value}</Text>
              )}
              {row.value === undefined && row.status === "unknown" && (
                <Text as="span" variant="bodySm" tone="subdued">
                  {t.statuses?.unknown || "unknown"}
                </Text>
              )}
            </InlineStack>
          );

          return (
            <Box key={row.key} paddingBlock="050">
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onJumpToField!(row.jumpToField!)}
                  style={{
                    width: "100%",
                    background: "none",
                    border: "none",
                    padding: 0,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  {content}
                </button>
              ) : (
                content
              )}
              {/* Only where the merchant genuinely has to leave — a row we
                  cannot resolve here says so instead of looking broken. */}
              {row.adminOnly && adminUrl && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {t.adminHint || "Only visible in the Shopify admin."}
                </Text>
              )}
            </Box>
          );
        })}
      </BlockStack>
    </BlockStack>
  );
}
