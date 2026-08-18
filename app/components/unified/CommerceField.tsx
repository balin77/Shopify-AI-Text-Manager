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
import { useCommerceReloadNonce, useRegisterCommerceSave } from "../../contexts/CommerceSaveContext";
import { HelpTooltip } from "../HelpTooltip";
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
  Tooltip,
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
  /** Every location the SHOP has — see the "not stocked here" rows below. */
  shopLocations: Array<{ id: string; name: string; isActive: boolean }>;
}

export function CommerceField({ productId, label, isPrimaryLocale, t }: CommerceFieldProps) {
  const [data, setData] = useState<LoadedState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planBlocked, setPlanBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Mirrors `saving` for the re-entrancy guard: state read inside the same
   *  handler is still the value from the render that scheduled it. */
  const savingRef = useRef(false);
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

  /** Edited selling prices, keyed `variantId::price` / `::compareAtPrice`. */
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
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
          shopLocations: body.shopLocations ?? [],
        });
        // A refused write reloads to SHOW the number that actually moved —
        // and must not also throw away what the merchant typed, or they have
        // to retype it from memory against a number that just changed.
        if (!keepEdits) {
          setEdits({});
          setItemEdits({});
          setPriceEdits({});
        }
        // Reseeded ONLY when the edits are being dropped anyway. It used to run
        // unconditionally, so activating a location silently reverted an
        // unticked sales channel — and with `dirtyChannels` back to empty the
        // save bar vanished, telling the merchant there was nothing to save.
        if (!keepEdits) {
          setChannelState(
            Object.fromEntries((body.channels ?? []).map((c: CommerceChannelView) => [c.publicationId, c.isPublished])),
          );
        }
      })
      .catch(() => {
        if (token !== loadToken.current) return;
        setLoadError((t.loadFailed as string) || "Stock and channels could not be loaded.");
      });
  }, [productId, t.loadFailed]);

  /**
   * The editor's reload buttons, arriving as a counter.
   *
   * Skipped on the first value so mounting does not fetch twice — the effect
   * below already loads. A reload DISCARDS typed values, which is the same
   * cost the panel's own button had; the difference is that there is now one
   * place on the screen that means "re-read this item" instead of three.
   */
  const reloadNonce = useCommerceReloadNonce();
  const seenNonce = useRef(reloadNonce);
  /** `hasChanges` without putting it in the effect's deps — asking has to
   *  happen at the moment of the reload, not re-run when the flag flips. */
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (seenNonce.current === reloadNonce) return;
    seenNonce.current = reloadNonce;
    if (!isPrimaryLocale) return;
    // ASKED, because a reload discards typed values and the merchant probably
    // pressed that button to refresh their translations. The panel's own
    // Reload asked before it was removed; losing the question with the button
    // would make the editor's reload quietly eat a stock correction.
    if (dirtyRef.current && !window.confirm((t.discardConfirm as string) || "Discard your unsaved changes?")) {
      return;
    }
    load();
  }, [reloadNonce, isPrimaryLocale, load, t.discardConfirm]);

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
      // `undefined` means the seed has not landed (or was lost), NOT "off".
      // Reading it as off is what turned a mistimed Discard into an
      // unpublish-from-every-channel — the §2.3 trap this panel exists to
      // reveal, caused by the panel itself.
      if (next === undefined || next === channel.isPublished) continue;
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

  /**
   * Which variants have a price the merchant changed.
   *
   * Compared against the LOADED value, and an empty price field counts as
   * untouched rather than as a clear: Shopify requires a price on every
   * variant, so "" cannot mean anything else. The compare-at price is the
   * opposite — "" there is how a merchant ends a sale, so it IS a change.
   */
  const dirtyPrices = useMemo(() => {
    const byVariant = new Map<string, { price?: string; compareAtPrice?: string }>();
    for (const [key, value] of Object.entries(priceEdits)) {
      const [variantId, field] = key.split("::");
      const variant = data?.variants.find((v) => v.id === variantId);
      if (!variant) continue;
      if (field === "price") {
        if (value.trim() === "" || value.trim() === (variant.price ?? "")) continue;
        byVariant.set(variantId, { ...byVariant.get(variantId), price: value });
      } else if (field === "compareAtPrice") {
        if (value.trim() === (variant.compareAtPrice ?? "")) continue;
        byVariant.set(variantId, { ...byVariant.get(variantId), compareAtPrice: value });
      }
    }
    return [...byVariant.entries()];
  }, [priceEdits, data]);

  const hasChanges =
    dirtyPrices.length > 0 ||
    dirtyStock.length > 0 ||
    dirtyItemFields.length > 0 ||
    dirtyChannels.toPublish.length > 0 ||
    dirtyChannels.toUnpublish.length > 0;

  dirtyRef.current = hasChanges;

  const save = useCallback(async () => {
    // A second click while the first write is in flight would send the same
    // `compareQuantity` twice: the second is refused and reported as "the stock
    // changed meanwhile" — a frightening message caused by the merchant's own
    // double click.
    //
    // `!hasChanges` short-circuits the common case: the save bar calls this on
    // EVERY save, and without it a plain title edit walked the empty loops and
    // still reloaded — one GraphQL round trip and a visible blank-and-repaint
    // of the panel for a save that had nothing to do with it.
    if (!data || savingRef.current || !hasChanges) return;
    savingRef.current = true;
    setSaving(true);
    setNotices([]);
    const collected: string[] = [];
    try {
      // Prices first: they are the cheapest write and the one a merchant is
      // most likely to be watching. Each variant is its own call — the mutation
      // takes a list, but a per-variant call keeps a rejected price from taking
      // another variant's down with it, which is the same per-cell rule the
      // bulk editor follows.
      for (const [variantId, fields] of dirtyPrices) {
        const variant = data.variants.find((v) => v.id === variantId);
        if (!variant) continue;
        const warnings = await postIsolated(
          {
            intent: "price",
            productId,
            variantId,
            variantGid: variant.gid,
            ...(fields.price !== undefined ? { price: fields.price } : {}),
            ...(fields.compareAtPrice !== undefined ? { compareAtPrice: fields.compareAtPrice } : {}),
          },
          "priceFailed",
        );
        // Phrased, like every other branch: pushing the raw code showed the
        // merchant the literal string `priceFailed`, and the two SPECIFIC
        // reasons (invalid, not confirmed) could never reach them at all.
        collected.push(...warnings.map((code) => (t.warnings?.[code] as string) || code));
      }

      // Grouped per VARIANT: `inventorySetQuantities` is atomic per call, so a
      // merchant editing three locations of one variant cannot end up with one
      // written and two not.
      const byVariant = new Map<string, Array<{ locationId: string; quantity: number; compare: number }>>();
      /** Locations that have to be ACTIVATED before they can hold a number. */
      const activations: Array<{ variantId: string; locationId: string; quantity: string; gid: string }> = [];
      for (const [key, value] of dirtyStock) {
        const [variantId, locationId] = key.split("::");
        const compare = loadedOnHand(variantId, locationId);
        // No loaded value has TWO causes, and they need opposite treatment.
        if (compare === null) {
          const variant = data.variants.find((v) => v.id === variantId);
          const known = variant?.levels.some((l) => l.locationId === locationId);
          if (!known && variant?.inventoryItemId) {
            // The location is simply not stocked yet — a number typed into one
            // of those rows IS the request to start stocking it. Activation
            // and the quantity are ONE call, so this is not a compare-less
            // overwrite: there is nothing there to overwrite.
            activations.push({ variantId, locationId, quantity: value.trim(), gid: variant.inventoryItemId });
            continue;
          }
          // The other cause: a level this app knows about but has no number
          // for. A write without a comparison is exactly the silent overwrite
          // this feature avoids — but it is SAID, because dropping a typed
          // quantity and then clearing the field on the reload is how a stock
          // correction disappears with nobody noticing.
          collected.push((t.warnings?.stockNoBaseline as string) || "stockNoBaseline");
          continue;
        }
        const list = byVariant.get(variantId) ?? [];
        list.push({ locationId, quantity: Number.parseInt(value, 10), compare });
        byVariant.set(variantId, list);
      }

      for (const activation of activations) {
        const warnings = await postIsolated(
          {
            intent: "activate",
            productId,
            inventoryItemId: activation.gid,
            locationId: activation.locationId,
            quantity: activation.quantity,
          },
          "activateFailed",
        );
        collected.push(...warnings.map((code) => (t.warnings?.[code] as string) || code));
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
      savingRef.current = false;
      setSaving(false);
    }
    setNotices(collected);
    // Reload either way. On success it confirms; on a refused write it shows
    // the number that actually moved — and then KEEPS the merchant's input,
    // because that is exactly the case where they need it.
    load({ keepEdits: collected.length > 0 });
  }, [data, hasChanges, dirtyPrices, dirtyStock, dirtyChannels, dirtyItemFields, itemEdits, loadedItemField, loadedOnHand, postIsolated, productId, load, t]);

  /**
   * The editor's save bar drives this panel. Registered rather than lifted:
   * the quantities stay in THIS component's state, so a volatile number never
   * enters the editor's flat value map where it would be stale by the time
   * anyone pressed save. The compare-and-swap on the write is unchanged.
   *
   * The effect sits HERE, above the component's early returns — a hook below
   * them changes the hook count between renders, which is exactly the crash
   * this file shipped once already.
   */
  const registerCommerceSave = useRegisterCommerceSave();
  /** What the save bar's Discard throws away here. Without it, discarding a
   *  typed quantity left the bar visible and the write still armed: the next
   *  Save for an unrelated title edit fired the stock change the merchant
   *  believed they had dropped. */
  const discard = useCallback(() => {
    setEdits({});
    setItemEdits({});
    setPriceEdits({});
    setNotices([]);
    // Only when there IS a loaded answer to reseed FROM. During a reload `data`
    // is null, and `Object.fromEntries([])` produced an empty map — which
    // `dirtyChannels` then read as "every channel unticked" and queued an
    // unpublish-from-everywhere on the next save. Discarding must never be
    // able to take a product off its sales channels.
    if (!data) return;
    setChannelState(
      Object.fromEntries(data.channels.map((c) => [c.publicationId, c.isPublished])),
    );
  }, [data]);

  useEffect(() => {
    if (!isPrimaryLocale || planBlocked) {
      registerCommerceSave(null);
      return;
    }
    registerCommerceSave({ hasChanges, save, discard });
    // Unregistering on unmount matters: a stale `save` bound to the previous
    // product would otherwise write that product's numbers.
    return () => registerCommerceSave(null);
  }, [registerCommerceSave, hasChanges, save, discard, isPrimaryLocale, planBlocked]);

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
          {/* The one case where the bulk editor is still the answer: without
              this panel there is nowhere else to price a multi-variant
              product. */}
          <p>{(t.variantPricesHint as string) || "Prices of several variants are edited in the bulk editor."}</p>
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
              <HelpTooltip helpKey="commerceChannels" />
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
              /* Horizontal, wrapping. A shop has a handful of channels with
                 short names, and one full-width row each turned six words into
                 six lines. */
              <InlineStack gap="400" wrap>
              {data.channels.map((channel) => (
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
              ))}
              </InlineStack>
            )}
          </BlockStack>

          {/* ── Stock ──────────────────────────────────────────────────── */}
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">{(t.stockHeading as string) || "Stock"}</Text>
              <HelpTooltip helpKey="commerceStock" />
            </InlineStack>

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

                  {/* ── Prices ─────────────────────────────────────────
                      All three on ONE row, because the confusion they cause is
                      the difference BETWEEN them: the field that used to sit up
                      here alone was `cost`, what the merchant pays, and anyone
                      looking for "the price" read it. Side by side, each one
                      names itself against the other two.

                      The explanations moved into tooltips: three lines of prose
                      under three inputs is taller than the inputs themselves,
                      and it is text a merchant reads once. */}
                  <SectionHeading text={(t.pricesHeading as string) || "Prices"} helpKey="commercePrices" />
                  <InlineStack gap="300" blockAlign="start" wrap>
                    <MoneyField
                      label={(t.price as string) || "Price"}
                      help={(t.priceHint as string) || "What the customer pays."}
                      value={priceEdits[`${variant.id}::price`] ?? (variant.price ?? "")}
                      onChange={(value) =>
                        setPriceEdits((prev) => ({ ...prev, [`${variant.id}::price`]: value }))
                      }
                      disabled={saving}
                    />
                    <MoneyField
                      label={(t.compareAtPrice as string) || "Compare-at price"}
                      help={(t.compareAtPriceHint as string) || "The struck-through price. Empty = no sale."}
                      value={priceEdits[`${variant.id}::compareAtPrice`] ?? (variant.compareAtPrice ?? "")}
                      onChange={(value) =>
                        setPriceEdits((prev) => ({ ...prev, [`${variant.id}::compareAtPrice`]: value }))
                      }
                      disabled={saving}
                    />
                    {variant.inventoryItemId && (
                      <MoneyField
                        label={(t.cost as string) || "Cost per item"}
                        help={(t.costHint as string) || "What you pay. Never shown to customers."}
                        value={itemEdits[`${variant.id}::cost`] ?? (variant.cost ?? "")}
                        onChange={(value) => setItemEdits((prev) => ({ ...prev, [`${variant.id}::cost`]: value }))}
                        disabled={saving}
                      />
                    )}
                  </InlineStack>

                  {/* The InventoryItem's own settings. Shown for EVERY
                      variant, tracked or not: a cost and a customs code are
                      facts about the item, not about whether Shopify counts
                      it. Locked when there is no InventoryItem to write to. */}
                  {variant.inventoryItemId ? (
                    <>
                    <SectionHeading
                      text={(t.shippingHeading as string) || "Shipping and customs"}
                      helpKey="commerceShipping"
                    />
                    <InlineStack gap="300" blockAlign="start" wrap>
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
                    </>
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
                      {variant.levels.length === 0 && data.shopLocations.length === 0 && (
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
                            {/* Sized for a number, not for a sentence. It was
                                a full-width text input holding at most four
                                digits, which made the stock list read like a
                                form of paragraphs. */}
                            <Box minWidth="86px" maxWidth="86px">
                              <TextField
                                label={(t.onHand as string) || "On hand"}
                                labelHidden
                                type="number"
                                inputMode="numeric"
                                align="right"
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

                      {/* Locations the item is not stocked at.
                          Shopify reports a level only where an item has been
                          ACTIVATED, so these are absent from `levels` — and a
                          merchant with three warehouses seeing one row
                          reasonably concludes the panel is broken.

                          They get the SAME input as the others rather than an
                          "activate" button: typing a number is what a merchant
                          means by "stock it here", and a button that has to be
                          pressed first is a step the machine can take itself.
                          The activation rides along with the save — Shopify's
                          `inventoryActivate` takes the quantity, so it is one
                          call, not two. */}
                      {/* Suppressed entirely when the level window was cut
                          off: locations 11+ of a variant stocked at more than
                          `INVENTORY_LEVEL_PAGE_SIZE` places are missing from
                          `levels` while present in `shopLocations`, and would
                          be listed as "not stocked here" WITH an input that
                          routes into activation — writing a quantity over a
                          real one with no compare-and-swap. The truncation
                          notice above already says the list is incomplete. */}
                      {(variant.levelsTruncated ? [] : data.shopLocations)
                        .filter((location) => !variant.levels.some((l) => l.locationId === location.id))
                        .map((location) => {
                          const key = `${variant.id}::${location.id}`;
                          return (
                            <InlineStack key={key} gap="300" blockAlign="center" wrap>
                              <Box minWidth="180px">
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {location.name}
                                  {!location.isActive ? ` (${(t.locationInactive as string) || "inactive"})` : ""}
                                </Text>
                              </Box>
                              <Box minWidth="86px" maxWidth="86px">
                                <TextField
                                  label={(t.onHand as string) || "On hand"}
                                  labelHidden
                                  type="number"
                                  inputMode="numeric"
                                  align="right"
                                  // Empty, not "0": the variant genuinely has
                                  // no count here, and a pre-filled 0 would
                                  // read as "we hold none" rather than "we do
                                  // not stock this here".
                                  value={edits[key] ?? ""}
                                  placeholder="–"
                                  onChange={(value) => setEdits((prev) => ({ ...prev, [key]: value }))}
                                  autoComplete="off"
                                  disabled={saving || !location.isActive || !variant.inventoryItemId}
                                />
                              </Box>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {(t.notStockedHere as string) || "not stocked here"}
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

          {saving && (
            <Text as="p" variant="bodySm" tone="subdued">
              {(t.savingStock as string) || "Saving stock…"}
            </Text>
          )}
        </>
      )}
    </BlockStack>
  );
}

/** A small group heading with the app's usual "?" beside it. Three inputs in a
 *  row need a word saying what the row IS; a bare row of labels does not. */
function SectionHeading({ text, helpKey }: { text: string; helpKey: string }) {
  return (
    <InlineStack gap="100" blockAlign="center">
      <Text as="h4" variant="headingXs">{text}</Text>
      <HelpTooltip helpKey={helpKey} />
    </InlineStack>
  );
}

/**
 * A money input sized for money, with its explanation on hover.
 *
 * The explanation used to be `helpText` under the field. Under three fields in
 * a row that is three lines of prose taller than the inputs themselves — and it
 * is text a merchant reads once and then never again.
 */
function MoneyField({
  label,
  help,
  value,
  onChange,
  disabled,
}: {
  label: string;
  help: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Box minWidth="130px" maxWidth="150px">
      <Tooltip content={help} preferredPosition="above">
        {/* The tooltip wraps the whole control, label included: hovering the
            LABEL is what a merchant does when they are unsure what a field
            means. */}
        <div>
          <TextField
            label={label}
            value={value}
            onChange={onChange}
            autoComplete="off"
            inputMode="decimal"
            align="right"
            disabled={disabled}
          />
        </div>
      </Tooltip>
    </Box>
  );
}
