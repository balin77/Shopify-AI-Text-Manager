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

import { useEffect, useMemo, useState } from "react";
import { ChipCombobox } from "./ChipCombobox";
import { BlockStack, Banner, Box, Button, Checkbox, Spinner, Text, TextField } from "@shopify/polaris";
import type { CollectionOption } from "../../routes/api.product-taxonomy";

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
  disabled,
  t,
}: CollectionsFieldProps) {
  const [options, setOptions] = useState<CollectionOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  /** The cache holds more collections than one page — see the route's cap. */
  const [listTruncated, setListTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/product-taxonomy?kind=collections")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        // An empty list from a FAILED lookup would read as "this shop has no
        // collections" and invite the merchant to untick everything.
        if (!data?.success) {
          setFailed(true);
          return;
        }
        setOptions((data.collections ?? []) as CollectionOption[]);
        // Said, not swallowed: a shop with more collections than the page gets
        // the first N alphabetically, and a merchant looking for "Winter Sale"
        // would otherwise conclude it does not exist.
        setListTruncated(data.truncated === true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(
    () => new Set(value.split(",").map((id) => id.trim()).filter(Boolean)),
    [value],
  );

  /**
   * The shop's collections UNION the product's own memberships.
   *
   * The union is the point: a membership whose collection the cache never
   * stored (plan cap) would otherwise be invisible here — and invisible means
   * unticked, which the diff reads as "remove it".
   */
  const rows = useMemo(() => {
    const byId = new Map<string, CollectionOption>();
    for (const option of options ?? []) byId.set(option.id, option);
    for (const membership of memberships) {
      const existing = byId.get(membership.collectionId);
      byId.set(membership.collectionId, {
        id: membership.collectionId,
        title: existing?.title || membership.collectionTitle || membership.collectionId,
        // The MEMBERSHIP's own flag wins where it KNOWS; otherwise the shop
        // list's answer. `null` from both stays null, which renders locked —
        // unknown is not manual, and the server refuses it either way.
        automated: membership.automated ?? existing?.automated ?? null,
      });
    }
    return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [options, memberships]);

  if (!known) {
    return (
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">{label}</Text>
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
      <Text as="p" variant="bodyMd">{label}</Text>

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

      {/* One line plus the memberships that are actually set. It used to print
          a checkbox row per collection IN THE SHOP — on a shop with fifty of
          them, the product's own text started below the fold. */}
      <ChipCombobox
        label={label}
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

    </BlockStack>
  );
}
