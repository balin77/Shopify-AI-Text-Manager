/**
 * ItemPicker — controlled multi-select tile picker (PLAN_KEYWORDS_UI_REWORK.md
 * §2.2, Phase 3). Replaces every item `<Autocomplete>`/`<Select>` in the
 * Keywords section with a mini-navbar (type) + horizontal thumbnail slider
 * backed by the server-side search endpoint `/api/seo/item-picker`.
 *
 * i18n-INDEPENDENT: every display string arrives via the `labels` prop, so this
 * component touches no shared i18n file and is safe to drop into any locale
 * context. It is fully controlled — selection lives in `selectedIds` and every
 * toggle goes out through `onChange`.
 *
 * NOT wired into any route here — Phase 4 mounts it inside the assign panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextField, Select, Button, Spinner, Text, InlineStack, BlockStack } from "@shopify/polaris";
import { SubNavBar, type SubNavBarItem } from "../../nav/SubNavBar";

export type PickerType = "Product" | "Collection" | "Article" | "Page";

/**
 * One selected item, carrying its resource type. Selection can span type tabs,
 * so the id alone is not enough for the consumer (the assign panel needs each
 * item's type to build assignMany targets / route the AI batch). Reporting
 * `{ id, resourceType }` keeps that contract explicit instead of asking the
 * caller to reverse-map ids back to a type.
 */
export interface SelectedPickerItem {
  id: string;
  resourceType: PickerType;
}

interface PickerItem {
  id: string;
  title: string;
  imageUrl: string | null;
}

interface PickerResponse {
  items: PickerItem[];
  nextCursor: string | null;
  total: number;
}

export interface ItemPickerProps {
  selected: SelectedPickerItem[];
  onChange: (selected: SelectedPickerItem[]) => void;
  /** Options for the Product-only type facet (excluding the "all" entry). */
  productTypes: { label: string; value: string }[];
  /** Active locale ("" = primary). Drives the translated-title overlay. */
  locale: string;
  labels: {
    typeProduct: string;
    typeCollection: string;
    typePage: string;
    typeArticle: string;
    filterPlaceholder: string;
    productTypeAll: string;
    /** "{shown} von {total}" template. */
    countOf: string;
    selectAllVisible: string;
    selectedPrefix: string;
    loadMore: string;
    empty: string;
    loading: string;
  };
}

const TILE_WIDTH = 120;
const TILE_IMG_HEIGHT = 90;
const DEBOUNCE_MS = 250;

/** Append the Shopify CDN resize param, respecting an existing query string. */
function withWidth(url: string): string {
  return url.includes("?") ? `${url}&width=${TILE_WIDTH}` : `${url}?width=${TILE_WIDTH}`;
}

/** First-letter initials block for image-less (Page) tiles. */
function initials(title: string): string {
  return (title.trim()[0] || "?").toUpperCase();
}

export function ItemPicker({ selected, onChange, productTypes, locale, labels }: ItemPickerProps) {
  const [type, setType] = useState<PickerType>("Product");
  const [rawFilter, setRawFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [productType, setProductType] = useState("");

  const [items, setItems] = useState<PickerItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Guards against a stale in-flight response overwriting a newer query's result.
  const requestSeq = useRef(0);

  const selectedSet = useMemo(() => new Set(selected.map((s) => s.id)), [selected]);

  const typeItems: SubNavBarItem[] = useMemo(
    () => [
      { id: "Product", label: labels.typeProduct },
      { id: "Collection", label: labels.typeCollection },
      { id: "Page", label: labels.typePage },
      { id: "Article", label: labels.typeArticle },
    ],
    [labels.typeProduct, labels.typeCollection, labels.typePage, labels.typeArticle],
  );

  // Debounce the text filter before it triggers a fetch.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedFilter(rawFilter.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [rawFilter]);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({ type });
        if (debouncedFilter) params.set("q", debouncedFilter);
        if (type === "Product" && productType) params.set("productType", productType);
        if (locale) params.set("locale", locale);
        if (cursor) params.set("cursor", cursor);

        const res = await fetch(`/api/seo/item-picker?${params.toString()}`);
        const data = (await res.json()) as PickerResponse;

        // A newer request superseded this one — drop the stale result.
        if (seq !== requestSeq.current) return;

        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setNextCursor(data.nextCursor);
        setTotal(data.total);
      } catch {
        if (seq !== requestSeq.current) return;
        if (!append) {
          setItems([]);
          setNextCursor(null);
          setTotal(0);
        }
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [type, debouncedFilter, productType, locale],
  );

  // (Re)load from scratch whenever type / filter / productType / locale change.
  useEffect(() => {
    fetchPage(null, false);
  }, [fetchPage]);

  const handleType = useCallback((item: SubNavBarItem) => {
    setType(item.id as PickerType);
    setRawFilter("");
    setDebouncedFilter("");
    setProductType("");
    setItems([]);
    setNextCursor(null);
  }, []);

  const toggle = useCallback(
    (id: string) => {
      if (selectedSet.has(id)) {
        onChange(selected.filter((s) => s.id !== id));
      } else {
        onChange([...selected, { id, resourceType: type }]);
      }
    },
    [selectedSet, selected, onChange, type],
  );

  const selectAllVisible = useCallback(() => {
    // De-dupe by id, stamping the current type tab onto any newly added ids.
    const byId = new Map(selected.map((s) => [s.id, s]));
    for (const it of items) byId.set(it.id, { id: it.id, resourceType: type });
    onChange(Array.from(byId.values()));
  }, [items, selected, onChange, type]);

  const productTypeOptions = useMemo(
    () => [{ label: labels.productTypeAll, value: "" }, ...productTypes],
    [labels.productTypeAll, productTypes],
  );

  const countLine = labels.countOf
    .replace("{shown}", String(items.length))
    .replace("{total}", String(total));

  // Titles of currently-selected items that are loaded (for the summary line).
  const selectedTitles = useMemo(
    () => items.filter((it) => selectedSet.has(it.id)).map((it) => it.title),
    [items, selectedSet],
  );

  return (
    <BlockStack gap="300">
      <SubNavBar items={typeItems} activeId={type} onSelect={handleType} />

      <InlineStack gap="300" blockAlign="end" wrap>
        <div style={{ minWidth: 220, flex: "1 1 220px" }}>
          <TextField
            label=""
            labelHidden
            autoComplete="off"
            placeholder={labels.filterPlaceholder}
            value={rawFilter}
            onChange={setRawFilter}
          />
        </div>
        {type === "Product" && (
          <div style={{ minWidth: 160 }}>
            <Select
              label=""
              labelHidden
              options={productTypeOptions}
              value={productType}
              onChange={setProductType}
            />
          </div>
        )}
        <Text as="span" variant="bodySm" tone="subdued">
          {countLine}
        </Text>
      </InlineStack>

      {loading && items.length === 0 ? (
        <InlineStack gap="200" blockAlign="center">
          <Spinner accessibilityLabel={labels.loading} size="small" />
          <Text as="span" variant="bodySm" tone="subdued">
            {labels.loading}
          </Text>
        </InlineStack>
      ) : items.length === 0 ? (
        <Text as="span" variant="bodySm" tone="subdued">
          {labels.empty}
        </Text>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            gap: "0.5rem",
            overflowX: "auto",
            paddingBottom: "0.25rem",
          }}
        >
          {items.map((it) => {
            const isSelected = selectedSet.has(it.id);
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => toggle(it.id)}
                aria-pressed={isSelected}
                title={it.title}
                style={{
                  flex: "0 0 auto",
                  width: `${TILE_WIDTH}px`,
                  padding: "0.35rem",
                  border: isSelected ? "2px solid #008060" : "2px solid #e1e3e5",
                  borderRadius: "8px",
                  background: isSelected ? "#f1f8f5" : "white",
                  cursor: "pointer",
                  textAlign: "left",
                  position: "relative",
                }}
              >
                {isSelected && (
                  <span
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      background: "#008060",
                      color: "white",
                      fontSize: "0.7rem",
                      lineHeight: "18px",
                      textAlign: "center",
                    }}
                  >
                    ✓
                  </span>
                )}
                {it.imageUrl ? (
                  <img
                    src={withWidth(it.imageUrl)}
                    alt=""
                    loading="lazy"
                    width={TILE_WIDTH - 12}
                    height={TILE_IMG_HEIGHT}
                    style={{
                      width: "100%",
                      height: `${TILE_IMG_HEIGHT}px`,
                      objectFit: "cover",
                      borderRadius: "4px",
                      display: "block",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: `${TILE_IMG_HEIGHT}px`,
                      borderRadius: "4px",
                      background: "#f0f1f2",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "1.6rem",
                      fontWeight: 600,
                      color: "#8a8f94",
                    }}
                  >
                    {initials(it.title)}
                  </div>
                )}
                <div
                  style={{
                    marginTop: "0.3rem",
                    fontSize: "0.75rem",
                    lineHeight: 1.2,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    wordBreak: "break-word",
                  }}
                >
                  {it.title}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {items.length > 0 && (
        <InlineStack gap="300" blockAlign="center" wrap>
          <Button size="slim" onClick={selectAllVisible}>
            {labels.selectAllVisible}
          </Button>
          {nextCursor && (
            <Button size="slim" variant="tertiary" loading={loading} onClick={() => fetchPage(nextCursor, true)}>
              {labels.loadMore}
            </Button>
          )}
        </InlineStack>
      )}

      {selectedTitles.length > 0 && (
        <Text as="span" variant="bodySm" tone="subdued">
          {labels.selectedPrefix}
          {selectedTitles.join(", ")}
        </Text>
      )}
    </BlockStack>
  );
}
