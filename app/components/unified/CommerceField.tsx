/**
 * PLAN_CONTENT_CREATION Phase 4 — stock and sales channels in the editor.
 *
 * ── It loads LIVE, and it says when ─────────────────────────────────────────
 * Stock is volatile: orders, returns and other apps move it between two page
 * loads. So this fetches on open rather than reading the cache, and the number
 * next to each input is the one the save COMPARES against. If it moved in the
 * meantime, Shopify refuses the write and the merchant is told the number
 * changed instead of overwriting someone else's arithmetic.
 *
 * ── Three states, not two ───────────────────────────────────────────────────
 *   tracked === true  → a number, editable
 *   tracked === false → Shopify keeps no count. Not zero. Showing 0 would tell
 *                       a merchant they are sold out of something they can
 *                       sell without limit.
 *   tracked === null  → never synced. Neither of the above is known, so it says
 *                       so and offers the reload.
 *
 * ── §2.3, made visible ──────────────────────────────────────────────────────
 * `status: ACTIVE` is not visibility. A product active but published to no
 * channel is invisible everywhere, and the Shopify admin does not say so on the
 * product page either. The channel list is the whole reason that trap has a
 * cure here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Checkbox,
  InlineStack,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";

/** Shopify's `WeightUnit` enum — an unknown value fails at the SCHEMA level. */
const WEIGHT_UNITS = ["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"] as const;
import type { CommerceChannelView, CommerceVariantView } from "../../routes/api.product-commerce";

export interface CommerceFieldProps {
  /** The product GID. "" while nothing is selected. */
  productId: string;
  label: string;
  /** False in a foreign locale — stock and channels exist once per product. */
  isPrimaryLocale: boolean;
  /** Strings for this panel, plus the warning CODES the endpoint returns. */
  t: CommerceTexts;
}

export interface CommerceTexts {
  [key: string]: string | Record<string, string> | undefined;
  /** Keyed by `CommerceWarning`. */
  warnings?: Record<string, string>;
}

interface LoadedState {
  variants: CommerceVariantView[];
  variantsTruncated: boolean;
  channels: CommerceChannelView[];
  channelsTruncated: boolean;
}

export function CommerceField({ productId, label, isPrimaryLocale, t }: CommerceFieldProps) {
  const [data, setData] = useState<LoadedState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planBlocked, setPlanBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);

  /**
   * Which variant's box is on screen.
   *
   * ONE box, not one per variant: a product with twenty variants produced
   * twenty stacked boxes of identical fields, and the channel list plus the
   * save button ended up a screen and a half below the first one. Switching is
   * SAFE because every edit is keyed by variant id (`edits`, `itemEdits`) —
   * changing the selection hides a box, it does not discard what was typed in
   * it, and the save still writes every variant that was touched.
   */
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);

  /** Edited on-hand values, keyed `variantId::locationId`. */
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** Ticked channels. Seeded from the load, then owned by the merchant. */
  const [channelState, setChannelState] = useState<Record<string, boolean>>({});
  /**
   * Edited InventoryItem settings, keyed `variantId::field`.
   *
   * Kept as a sparse map rather than a full copy of every field, because the
   * write module distinguishes "absent" (leave alone) from "" (clear) — a full
   * copy would collapse the two and clear whatever the merchant did not touch.
   */
  const [itemEdits, setItemEdits] = useState<Record<string, string>>({});

  /**
   * Bumped per load. A per-call `cancelled` flag only protects the ONE caller
   * that keeps the cleanup — the effect. The button and the post-save reload
   * discarded it, so two overlapping loads raced, and a manual load in flight
   * while the merchant switched products could paint product A's stock under
   * product B's id. The save then addresses A's inventory items. Low
   * probability, real money.
   */
  const loadToken = useRef(0);

  const load = useCallback((options?: { keepEdits?: boolean }) => {
    if (!productId) return;
    const token = ++loadToken.current;
    const keepEdits = options?.keepEdits === true;
    setLoadError(null);
    setPlanBlocked(false);
    setData(null);
    fetch(`/api/product-commerce?productId=${encodeURIComponent(productId)}`)
      .then((r) => r.json())
      .then((body) => {
        if (token !== loadToken.current) return;
        if (!body?.success) {
          // A plan refusal is not a failure — it is a different message, and
          // showing "could not be loaded" for it would send the merchant
          // looking for a bug.
          if (body?.error === "planRequired") setPlanBlocked(true);
          else setLoadError((t.loadFailed as string) || "Stock and channels could not be loaded.");
          return;
        }
        setData({
          variants: body.variants ?? [],
          variantsTruncated: body.variantsTruncated === true,
          channels: body.channels ?? [],
          channelsTruncated: body.channelsTruncated === true,
        });
        // A refused write reloads to SHOW the number that actually moved —
        // and must not also throw away what the merchant typed, or they have
        // to retype it from memory against a number that just changed.
        if (!keepEdits) {
          setEdits({});
          setItemEdits({});
        }
        setChannelState(
          Object.fromEntries((body.channels ?? []).map((c: CommerceChannelView) => [c.publicationId, c.isPublished])),
        );
      })
      .catch(() => {
        if (token !== loadToken.current) return;
        setLoadError((t.loadFailed as string) || "Stock and channels could not be loaded.");
      });
  }, [productId, t.loadFailed]);

  useEffect(() => {
    if (!isPrimaryLocale) return;
    load();
    // Unmounting (or switching products) bumps the token, which is what makes
    // an in-flight answer land nowhere.
    return () => { loadToken.current += 1; };
  }, [load, isPrimaryLocale]);

  /** The loaded on-hand for a cell — also the value the save compares against. */
  const loadedOnHand = useCallback(
    (variantId: string, locationId: string): number | null => {
      const variant = data?.variants.find((v) => v.id === variantId);
      return variant?.levels.find((l) => l.locationId === locationId)?.onHand ?? null;
    },
    [data],
  );

  const dirtyStock = useMemo(
    () =>
      Object.entries(edits).filter(([key, value]) => {
        const [variantId, locationId] = key.split("::");
        const loaded = loadedOnHand(variantId, locationId);
        return value.trim() !== "" && String(loaded ?? "") !== value.trim();
      }),
    [edits, loadedOnHand],
  );

  const dirtyChannels = useMemo(() => {
    if (!data) return { toPublish: [] as string[], toUnpublish: [] as string[] };
    const toPublish: string[] = [];
    const toUnpublish: string[] = [];
    for (const channel of data.channels) {
      const next = channelState[channel.publicationId];
      if (next === channel.isPublished) continue;
      if (next) toPublish.push(channel.publicationId);
      else toUnpublish.push(channel.publicationId);
    }
    return { toPublish, toUnpublish };
  }, [data, channelState]);

  /** The loaded value of an InventoryItem setting — the baseline for "changed". */
  const loadedItemField = useCallback(
    (variantId: string, field: string): string => {
      const variant = data?.variants.find((v) => v.id === variantId);
      if (!variant) return "";
      const value = (variant as unknown as Record<string, unknown>)[field];
      return value == null ? "" : String(value);
    },
    [data],
  );

  const dirtyItemFields = useMemo(
    () =>
      Object.entries(itemEdits).filter(([key, value]) => {
        const [variantId, field] = key.split("::");
        return value !== loadedItemField(variantId, field);
      }),
    [itemEdits, loadedItemField],
  );

  const post = useCallback(async (body: Record<string, string>): Promise<string[]> => {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) form.set(key, value);
    const response = await fetch("/api/product-commerce", { method: "POST", body: form });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || json.success !== true) {
      throw new Error(typeof json?.error === "string" ? json.error : "failed");
    }
    return Array.isArray(json.warnings) ? (json.warnings as string[]) : [];
  }, []);

  /**
   * One submission, its failures isolated.
   *
   * A rejected `post` used to throw out of the whole save loop, so a single
   * bad variant meant the remaining ones were never submitted and the merchant
   * saw one generic "could not be saved" for work that had partly succeeded.
   * Each call now reports for itself, exactly like the per-cell rule the bulk
   * editor follows.
   */
  const postIsolated = useCallback(
    async (body: Record<string, string>, fallback: string): Promise<string[]> => {
      try {
        return await post(body);
      } catch {
        return [fallback];
      }
    },
    [post],
  );

  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setNotices([]);
    const collected: string[] = [];
    try {
      // Grouped per VARIANT: `inventorySetQuantities` is atomic per call, so a
      // merchant editing three locations of one variant cannot end up with one
      // written and two not.
      const byVariant = new Map<string, Array<{ locationId: string; quantity: number; compare: number }>>();
      for (const [key, value] of dirtyStock) {
        const [variantId, locationId] = key.split("::");
        const compare = loadedOnHand(variantId, locationId);
        // No loaded value ⇒ nothing to compare against, and a write without a
        // comparison is exactly the silent overwrite this feature avoids. But
        // it is SAID: dropping a typed quantity with no message, and then
        // clearing the field on the reload, is how a stock correction
        // disappears without anyone noticing.
        if (compare === null) {
          collected.push((t.warnings?.stockNoBaseline as string) || "stockNoBaseline");
          continue;
        }
        const list = byVariant.get(variantId) ?? [];
        list.push({ locationId, quantity: Number.parseInt(value, 10), compare });
        byVariant.set(variantId, list);
      }

      for (const [variantId, list] of byVariant) {
        const variant = data.variants.find((v) => v.id === variantId);
        if (!variant?.inventoryItemId) {
          collected.push(t.warnings?.stockNoInventoryItem || "stockNoInventoryItem");
          continue;
        }
        const warnings = await postIsolated({
          intent: "stock",
          productId,
          variantId,
          changes: JSON.stringify(
            list.map((entry) => ({
              inventoryItemId: variant.inventoryItemId,
              locationId: entry.locationId,
              quantity: String(entry.quantity),
              compareQuantity: String(entry.compare),
            })),
          ),
        }, (t.saveFailed as string) || "The change could not be saved.");
        collected.push(...warnings.map((code) => t.warnings?.[code] || code));
      }

      // InventoryItem settings, grouped per variant — one mutation each.
      const itemsByVariant = new Map<string, Record<string, unknown>>();
      for (const [key, value] of dirtyItemFields) {
        const [variantId, field] = key.split("::");
        const fields = itemsByVariant.get(variantId) ?? {};
        if (field === "weight" || field === "weightUnit") {
          // Value and unit travel TOGETHER: a number with no unit is not a
          // weight, so the untouched half is taken from the loaded value.
          fields.weight = {
            value: field === "weight" ? value : itemEdits[`${variantId}::weight`] ?? loadedItemField(variantId, "weight"),
            unit:
              field === "weightUnit"
                ? value
                : itemEdits[`${variantId}::weightUnit`] ?? (loadedItemField(variantId, "weightUnit") || "KILOGRAMS"),
          };
        } else if (field === "requiresShipping") {
          fields.requiresShipping = value === "true";
        } else {
          fields[field] = value;
        }
        itemsByVariant.set(variantId, fields);
      }

      for (const [variantId, fields] of itemsByVariant) {
        const variant = data.variants.find((v) => v.id === variantId);
        const warnings = await postIsolated(
          {
            intent: "itemFields",
            productId,
            variantId,
            inventoryItemId: variant?.inventoryItemId ?? "",
            fields: JSON.stringify(fields),
          },
          (t.saveFailed as string) || "The change could not be saved.",
        );
        collected.push(...warnings.map((code) => (t.warnings?.[code] as string) || code));
      }

      if (dirtyChannels.toPublish.length > 0 || dirtyChannels.toUnpublish.length > 0) {
        const warnings = await postIsolated(
          {
            intent: "channels",
            productId,
            channels: JSON.stringify({
              ...dirtyChannels,
              names: Object.fromEntries(data.channels.map((c) => [c.publicationId, c.name])),
            }),
          },
          (t.saveFailed as string) || "The change could not be saved.",
        );
        collected.push(...warnings.map((code) => t.warnings?.[code] || code));
      }
    } finally {
      setSaving(false);
    }
    setNotices(collected);
    // Reload either way. On success it confirms; on a refused write it shows
    // the number that actually moved — and then KEEPS the merchant's input,
    // because that is exactly the case where they need it.
    load({ keepEdits: collected.length > 0 });
  }, [data, dirtyStock, dirtyChannels, dirtyItemFields, itemEdits, loadedItemField, loadedOnHand, postIsolated, productId, load, t]);

  if (!isPrimaryLocale) {
    return (
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">{label}</Text>
        <Banner tone="info">
          <p>{(t.foreignLocale as string) || "Stock and sales channels exist once per product, not per language."}</p>
        </Banner>
      </BlockStack>
    );
  }

  if (planBlocked) {
    return (
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">{label}</Text>
        <Banner tone="info">
          <p>{(t.planRequired as string) || "Stock and sales channels are part of the Pro plan."}</p>
        </Banner>
      </BlockStack>
    );
  }

  /**
   * The variant whose box is rendered. Falls back to the FIRST one rather than
   * to nothing: a selection that points at a variant a reload no longer
   * returns would otherwise leave the stock section empty with no explanation.
   *
   * Deliberately NOT a hook. It sits below two early returns (foreign locale,
   * plan-blocked), and a hook there changes the hook COUNT between renders of
   * the same instance — React throws and the whole editor drops to its error
   * boundary. It shipped that way once: switching locale on any product, and
   * every non-Pro shop on every product, crashed the editor. A `find` over at
   * most a page of variants needs no memo anyway.
   */
  const shownVariant = !data?.variants.length
    ? null
    : data.variants.find((v) => v.id === selectedVariantId) ?? data.variants[0];

  const hasChanges =
    dirtyStock.length > 0 ||
    dirtyItemFields.length > 0 ||
    dirtyChannels.toPublish.length > 0 ||
    dirtyChannels.toUnpublish.length > 0;
  const publishedCount = data ? data.channels.filter((c) => channelState[c.publicationId]).length : 0;

  return (
    <BlockStack gap="300">
      <Text as="p" variant="bodyMd">{label}</Text>

      {loadError && (
        <Banner tone="warning">
          <BlockStack gap="200">
            <Text as="p">{loadError}</Text>
            <Box><Button onClick={() => load()}>{(t.retry as string) || "Try again"}</Button></Box>
          </BlockStack>
        </Banner>
      )}

      {!data && !loadError && <Spinner size="small" accessibilityLabel={(t.loading as string) || "Loading"} />}

      {notices.length > 0 && (
        <Banner tone="warning" onDismiss={() => setNotices([])}>
          <BlockStack gap="100">
            {notices.map((notice, index) => (
              <Text as="p" key={index}>{notice}</Text>
            ))}
          </BlockStack>
        </Banner>
      )}

      {data && (
        <>
          {/* ── Sales channels ─────────────────────────────────────────── */}
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">{(t.channelsHeading as string) || "Sales channels"}</Text>
              {/* §2.3 — the trap this feature exists for. Not a subtle hint:
                  a product on no channel is invisible everywhere. */}
              {publishedCount === 0 && (
                <Badge tone="critical">{(t.noChannel as string) || "On no channel — invisible"}</Badge>
              )}
            </InlineStack>

            {data.channelsTruncated && (
              <Text as="p" variant="bodySm" tone="subdued">
                {(t.channelsTruncated as string) || "More channels exist than were loaded. Manage the rest in the Shopify admin."}
              </Text>
            )}

            {data.channels.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                {(t.noChannels as string) || "This shop has no sales channels installed."}
              </Text>
            ) : (
              data.channels.map((channel) => (
                <Checkbox
                  key={channel.publicationId}
                  label={channel.name || channel.publicationId}
                  checked={channelState[channel.publicationId] === true}
                  disabled={saving}
                  // A future publish date is NOT "live". Saying "scheduled"
                  // rather than showing it as published is what keeps a
                  // planned launch from looking like a mistake.
                  helpText={
                    channel.publishDate && !channel.isPublished
                      ? ((t.scheduled as string) || "Scheduled for {date}").replace(
                          "{date}",
                          new Date(channel.publishDate).toLocaleDateString(),
                        )
                      : undefined
                  }
                  onChange={(checked) =>
                    setChannelState((prev) => ({ ...prev, [channel.publicationId]: checked }))
                  }
                />
              ))
            )}
          </BlockStack>

          {/* ── Stock ──────────────────────────────────────────────────── */}
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">{(t.stockHeading as string) || "Stock"}</Text>

            {/* The one sentence that says where multi-variant prices live. It
                used to be the price field's own note — and disappeared with
                the field, leaving a merchant on a 12-variant product with no
                price and no route to one. This panel owns stock, weight and
                channels, NOT price, so it has to point rather than offer. */}
            {data.variants.length > 1 && (
              <Text as="p" variant="bodySm" tone="subdued">
                {(t.variantPricesHint as string) ||
                  "Prices of several variants are edited in the bulk editor."}
              </Text>
            )}

            {data.variantsTruncated && (
              <Text as="p" variant="bodySm" tone="subdued">
                {(t.variantsTruncated as string) || "This product has more variants than were loaded. Edit the rest in the Shopify admin."}
              </Text>
            )}

            {/* The picker appears only where there is something to pick. With
                one variant a dropdown holding one entry is a control that asks
                a question with a single answer. */}
            {data.variants.length > 1 && (
              <Select
                label={(t.variantSelectLabel as string) || "Variant"}
                options={data.variants.map((variant) => ({
                  value: variant.id,
                  label: `${variant.title}${variant.sku ? ` · ${variant.sku}` : ""}`,
                }))}
                value={shownVariant?.id ?? ""}
                onChange={setSelectedVariantId}
                disabled={saving}
              />
            )}

            {shownVariant && [shownVariant].map((variant) => (
              <Box key={variant.id} background="bg-surface-secondary" padding="300" borderRadius="200">
                <BlockStack gap="200">
                  {/* The title stays even with the dropdown above it: with one
                      variant there IS no dropdown, and the box would then be a
                      set of fields belonging to nothing named. */}
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {variant.title}{variant.sku ? ` · ${variant.sku}` : ""}
                  </Text>

                  {/* The InventoryItem's own settings. Shown for EVERY
                      variant, tracked or not: a cost and a customs code are
                      facts about the item, not about whether Shopify counts
                      it. Locked when there is no InventoryItem to write to. */}
                  {variant.inventoryItemId ? (
                    <InlineStack gap="300" blockAlign="start" wrap>
                      <Box minWidth="140px">
                        <TextField
                          label={(t.cost as string) || "Cost per item"}
                          value={itemEdits[`${variant.id}::cost`] ?? (variant.cost ?? "")}
                          onChange={(value) => setItemEdits((prev) => ({ ...prev, [`${variant.id}::cost`]: value }))}
                          autoComplete="off"
                          inputMode="decimal"
                          disabled={saving}
                          helpText={(t.costHint as string) || "What you pay. Never shown to customers."}
                        />
                      </Box>
                      <Box minWidth="120px">
                        <TextField
                          label={(t.weight as string) || "Weight"}
                          value={itemEdits[`${variant.id}::weight`] ?? (variant.weight ?? "")}
                          onChange={(value) => setItemEdits((prev) => ({ ...prev, [`${variant.id}::weight`]: value }))}
                          autoComplete="off"
                          inputMode="decimal"
                          disabled={saving}
                        />
                      </Box>
                      <Box minWidth="140px">
                        <Select
                          label={(t.weightUnit as string) || "Unit"}
                          // `GRAMS` is not a unit anybody writes on a label.
                          // Same enum vocabulary the editor's attribute fields
                          // read, passed in with the rest of this panel's text.
                          options={WEIGHT_UNITS.map((unit) => ({
                            value: unit,
                            label: (t.enumLabels as Record<string, string> | undefined)?.[`weightUnit.${unit}`] ?? unit,
                          }))}
                          value={itemEdits[`${variant.id}::weightUnit`] ?? (variant.weightUnit || "KILOGRAMS")}
                          onChange={(value) => setItemEdits((prev) => ({ ...prev, [`${variant.id}::weightUnit`]: value }))}
                          disabled={saving}
                        />
                      </Box>
                      <Box minWidth="140px">
                        <TextField
                          label={(t.hsCode as string) || "HS code"}
                          value={itemEdits[`${variant.id}::harmonizedSystemCode`] ?? (variant.harmonizedSystemCode ?? "")}
                          onChange={(value) =>
                            setItemEdits((prev) => ({ ...prev, [`${variant.id}::harmonizedSystemCode`]: value }))
                          }
                          autoComplete="off"
                          disabled={saving}
                        />
                      </Box>
                      <Box minWidth="120px">
                        <TextField
                          label={(t.countryOfOrigin as string) || "Country of origin"}
                          value={itemEdits[`${variant.id}::countryCodeOfOrigin`] ?? (variant.countryCodeOfOrigin ?? "")}
                          onChange={(value) =>
                            setItemEdits((prev) => ({ ...prev, [`${variant.id}::countryCodeOfOrigin`]: value }))
                          }
                          autoComplete="off"
                          maxLength={2}
                          disabled={saving}
                          helpText={(t.countryHint as string) || "Two letters, e.g. DE"}
                        />
                      </Box>
                      <Box minWidth="180px">
                        <Checkbox
                          label={(t.requiresShipping as string) || "Needs shipping"}
                          checked={
                            (itemEdits[`${variant.id}::requiresShipping`] ??
                              String(variant.requiresShipping ?? true)) === "true"
                          }
                          disabled={saving}
                          onChange={(checked) =>
                            setItemEdits((prev) => ({ ...prev, [`${variant.id}::requiresShipping`]: String(checked) }))
                          }
                        />
                      </Box>
                      {/* Read-only on purpose: this app reads `taxable` off the
                          VARIANT, and writing it would mean a second mutation
                          against a different object. A field whose read and
                          write disagree about where it lives is a field that
                          reverts on the next sync. */}
                      <Box minWidth="160px">
                        <Text as="span" variant="bodySm" tone="subdued">
                          {((t.taxableLabel as string) || "Taxable: {v}").replace(
                            "{v}",
                            variant.taxable == null
                              ? "—"
                              : variant.taxable
                                ? (t.yes as string) || "yes"
                                : (t.no as string) || "no",
                          )}
                        </Text>
                      </Box>
                    </InlineStack>
                  ) : null}

                  {variant.inventoryTracked === null && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {(t.stockUnknown as string) || "Not loaded yet — reload to see this variant's stock."}
                    </Text>
                  )}

                  {variant.inventoryTracked === false && (
                    // NOT zero. Shopify keeps no count for this variant, and a
                    // 0 here would read as "sold out".
                    <Text as="p" variant="bodySm" tone="subdued">
                      {(t.stockUntracked as string) || "Stock is not tracked for this variant — it can be sold without limit."}
                    </Text>
                  )}

                  {variant.inventoryTracked === true && !variant.inventoryItemId && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {(t.stockNoItem as string) || "This variant has no inventory record, so its stock cannot be edited here."}
                    </Text>
                  )}

                  {variant.inventoryTracked === true && variant.inventoryItemId && (
                    <BlockStack gap="200">
                      {variant.levelsTruncated && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {(t.levelsTruncated as string) || "This variant has stock at more locations than were loaded."}
                        </Text>
                      )}
                      {variant.levels.length === 0 && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {(t.noLevels as string) || "No location holds stock of this variant."}
                        </Text>
                      )}
                      {variant.levels.map((level) => {
                        const key = `${variant.id}::${level.locationId}`;
                        return (
                          <InlineStack key={key} gap="300" blockAlign="center" wrap>
                            <Box minWidth="180px">
                              <Text as="span" variant="bodySm" tone={level.locationActive ? undefined : "subdued"}>
                                {level.locationName || level.locationId}
                                {/* Deactivated locations keep their stock but
                                    take no writes. Greyed, never hidden — a
                                    location that vanishes reads as stock that
                                    disappeared. */}
                                {!level.locationActive ? ` (${(t.locationInactive as string) || "inactive"})` : ""}
                              </Text>
                            </Box>
                            <Box minWidth="140px">
                              <TextField
                                label={(t.onHand as string) || "On hand"}
                                labelHidden
                                type="number"
                                value={edits[key] ?? String(level.onHand ?? "")}
                                onChange={(value) => setEdits((prev) => ({ ...prev, [key]: value }))}
                                autoComplete="off"
                                disabled={saving || !level.locationActive}
                              />
                            </Box>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {/* `available` is DERIVED (on hand minus open
                                  commitments), so it is shown and never
                                  edited — writing it would contradict the
                                  commitments it is computed from. */}
                              {((t.availableLabel as string) || "available: {n}").replace(
                                "{n}",
                                level.available == null ? "—" : String(level.available),
                              )}
                            </Text>
                          </InlineStack>
                        );
                      })}
                    </BlockStack>
                  )}
                </BlockStack>
              </Box>
            ))}
          </BlockStack>

          <InlineStack gap="200">
            <Button variant="primary" disabled={!hasChanges || saving} loading={saving} onClick={save}>
              {(t.save as string) || "Save stock and channels"}
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                // Reloading discards typed values. Asking is cheap; silently
                // losing a stock correction is not.
                if (hasChanges && !window.confirm((t.discardConfirm as string) || "Discard your unsaved changes?")) return;
                load();
              }}
            >
              {(t.reload as string) || "Reload"}
            </Button>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {/* Says WHY there is a separate button: this is not part of the
                content save, and a merchant who expects it to be would
                otherwise leave the page with stock unchanged. */}
            {(t.separateSaveHint as string) || "Stock and channels are saved separately from the text — they are not part of the content save."}
          </Text>
        </>
      )}
    </BlockStack>
  );
}
