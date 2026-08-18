/**
 * Everything the commerce panel knows, in one place.
 *
 * -- Why a context and not a component ---------------------------------------
 * The panel used to be ONE component rendering two unrelated things: the
 * shop's sales channels (a property of the PRODUCT) and the per-variant
 * prices, stock and shipping settings. Those two now live in different cards —
 * the variant half belongs under the options it describes — and they sit in
 * different branches of the editor's tree.
 *
 * They cannot become two components with their own state: there is ONE live
 * load, ONE set of pending edits, and ONE registration with the editor's save
 * bar. Two loads would mean two `compareQuantity` baselines for the same
 * stock, which is exactly the arithmetic this feature refuses to do.
 *
 * So the state lives here and the two views consume it. Everything below is
 * moved verbatim from `CommerceField`; the rules it carries are unchanged and
 * the comments explaining them travel with the code.
 *
 * -- It loads LIVE, and it says when -----------------------------------------
 * Stock is volatile: orders, returns and other apps move it between two page
 * loads. So this fetches on open rather than reading the cache, and the number
 * next to each input is the one the save COMPARES against. If it moved in the
 * meantime, Shopify refuses the write and the merchant is told the number
 * changed instead of overwriting someone else's arithmetic.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCommerceReloadNonce, useRegisterCommerceSave } from "./CommerceSaveContext";
import type { CommerceChannelView, CommerceVariantView } from "../routes/api.product-commerce";

/** Shopify's `WeightUnit` enum — an unknown value fails at the SCHEMA level. */
export const WEIGHT_UNITS = ["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"] as const;

export interface CommerceTexts {
  [key: string]: string | Record<string, string> | undefined;
  /** Keyed by `CommerceWarning`. */
  warnings?: Record<string, string>;
}

export interface LoadedState {
  variants: CommerceVariantView[];
  variantsTruncated: boolean;
  channels: CommerceChannelView[];
  channelsTruncated: boolean;
  /** Every location the SHOP has — see the "not stocked here" rows below. */
  shopLocations: Array<{ id: string; name: string; isActive: boolean }>;
}

export interface CommerceDataValue {
  data: LoadedState | null;
  loadError: string | null;
  planBlocked: boolean;
  saving: boolean;
  notices: string[];
  setNotices: (notices: string[]) => void;
  load: (options?: { keepEdits?: boolean }) => void;
  isPrimaryLocale: boolean;
  t: CommerceTexts;

  selectedVariantId: string | null;
  setSelectedVariantId: (id: string | null) => void;
  priceEdits: Record<string, string>;
  setPriceEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  edits: Record<string, string>;
  setEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  itemEdits: Record<string, string>;
  setItemEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  channelState: Record<string, boolean>;
  setChannelState: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;

  loadedOnHand: (variantId: string, locationId: string) => number | null;
  hasChanges: boolean;
}

const CommerceDataContext = createContext<CommerceDataValue | null>(null);

/**
 * `null` when there is no provider — which is the normal state for every
 * resource type that is not a product. A consumer renders nothing then rather
 * than throwing: the variants card exists for products only, but the component
 * tree around it does not know that.
 */
export function useCommerceData(): CommerceDataValue | null {
  return useContext(CommerceDataContext);
}

export function CommerceDataProvider({
  productId,
  isPrimaryLocale,
  t,
  children,
}: {
  /** The product GID. "" while nothing is selected. */
  productId: string;
  /** False in a foreign locale — stock and channels exist once per product. */
  isPrimaryLocale: boolean;
  t: CommerceTexts;
  children: ReactNode;
}) {
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
    const byVariant = new Map<
      string,
      { price?: string; compareAtPrice?: string; barcode?: string; inventoryPolicy?: string }
    >();
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
      } else if (field === "barcode") {
        // "" IS a change here — it clears a wrong barcode, unlike the price.
        if (value.trim() === (variant.barcode ?? "")) continue;
        byVariant.set(variantId, { ...byVariant.get(variantId), barcode: value });
      } else if (field === "inventoryPolicy") {
        if (value === (variant.inventoryPolicy ?? "")) continue;
        byVariant.set(variantId, { ...byVariant.get(variantId), inventoryPolicy: value });
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
            ...(fields.barcode !== undefined ? { barcode: fields.barcode } : {}),
            ...(fields.inventoryPolicy !== undefined ? { inventoryPolicy: fields.inventoryPolicy } : {}),
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
        } else if (field === "inventoryTracked") {
          // Keyed by the VIEW's field name so the dirty check compares against
          // what was loaded; the write module's input calls it `tracked`.
          fields.tracked = value === "true";
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

  const value: CommerceDataValue = {
    data,
    loadError,
    planBlocked,
    saving,
    notices,
    setNotices,
    load,
    isPrimaryLocale,
    t,
    selectedVariantId,
    setSelectedVariantId,
    priceEdits,
    setPriceEdits,
    edits,
    setEdits,
    itemEdits,
    setItemEdits,
    channelState,
    setChannelState,
    loadedOnHand,
    hasChanges,
  };

  return <CommerceDataContext.Provider value={value}>{children}</CommerceDataContext.Provider>;
}
