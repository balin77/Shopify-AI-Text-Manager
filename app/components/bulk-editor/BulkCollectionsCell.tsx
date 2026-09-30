/**
 * The bulk grid's collection-membership cell: a dropdown of checkboxes.
 *
 * The VALUE is the membership as canonical collection GIDs (the single editor's
 * representation, sorted so the grid's string comparison cannot mistake a
 * re-ordering for an edit). The merchant never sees a GID: the activator shows
 * the titles and the panel lists every collection of the shop, ticked where the
 * product belongs.
 *
 * Checkboxes and not pill switches: this is a "which of these" multi-select,
 * which the app's toggle rule explicitly leaves as checkboxes.
 *
 * ── What is locked, and why it is the SAME answer the save gives ───────────
 * A rule-based collection decides its own members — un-ticking it would be
 * undone by the rule, and ticking it is refused by Shopify, which on an atomic
 * `productUpdate` would take the row's other edits with it. A collection that
 * was never measured is locked for the same reason. `collectionPickerRows` is
 * the ONE place that decides this, shared with the single editor's picker, and
 * the server's `diffCollectionMembership` runs the same ladder — so the panel
 * cannot offer a change the save then refuses.
 *
 * ── The page behind it freezes while it is open ────────────────────────────
 * The grid scrolls inside its own container, which Polaris' positioning never
 * learns about (§Overlays in CLAUDE.md): without the lock the panel would stay
 * where it opened while the cell slid away under it. The allowance is the
 * LIST, the one element that should still scroll.
 */

import { useMemo, useRef, useState } from "react";
import { BlockStack, Button, Checkbox, Popover, Spinner, Text, TextField } from "@shopify/polaris";
import { useScrollLock } from "../../hooks/useScrollLock";
import { useShopCollections } from "../../hooks/useShopCollections";
import { useI18n } from "../../contexts/I18nContext";
import { compareStrings } from "../../utils/format";
import {
  canonicalCollectionIds,
  collectionPickerRows,
  type CollectionPickerMembership,
} from "../../services/collection-picker.shared";

export interface BulkCollectionsCellTexts {
  filter?: string;
  loading?: string;
  lookupFailed?: string;
  automated?: string;
  automatedUnknown?: string;
  truncated?: string;
  listTruncated?: string;
  none?: string;
  /** The activator's label when the product is in no collection. */
  noneSelected?: string;
}

interface BulkCollectionsCellProps {
  /** Canonical collection GIDs, comma-joined. */
  value: string;
  onChange: (value: string) => void;
  /** The product's memberships from the cache — titles and rule-based flags. */
  memberships: CollectionPickerMembership[];
  /** The sync's window cut the membership list off. */
  truncated: boolean;
  isDirty: boolean;
  error?: string;
  errorId?: string;
  texts: BulkCollectionsCellTexts;
}

export function BulkCollectionsCell({
  value,
  onChange,
  memberships,
  truncated,
  isDirty,
  error,
  errorId,
  texts,
}: BulkCollectionsCellProps) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  useScrollLock(open, listRef);

  // Asked for only once a cell is on screen; one request for the whole page.
  const loaded = useShopCollections();
  const options = loaded?.ok ? loaded.collections : null;

  // The full list is built — and locale-SORTED — only while the panel is OPEN.
  // A page of fifty closed cells over a shop with a few hundred collections
  // would otherwise run fifty full sorts on the main thread the moment the list
  // arrives, for rows nobody is looking at.
  const rows = useMemo(
    () =>
      open
        ? collectionPickerRows(options, memberships).sort((a, b) =>
            compareStrings(a.title, b.title, locale),
          )
        : [],
    [open, options, memberships, locale],
  );
  const selected = useMemo(
    () => new Set(value.split(",").map((id) => id.trim()).filter(Boolean)),
    [value],
  );

  // The closed cell only has to NAME its own selection: the row's memberships
  // first (they came with the row), the shop list for an id ticked in this
  // session. A linear find over a handful of ids, never a sort.
  const titleOf = (id: string): string =>
    memberships.find((m) => m.collectionId === id)?.collectionTitle ||
    options?.find((o) => o.id === id)?.title ||
    id;
  const shownTitles = [...selected].map(titleOf);
  const summary = shownTitles.length > 0 ? shownTitles.join(", ") : texts.noneSelected || "—";

  const needle = query.trim().toLowerCase();
  const visible = needle ? rows.filter((row) => row.title.toLowerCase().includes(needle)) : rows;

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    // Canonical, so ticking and un-ticking the same row reads as NO edit.
    onChange(canonicalCollectionIds(next));
  };

  return (
    <span
      className={`cp-bulk-select${isDirty ? " cp-bulk-cell-dirty" : ""}${error ? " cp-bulk-cell-error" : ""}`}
      // The whole list, one hover away — the button truncates it.
      title={shownTitles.join(", ") || undefined}
    >
      <Popover
        active={open}
        onClose={() => {
          setOpen(false);
          setQuery("");
        }}
        preferredAlignment="left"
        activator={
          <Button disclosure size="slim" textAlign="left" fullWidth onClick={() => setOpen((v) => !v)}>
            {summary}
          </Button>
        }
      >
        <div style={{ width: "20rem", maxWidth: "80vw", boxSizing: "border-box", padding: "0.5rem" }}>
          <BlockStack gap="200">
            <TextField
              label=""
              labelHidden
              value={query}
              onChange={setQuery}
              autoComplete="off"
              placeholder={texts.filter || "Filter collections…"}
              clearButton
              onClearButtonClick={() => setQuery("")}
            />
            {loaded === null && (
              <Spinner size="small" accessibilityLabel={texts.loading || "Loading collections"} />
            )}
            {/* A failed lookup still shows the product's OWN memberships (they
                came with the row), and says the rest is missing rather than
                presenting them as the whole shop. */}
            {loaded !== null && !loaded.ok && (
              <Text as="p" variant="bodySm" tone="caution">
                {texts.lookupFailed || "The collection list could not be loaded."}
              </Text>
            )}
            <div
              ref={listRef}
              style={{ maxHeight: "18rem", overflowY: "auto", overscrollBehavior: "contain" }}
            >
              <BlockStack gap="100">
                {visible.map((row) => {
                  const lockedReason =
                    row.automated === true
                      ? texts.automated || "Managed by this collection's rules"
                      : row.automated === null
                        ? texts.automatedUnknown || "Not loaded from Shopify yet"
                        : undefined;
                  return (
                    <Checkbox
                      key={row.id}
                      label={row.title}
                      checked={selected.has(row.id)}
                      disabled={!!lockedReason}
                      helpText={lockedReason}
                      onChange={(checked) => toggle(row.id, checked)}
                    />
                  );
                })}
                {rows.length === 0 && loaded?.ok && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {texts.none || "This shop has no collections yet."}
                  </Text>
                )}
              </BlockStack>
            </div>
            {truncated && (
              <Text as="p" variant="bodySm" tone="subdued">
                {texts.truncated || "This product is in more collections than were loaded."}
              </Text>
            )}
            {loaded?.ok && loaded.truncated && (
              <Text as="p" variant="bodySm" tone="subdued">
                {texts.listTruncated || "This shop has more collections than are listed here."}
              </Text>
            )}
          </BlockStack>
        </div>
      </Popover>
      {error && errorId && (
        <span id={errorId} className="cp-bulk-visually-hidden">
          {error}
        </span>
      )}
    </span>
  );
}
