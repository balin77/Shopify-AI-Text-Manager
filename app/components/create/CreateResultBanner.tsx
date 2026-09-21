/**
 * PLAN_CONTENT_CREATION §1.6 — what the merchant sees after a create that had
 * MORE to report than its own success.
 *
 * The plain case does not come here at all: it reports through the app-wide
 * InfoBox like a delete or a duplicate do (`createResultNeedsDetail` is the
 * one predicate, and `UnifiedContentEditor` asks it). A banner unfolding at
 * the bottom of the page to say one sentence was the odd one out among the
 * three, and it has no history — once dismissed that sentence was gone, while
 * the InfoBox keeps it in the bell.
 *
 * The load-bearing case is the one that looks like a failure and is not: the
 * object EXISTS on Shopify but the cache sync did not pick it up. Reporting
 * that as an error is what produces a second click and therefore a duplicate —
 * and the created thing is deletable from its own card (§0.1). So it reads
 * "created, will appear after a reload" with a reload button, never "failed".
 *
 * The handle is shown only where Shopify assigned a DIFFERENT one than the
 * merchant typed. On a collision it appends `-1` (§1.7), and someone looking
 * for the handle they entered would not find it — but a merchant who left the
 * field empty asked for no particular handle, and printing the derived one at
 * them is what gave every single create a detail line to render.
 *
 * The chained translate-all (§2.5a) does NOT report here either: it goes to
 * the InfoBox beside the create's own success, so one create speaks with one
 * voice. Its FAILURE comes back as a warning code, which is what puts this
 * banner up in the first place.
 *
 * There is deliberately NO undo. It was the §1.8 seam and it earned its
 * removal: what was just created is deletable from its own card with the same
 * confirmation, so a second path to that delete only put a destructive button
 * on a SUCCESS banner.
 */

import { Banner, BlockStack, Text, InlineStack, Button } from "@shopify/polaris";
import type { CreatedItemInfo } from "~/hooks/useCreateItem";
import { createNoteText } from "~/utils/create-note-message";

export interface CreateResultBannerProps {
  info: CreatedItemInfo;
  onDismiss: () => void;
  /** Offered when the cache did not pick the new item up. */
  onReload?: () => void;
  /** §1.8 — routed through the ONE delete path, with its two-step
   *  confirmation. Absent (e.g. after a failed sync, where there is no
   *  confirmed id to remove) means the action is simply not offered. */
  t?: {
    createdTitle?: string;
    createdNotSyncedTitle?: string;
    createdNotSyncedBody?: string;
    handleChanged?: string;
    reload?: string;
    /** Keyed by `CreatedItemInfo.warningCodes` entries. */
    warnings?: Record<string, string>;
    /** Keyed by `CreateNote.code` — the bundle's `content.createNotes`. */
    notes?: Record<string, string>;
  };
}

export function CreateResultBanner({ info, onDismiss, onReload, t = {} }: CreateResultBannerProps) {
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

        {info.handleChanged && info.handle && (
          <Text as="p" tone="subdued">
            {(t.handleChanged || "Shopify stored the handle as “{handle}”.").replace(
              "{handle}",
              info.handle,
            )}
          </Text>
        )}

        {/* Both lists are CODES phrased here. The notes used to arrive as
            finished English sentences from the write path, which is what a
            German shop read at the one moment something had gone wrong. */}
        {info.notes.map((note, i) => (
          <Text as="p" key={i} tone="subdued">{createNoteText(note, t.notes)}</Text>
        ))}


        {(info.warningCodes ?? []).map((code) => (
          <Text as="p" key={code} tone="subdued">{t.warnings?.[code] || code}</Text>
        ))}

        {onReload && !info.synced && (
          <InlineStack gap="200">
            <Button onClick={onReload}>{t.reload || "Reload"}</Button>
          </InlineStack>
        )}
      </BlockStack>
    </Banner>
  );
}
