/**
 * PLAN_CONTENT_CREATION §1.9 — naming the copy.
 *
 * One field, because that is genuinely all Shopify needs: `productDuplicate`
 * and `collectionDuplicate` carry everything else across themselves. Asking
 * for more here would only invite the merchant to edit a copy that does not
 * exist yet.
 *
 * The title is required and pre-filled with "… (copy)". Shopify would happily
 * accept the source's exact title, and the merchant would end up with two
 * identical rows in the list and no way to tell which is which.
 */

import { Modal, BlockStack, Text, TextField, Banner } from "@shopify/polaris";

export interface DuplicateItemModalTexts {
  title?: string;
  intro?: string;
  newTitleLabel?: string;
  cancel?: string;
  confirm?: string;
  draftNote?: string;
}

export interface DuplicateItemModalProps {
  open: boolean;
  onClose: () => void;
  sourceTitle: string;
  newTitle: string;
  onNewTitleChange: (value: string) => void;
  onConfirm: () => void;
  submitting?: boolean;
  error?: string | null;
  t?: DuplicateItemModalTexts;
}

export function DuplicateItemModal({
  open,
  onClose,
  sourceTitle,
  newTitle,
  onNewTitleChange,
  onConfirm,
  submitting = false,
  error,
  t = {},
}: DuplicateItemModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={(t.title || "Duplicate “{name}”").replace("{name}", sourceTitle)}
      primaryAction={{
        content: t.confirm || "Duplicate",
        onAction: onConfirm,
        loading: submitting,
        disabled: submitting || newTitle.trim().length === 0,
      }}
      secondaryActions={[{ content: t.cancel || "Cancel", onAction: onClose, disabled: submitting }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {error && (
            <Banner tone="critical">
              <p>{error}</p>
            </Banner>
          )}

          <Text as="p" tone="subdued">
            {t.intro ||
              "Shopify copies everything — images, variants, options and metafields. You only need a name."}
          </Text>

          <TextField
            label={t.newTitleLabel || "Title of the copy"}
            value={newTitle}
            onChange={onNewTitleChange}
            autoComplete="off"
            disabled={submitting}
          />

          <Text as="p" tone="subdued">
            {t.draftNote || "The copy is created as a draft — it does not go live on its own."}
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
