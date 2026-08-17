/**
 * PLAN_CONTENT_CREATION §1.6 — what the merchant sees right after a create.
 *
 * The load-bearing case is the one that looks like a failure and is not: the
 * object EXISTS on Shopify but the cache sync did not pick it up. Reporting
 * that as an error is what produces a second click and therefore a duplicate —
 * and this app has no content delete to undo one with (§0.1). So it reads
 * "created, will appear after a reload" with a reload button, never "failed".
 *
 * The handle shown is the one Shopify ACTUALLY assigned. On a collision it
 * appends `-1` (§1.7), and a merchant who later looks for the handle they typed
 * would not find it.
 *
 * `onUndo` is the seam for §1.8. That decision is deliberately still open, so
 * the prop is optional and the banner simply omits the action until it lands —
 * rather than the banner having to be rebuilt around it later.
 */

import { Banner, BlockStack, Text, InlineStack, Button, Spinner } from "@shopify/polaris";
import type { CreatedItemInfo } from "~/hooks/useCreateItem";

export interface CreateResultBannerProps {
  info: CreatedItemInfo;
  onDismiss: () => void;
  /** Offered when the cache did not pick the new item up. */
  onReload?: () => void;
  /** §1.8 — routed through the ONE delete path, with its two-step
   *  confirmation. Absent (e.g. after a failed sync, where there is no
   *  confirmed id to remove) means the action is simply not offered. */
  onUndo?: () => void;
  undoLabel?: string;
  /** §2.5a — the chained translate-all has not answered yet. */
  translating?: boolean;
  t?: {
    createdTitle?: string;
    createdNotSyncedTitle?: string;
    createdNotSyncedBody?: string;
    handleChanged?: string;
    reload?: string;
    undo?: string;
    translating?: string;
    /** Keyed by `CreatedItemInfo.warningCodes` entries. */
    warnings?: Record<string, string>;
  };
}

export function CreateResultBanner({ info, onDismiss, onReload, onUndo, undoLabel, translating = false, t = {} }: CreateResultBannerProps) {
  const name = info.title || info.id;

  return (
    <Banner
      tone={info.synced ? "success" : "info"}
      title={
        info.synced
          ? (t.createdTitle || "Created").replace("{name}", name)
          : t.createdNotSyncedTitle || "Created — not visible in the list yet"
      }
      onDismiss={onDismiss}
    >
      <BlockStack gap="200">
        {!info.synced && (
          <Text as="p">
            {t.createdNotSyncedBody ||
              "The item was created in Shopify. Only the local copy is missing — reload to see it. Do not create it a second time."}
          </Text>
        )}

        {/* §2.5a — the chained translate-all. Said here rather than nowhere:
            the item is already created and selectable, so without a line the
            merchant sees an item whose foreign fields fill in by themselves
            some seconds later. Undo stays hidden while it runs — deleting the
            item mid-translation would leave the task writing into nothing. */}
        {translating && (
          <InlineStack gap="200" blockAlign="center">
            <Spinner size="small" />
            <Text as="span" tone="subdued">
              {t.translating || "Translating into your other languages…"}
            </Text>
          </InlineStack>
        )}

        {info.handle && (
          <Text as="p" tone="subdued">
            {(t.handleChanged || "Handle: {handle}").replace("{handle}", info.handle)}
          </Text>
        )}

        {info.notes.map((note, i) => (
          <Text as="p" key={i} tone="subdued">{note}</Text>
        ))}

        {/* CODES decided client-side, phrased here — `notes` above arrive from
            the server already phrased, these would be English otherwise. */}
        {(info.warningCodes ?? []).map((code) => (
          <Text as="p" key={code} tone="subdued">{t.warnings?.[code] || code}</Text>
        ))}

        {(onReload || onUndo) && (
          <InlineStack gap="200">
            {!info.synced && onReload && (
              <Button onClick={onReload}>{t.reload || "Reload"}</Button>
            )}
            {onUndo && !translating && (
              <Button tone="critical" variant="plain" onClick={onUndo}>
                {undoLabel || t.undo || "Undo this create"}
              </Button>
            )}
          </InlineStack>
        )}
      </BlockStack>
    </Banner>
  );
}
