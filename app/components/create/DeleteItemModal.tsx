/**
 * Two-step confirmation for deleting a content object.
 *
 * Asking twice is not ceremony here. This is the app's first irreversible
 * action: it removes something from the merchant's LIVE shop, there is no
 * trash to fish it back out of, and — unlike every other destructive control
 * in this app — no next sync repairs it. A single "are you sure?" is the same
 * muscle-memory click as a save dialog.
 *
 * So:
 *   Step 1 — WHAT goes away, including the parts that are easy to forget:
 *            every translation, the keyword assignment, and for a blog every
 *            article inside it.
 *   Step 2 — type the item's name. Not a puzzle: it is the one interaction
 *            that cannot be completed by reflex, and it makes the merchant
 *            read the name of the thing they are about to remove. That is
 *            precisely the mistake being guarded against — deleting the item
 *            that happened to be selected rather than the one they meant.
 *
 * Cancel is the primary-looking path throughout, and the final button is the
 * only destructive-toned control in the dialog.
 */

import { useCallback, useEffect, useState } from "react";
import { Modal, BlockStack, Text, TextField, List, Banner } from "@shopify/polaris";

export interface DeleteItemModalTexts {
  step1Title?: string;
  step2Title?: string;
  intro?: string;
  /** Rendered as the consequence list. */
  consequenceTranslations?: string;
  consequenceKeyword?: string;
  consequenceIrreversible?: string;
  /** Blog-only: articles go with it. */
  consequenceBlogArticles?: string;
  /** Metaobject-only: products may reference the entry as an option value. */
  consequenceMetaobjectUsage?: string;
  /** The TYPE takes its entries with it, and Shopify does not ask about them. */
  consequenceMetaobjectDefinitionEntries?: string;
  consequenceMetaobjectDefinitionOptions?: string;
  confirmPrompt?: string;
  mismatch?: string;
  cancel?: string;
  next?: string;
  confirm?: string;
  deleting?: string;
}

export interface DeleteItemModalProps {
  open: boolean;
  onClose: () => void;
  /** What is being removed, and what it is called. */
  item: { id: string; title: string; resource: string; /** Entries that go with a deleted TYPE. */ cascadeCount?: number };
  onConfirm: () => void;
  deleting?: boolean;
  error?: string | null;
  t?: DeleteItemModalTexts;
}

export function DeleteItemModal({ open, onClose, item, onConfirm, deleting = false, error, t = {} }: DeleteItemModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");

  // Re-opening on a different item must not inherit the previous answer —
  // otherwise a merchant who typed a name once could delete the NEXT item
  // with a single click.
  useEffect(() => {
    if (open) {
      setStep(1);
      setTyped("");
    }
  }, [open, item.id]);

  const expected = (item.title || "").trim();
  // Case- and whitespace-insensitive: the point is that the merchant read the
  // name, not that they can reproduce its capitalisation.
  const matches = expected.length > 0 && typed.trim().toLowerCase() === expected.toLowerCase();

  const handleClose = useCallback(() => {
    if (deleting) return;
    onClose();
  }, [deleting, onClose]);

  if (step === 1) {
    return (
      <Modal
        open={open}
        onClose={handleClose}
        title={(t.step1Title || "Delete “{name}”?").replace("{name}", item.title || item.id)}
        primaryAction={{
          content: t.next || "Continue",
          destructive: true,
          onAction: () => setStep(2),
        }}
        secondaryActions={[{ content: t.cancel || "Cancel", onAction: handleClose }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              {t.intro || "This removes the item from your Shopify store, not just from this app."}
            </Text>
            <List>
              {item.resource === "blog" && (
                <List.Item>
                  {t.consequenceBlogArticles || "Every article in this blog is deleted with it."}
                </List.Item>
              )}
              {/* A metaobject entry can be a product's option VALUE. MEASURED
                  (PLAN_METAOBJECTS_EDITOR V5, 2026-08-19): Shopify REFUSES the
                  delete while anything still references it, so no option value
                  and no variant can be destroyed here. The line therefore says
                  what actually happens instead of naming a worst case that
                  cannot occur — an invented consequence is not a safer warning,
                  it is a false one. */}
              {/* Deleting a DEFINITION cascades to every entry of that type,
                  and Shopify neither asks nor reports how many. The count is
                  the app's, from what it has cached — which is why the line
                  says "known" rather than presenting a cache read as the
                  shop's truth. */}
              {item.resource === "metaobjectDefinition" && (
                <>
                  <List.Item>
                    <Text as="span" fontWeight="semibold">
                      {(t.consequenceMetaobjectDefinitionEntries ||
                        "Every entry of this type is deleted with it ({count} known here).").replace(
                        "{count}",
                        String(item.cascadeCount ?? 0),
                      )}
                    </Text>
                  </List.Item>
                  {/* The entries can be product option VALUES with storefront
                      swatches hanging off them. The per-entry delete refuses a
                      known usage and says so; deleting the whole type is the
                      same question asked about all of them at once, so it says
                      the same thing rather than letting the merchant find out
                      from the catalogue afterwards. */}
                  <List.Item>
                    {t.consequenceMetaobjectDefinitionOptions ||
                      "Entries of this type can be product option values with storefront swatches. Anything still using one is refused — remove it there first."}
                  </List.Item>
                </>
              )}
              {item.resource === "metaobject" && (
                <List.Item>
                  {t.consequenceMetaobjectUsage ||
                    "Shopify refuses to delete an entry that a product still uses as an option value — remove it there first."}
                </List.Item>
              )}
              <List.Item>{t.consequenceTranslations || "All translations of this item are deleted."}</List.Item>
              <List.Item>{t.consequenceKeyword || "Its keyword assignment is removed."}</List.Item>
              <List.Item>
                <Text as="span" fontWeight="semibold">
                  {t.consequenceIrreversible || "This cannot be undone."}
                </Text>
              </List.Item>
            </List>
          </BlockStack>
        </Modal.Section>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t.step2Title || "Confirm deletion"}
      primaryAction={{
        content: deleting ? t.deleting || "Deleting…" : t.confirm || "Delete permanently",
        destructive: true,
        loading: deleting,
        disabled: !matches || deleting,
        onAction: onConfirm,
      }}
      secondaryActions={[{ content: t.cancel || "Cancel", onAction: handleClose, disabled: deleting }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {error && (
            <Banner tone="critical">
              <p>{error}</p>
            </Banner>
          )}
          <Text as="p">
            {(t.confirmPrompt || "Type “{name}” to confirm.").replace("{name}", expected)}
          </Text>
          <TextField
            label={expected}
            labelHidden
            value={typed}
            onChange={setTyped}
            autoComplete="off"
            disabled={deleting}
            error={typed.trim().length > 0 && !matches ? t.mismatch || "That does not match." : undefined}
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
