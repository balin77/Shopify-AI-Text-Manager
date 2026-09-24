/**
 * PLAN_CONTENT_CREATION §Phase 3.1 — which collections a product belongs to.
 *
 * ── Rule-based memberships are shown, never offered ─────────────────────────
 * A smart collection decides its own members. Unticking one here would look
 * like it worked and the rule would put the product back within seconds — a
 * save that apparently did nothing, which is the worst outcome this app has a
 * name for. So an automated membership renders as a locked row with the reason
 * next to it, and the server refuses to leave one even if the request is
 * hand-made (the action is reachable by POST).
 *
 * ── Memberships the cache does not know ─────────────────────────────────────
 * The collection cache is capped by the merchant's plan, so a product can
 * belong to a collection this shop never cached. Its title comes from
 * `ProductCollection.collectionTitle`, mirrored per membership for exactly
 * this case. It is still ticked, still shown, and — crucially — still sent
 * back: the write is a JOIN/LEAVE diff, so a membership left out of the list
 * would be read as "the merchant removed it".
 *
 * ── Truncation is a fact, not a silence ─────────────────────────────────────
 * `hasMoreCollections` says the sync's window cut the list off. Then this
 * picker cannot be complete, and it says so rather than presenting a partial
 * list as the whole truth.
 */

import { useMemo } from "react";
import { useShopCollections } from "../../hooks/useShopCollections";
import { ChipCombobox } from "./ChipCombobox";
import { FieldLabel } from "./FieldChrome";
import { BlockStack, Banner, Box, Button, Checkbox, Spinner, Text, TextField } from "@shopify/polaris";
import { collectionPickerRows } from "../../services/collection-picker.shared";
import type { CollectionOption } from "../../routes/api.product-taxonomy";
import { useI18n } from "../../contexts/I18nContext";
import { compareStrings } from "../../utils/format";

export interface ProductMembership {
  collectionId: string;
  collectionTitle: string;
  /** `null` ⇒ the collection row was never attribute-synced — unknown, which
   *  this picker treats as locked. See `diffCollectionMembership`. */
  automated: boolean | null;
}

export interface CollectionsFieldProps {
  /** Comma-joined collection GIDs — the membership as it now stands. */
  value: string;
  onChange: (value: string) => void;
  /** The product's CURRENT memberships from the cache, automated ones included. */
  memberships: ProductMembership[];
  /** True when the sync's window cut the membership list off. */
  truncated: boolean;
  /** False ⇒ the row was never attribute-synced; nothing here is known. */
  known: boolean;
  /** The way OUT of that state — the same affordance `AttributeField` offers. */
  onReload?: () => void;
  label: string;
  /** Key into `t.help` — handed to the combobox that draws the label. */
  helpKey?: string;
  disabled?: boolean;
  t: {
    filter?: string;
    loading?: string;
    reload?: string;
    automatedUnknown?: string;
    lookupFailed?: string;
    automated?: string;
    truncated?: string;
    listTruncated?: string;
    unknown?: string;
    foreignLocale?: string;
    none?: string;
  };
}

export function CollectionsField({
  value,
  onChange,
  memberships,
  truncated,
  known,
  onReload,
  label,
  helpKey,
  disabled,
  t,
}: CollectionsFieldProps) {
  // Collection titles are merchant content and this sort decides the ORDER of
  // server-rendered rows (`memberships` is loader data, so rows exist before
  // the client fetch fills `options`) — see compareStrings().
  const { locale: appLocale } = useI18n();
  // The list is SHARED with the bulk grid's collections cell (one request per
  // page, not per picker). A failed lookup is its own state: an empty list
  // would read as "this shop has no collections" and invite the merchant to
  // untick everything.
  const loaded = useShopCollections();
  const options: CollectionOption[] | null = loaded?.ok ? loaded.collections : null;
  const failed = loaded !== null && !loaded.ok;
  // Said, not swallowed: a shop with more collections than the page gets the
  // first N alphabetically, and a merchant looking for "Winter Sale" would
  // otherwise conclude it does not exist.
  const listTruncated = loaded?.ok === true && loaded.truncated;

  const selected = useMemo(
    () => new Set(value.split(",").map((id) => id.trim()).filter(Boolean)),
    [value],
  );

  /**
   * The shop's collections UNION the product's own memberships — the rule
   * lives in `collectionPickerRows`, shared with the bulk grid's collections
   * cell so the two pickers cannot come to lock different rows.
   */
  const rows = useMemo(
    () =>
      collectionPickerRows(options, memberships).sort((a, b) =>
        compareStrings(a.title, b.title, appLocale),
      ),
    [options, memberships, appLocale],
  );

  if (!known) {
    return (
      <BlockStack gap="200">
        <FieldLabel label={label} helpKey={helpKey} />
        <Text as="p" variant="bodySm" tone="subdued">
          {t.unknown || "Not loaded yet — reload this product to see its collections."}
        </Text>
        {/* The affordance, not just the sentence — the same one every other
            attribute offers in this state. */}
        {onReload && (
          <Box><Button onClick={onReload}>{t.reload || "Reload"}</Button></Box>
        )}
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="200">
      {/* One line plus the memberships that are actually set. It used to print
          a checkbox row per collection IN THE SHOP — on a shop with fifty of
          them, the product's own text started below the fold.

          No label here — the combobox renders it. Two of them stacked is what
          the first cut showed.

          It comes FIRST, and the qualifications about the list follow it. They
          used to stand between the label and the control, which pushed this
          field's input box a banner's height below the plain text field beside
          it; the Details card is one row of boxes that are meant to line up,
          and a banner is exactly the kind of thing that only appears on some
          shops, so the misalignment came and went. */}
      <ChipCombobox
        label={label}
        helpKey={helpKey}
        selected={[...selected]}
        options={rows.map((row) => ({
          value: row.id,
          label: row.title,
          // Rule-based AND unknown are both locked, and for the same reason in
          // both directions: joining sends a `collectionsToJoin` Shopify
          // refuses — and because `productUpdate` is atomic, that refusal takes
          // the merchant's text edits with it — while leaving one is undone by
          // the rule within seconds.
          lockedReason:
            row.automated === true
              ? t.automated || "Managed by this collection's rules"
              : row.automated === null
                ? t.automatedUnknown || "Not loaded from Shopify yet — reload the collections to change this."
                : undefined,
        }))}
        onChange={(next) => onChange(next.join(","))}
        readOnly={disabled}
        // A collection this app does not know is not one it can join: the id
        // has to exist before it can be sent.
        allowFreeText={false}
        placeholder={t.filter || "Search collections…"}
      />

      {failed && (
        <Banner tone="warning">
          <p>{t.lookupFailed || "The collection list could not be loaded, so only the current memberships are shown."}</p>
        </Banner>
      )}

      {truncated && (
        <Banner tone="info">
          <p>{t.truncated || "This product is in more collections than were loaded. Manage the rest in the Shopify admin."}</p>
        </Banner>
      )}

      {listTruncated && (
        <Banner tone="info">
          <p>{t.listTruncated || "This shop has more collections than are listed here. Use the filter, or manage the rest in the Shopify admin."}</p>
        </Banner>
      )}

      {options === null && !failed && (
        <Spinner size="small" accessibilityLabel={t.loading || "Loading collections"} />
      )}

      {rows.length === 0 && options !== null && !failed && (
        <Text as="p" variant="bodySm" tone="subdued">{t.none || "This shop has no collections yet."}</Text>
      )}
    </BlockStack>
  );
}
