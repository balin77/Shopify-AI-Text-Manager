/**
 * "Manage publishing" — the dialog behind the Details card's sales-channel row.
 *
 * Shopify's own admin puts this behind an icon next to "Veröffentlichung", and
 * for the same reason: a shop with markets and B2B catalogs has three lists of
 * toggles, which is a page's worth of controls inside a card that is meant to
 * be read at a glance. The card now states WHERE the product is published; the
 * dialog is where that is changed.
 *
 * ── It owns no state and no save ────────────────────────────────────────────
 * The toggles write straight into the same `channelState` the card used to
 * hold, and the editor's ONE save bar writes it — the dialog has no Save of
 * its own. Two save buttons on one screen is a question the merchant has to
 * answer ("did that one include my text?"), and the answer was no. "Fertig"
 * therefore only closes: nothing is committed or discarded by it, which is
 * also why closing with the X is the same thing.
 */

import { BlockStack, Checkbox, InlineStack, Modal, Text } from "@shopify/polaris";
import { groupPublications, type PublicationGroupId } from "../../services/commerce-sync.shared";
import type { CommerceChannelView } from "../../routes/api.product-commerce";

export interface PublishingModalTexts {
  title: string;
  done: string;
  headings: Record<PublicationGroupId, string>;
  /** Shown under a heading; the sales-channel list has none — it needs none. */
  hints: Partial<Record<PublicationGroupId, string>>;
  /** `{date}` is replaced with the localized publish date. */
  scheduled: string;
  noChannels: string;
  truncated: string;
}

interface PublishingModalProps {
  open: boolean;
  onClose: () => void;
  channels: CommerceChannelView[];
  /** True ⇒ the loaded window was cut off; the lists are not the whole shop. */
  truncated: boolean;
  channelState: Record<string, boolean>;
  setChannelState: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  /** A save is in flight — the toggles must not move under it. */
  saving: boolean;
  t: PublishingModalTexts;
}

export function PublishingModal({
  open,
  onClose,
  channels,
  truncated,
  channelState,
  setChannelState,
  saving,
  t,
}: PublishingModalProps) {
  const groups = groupPublications(channels);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.title}
      primaryAction={{ content: t.done, onAction: onClose }}
    >
      <Modal.Section>
        <BlockStack gap="500">
          {truncated && (
            <Text as="p" variant="bodySm" tone="subdued">{t.truncated}</Text>
          )}

          {groups.map((group) => (
            <BlockStack gap="200" key={group.id}>
              <Text as="h3" variant="headingSm">{t.headings[group.id]}</Text>

              {t.hints[group.id] && (
                <Text as="p" variant="bodySm" tone="subdued">{t.hints[group.id]}</Text>
              )}

              {group.rows.length === 0 ? (
                <Text as="p" variant="bodySm" tone="subdued">{t.noChannels}</Text>
              ) : (
                <BlockStack gap="200">
                  {group.rows.map((channel) => (
                    <InlineStack key={channel.publicationId} gap="200" blockAlign="center">
                      <Checkbox
                        label={channel.name || channel.publicationId}
                        checked={channelState[channel.publicationId] === true}
                        disabled={saving}
                        // A future publish date is NOT "live". Saying
                        // "scheduled" rather than showing it as published is
                        // what keeps a planned launch from looking like a
                        // mistake.
                        helpText={
                          channel.publishDate && !channel.isPublished
                            ? t.scheduled.replace("{date}", new Date(channel.publishDate).toLocaleDateString())
                            : undefined
                        }
                        onChange={(checked) =>
                          setChannelState((prev) => ({ ...prev, [channel.publicationId]: checked }))
                        }
                      />
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          ))}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
