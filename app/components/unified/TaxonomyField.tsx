/**
 * PLAN_CONTENT_CREATION §Phase 3.1 — the product category picker.
 *
 * ── Two ways in, one popover ────────────────────────────────────────────────
 * Shopify's own control does both and this one mirrors it, because the two
 * halves answer different merchants. SEARCH serves the one who knows the word
 * Shopify filed their product under; BROWSE serves the one who does not, and
 * that is most of them — "Vasen" lives under Home & Garden > Decor, which is
 * not a guess anybody makes from an empty search box.
 *
 * The browse half is deliberately shaped after Shopify's, down to the details
 * that look cosmetic and are not:
 *
 *   - The search box stays at the TOP of the popover at every depth. Typing is
 *     always available, so a merchant who ran out of patience three levels
 *     down does not have to climb back out to use it.
 *   - A row with children DESCENDS; it does not select. One row, one meaning.
 *   - The branch you descended into then appears as the FIRST entry of its own
 *     level, and that entry is the only way to choose it. A branch IS a valid
 *     value on Shopify's side, so it has to be reachable — but it must not be
 *     reachable by mis-clicking the row you meant to open.
 *   - Above it, one row back. It names where it goes, not just "back".
 *
 * ── Order comes from Shopify, and is never re-sorted here ───────────────────
 * MEASURED on a live shop (2026-08-19, Settings → Probes → Taxonomy): a bare
 * `categories(first: n)` IS the top level — 26 nodes, every one `isRoot`, no
 * next page — and they arrive in the taxonomy's canonical order (Animals,
 * Apparel, Arts, Baby, Business, Cameras, …). Sorting them here would give a
 * different first screen from the one the merchant knows out of their admin.
 *
 * ── The names come back in ENGLISH, and the API has no second opinion ──────
 * The same measurement on a shop whose admin renders "Tiere & Tierbedarf"
 * returned "Animals & Pet Supplies". BOTH doors over this transport are shut,
 * and each was measured rather than assumed: `@inContext` is NOT DEFINED in
 * the Admin schema at all, and an `Accept-Language` header is accepted and
 * changes nothing — for every locale of the shop INCLUDING its primary one.
 * "Accepted but identical" is the outcome that would otherwise have been read
 * as success, which is why the probe reports it apart from "refused".
 *
 * The German names do exist: Shopify publishes the whole taxonomy per locale
 * as open data (`Shopify/product-taxonomy`, `dist/<locale>/categories.txt`,
 * ~2 MB, 14 608 lines of `GID : full path`, keyed by the SAME GIDs the API
 * returns). That is where the admin gets them. Wiring it up is a decision
 * about taking an external dependency, not something this component can do on
 * its own — so until it is made, the paths are shown as the API hands them
 * over, and the earlier claim that they arrive localized is retired.
 *
 * ── What an empty result means ──────────────────────────────────────────────
 * Never "no such category". A failed lookup says so, and a search that is too
 * short says THAT, because "nothing matched" and "keep typing" and "the lookup
 * broke" are three different things and only one of them means the merchant
 * should try different words. The browse half carries the same rule: an empty
 * level and an unreachable one are separate states.
 *
 * ── The control and its panel are ONE width ────────────────────────────────
 * Both failure modes were shipped: a panel with a width of its own hangs out
 * past a narrower control, and a panel that simply takes the control's width
 * spans the whole page, because this field is as wide as the editor column.
 * So the CEILING sits on the control (`--app-dropdown-panel-max-width`, in
 * responsive.css with every other width in this app — never a number in here),
 * and Polaris' own `fullWidth` hands the panel exactly the width of the box it
 * hangs off. One ceiling, in one place: the closed box and the open one cannot
 * come to disagree, and there is no second clamp to keep in step with the first.
 *
 * `fullWidth` is not a convenience here, it is the only thing that makes the
 * two agree, and it does THREE things Polaris otherwise does against us. It
 * gives the overlay container the activator's measured width; it lifts
 * `.Polaris-Popover__Content`'s own `max-width: 25rem` (= 400px), which is the
 * clamp that used to cut a 480px field's panel short by 80px no matter what
 * width we asked for; and it swaps the popover's 8px side margins for `auto`,
 * so the panel sits on the field's edges instead of 8px inside the left one.
 * A width measured by hand here could beat neither of the last two, which is
 * why the measurement this component used to carry is gone rather than kept
 * as a belt: a second number that cannot win is only a number that drifts.
 * `preferInputActivator={false}` keeps the measurement on the box — the search
 * field inside the panel is an `<input>`, and it only stays out of Polaris'
 * `querySelector` because the overlay renders through a portal.
 *
 * ── The panel is a fixed box, and the content lives inside it ───────────────
 * Every row is `minWidth: 0` with a reserved trailing slot: a flex item does
 * not shrink below its own content by default, so one long path would set the
 * width of the whole list, and the popover would scroll sideways with the
 * chevrons pushed out of sight. The reserved slot is also what puts every
 * chevron on ONE vertical edge instead of wherever each label happens to end.
 *
 * ── The page behind it holds still ─────────────────────────────────────────
 * `useScrollLock` — the popover is positioned once against its activator and
 * the pages here scroll INSIDE a container Polaris cannot see, so a scroll
 * while it is open leaves it hanging over nothing. See the hook for why the
 * lock cancels the event instead of hiding the overflow.
 *
 * ── The label on the closed control ────────────────────────────────────────
 * The CATEGORY, not the path to it: "Vasen", not "Heim & Garten > Dekoration >
 * Vasen". The path is what tells two categories called "Shirts" apart, so it
 * does not disappear — it is the control's `title`, one hover away, and the
 * list inside the popover shows paths throughout. What the merchant reads
 * without opening anything is the thing they chose.
 *
 * And it is read in the shop's language, which takes a lookup: the label comes
 * from the CACHE, and the sync filled it from the Admin API, the one source
 * that only speaks English (`kind=taxonomy-name`). Without that the field was
 * the single English spot in an otherwise translated picker. Three sources, in
 * this order — the category picked in this session (already localized, it came
 * out of the localized list), the localized lookup for the stored id, and the
 * cached label as it is. Each one is only used while it belongs to the value
 * currently held; a label under a different category would be a confident lie.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BlockStack,
  Banner,
  Box,
  Button,
  Icon,
  InlineStack,
  Popover,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { ArrowLeftIcon, ChevronRightIcon, SearchIcon } from "@shopify/polaris-icons";
import { useScrollLock } from "../../hooks/useScrollLock";
import { leafNameOf } from "../../services/taxonomy-localization.shared";
import { FieldClearOverlay, FieldLabel } from "./FieldChrome";
import type { TaxonomyOption } from "../../routes/api.product-taxonomy";

export interface TaxonomyFieldProps {
  /** The TaxonomyCategory GID, or "" when the product has none. */
  value: string;
  onChange: (value: string) => void;
  /**
   * Told about the category the merchant just picked, with its label.
   *
   * `onChange` carries the GID alone, which is all the value map needs — but
   * deriving a product type from the choice needs the NAME, and it exists
   * nowhere else at that moment: the cache still holds the previous category
   * and a fresh lookup would be a second request for something already in
   * hand. Optional, so the field stays usable without that feature.
   */
  onPick?: (option: TaxonomyOption) => void;
  /** Full path of the current category, from the cache. "" when unknown. */
  currentLabel: string;
  label: string;
  disabled?: boolean;
  /** False ⇒ the row was never attribute-synced. "" then means UNKNOWN, not
   *  "no category" — the same discriminator every other attribute reads. */
  known?: boolean;
  /** The way out of that state. */
  onReload?: () => void;
  /** Set in a foreign locale — the reason, shown instead of silence. */
  foreignLocaleHint?: string;
  /** Key into `t.help` — the question mark beside the label. The sentence
   *  saying what this field is FOR used to sit under the control as prose;
   *  it answers a question a merchant has once, and it pushed the picker down
   *  the card every time they did not. */
  helpKey?: string;
  t: {
    search?: string;
    searching?: string;
    keepTyping?: string;
    noMatches?: string;
    lookupFailed?: string;
    none?: string;
    /* `clear` was the label of this field's own Clear button. It is drawn by
       the shared `FieldClearOverlay` now, which takes its word from
       `t.common.clear` like every other field. */
    unknown?: string;
    reload?: string;
    /** Marker on a category that is a branch rather than a specific type. */
    broad?: string;
    /** The row that climbs one level. `{name}` = where it goes. */
    backTo?: string;
    /** The same row at depth 1, where the level above has no name. */
    backToAll?: string;
    /** The row that picks the branch you are standing in. */
    chooseThis?: string;
    /** A level that came back with nothing below it. */
    noChildren?: string;
    /** A level Shopify truncated. */
    levelTruncated?: string;
  };
}

/** Long enough that a keystroke does not cost a request, short enough that the
 *  list feels live. The route additionally refuses searches under 2 chars. */
const DEBOUNCE_MS = 300;

/** The width every row keeps free at its right edge. A Polaris `Icon` is 20px,
 *  so the chevron fills the slot exactly and the rows that have none still end
 *  their text where the ones that do end theirs. */
const TRAILING_SLOT = "1.25rem";

/** The ceiling for BOTH boxes — spent ONCE, as the control's max-width; the
 *  panel inherits it because Polaris' `fullWidth` gives it the control's own
 *  measurement. The VALUE lives in responsive.css with every other width in
 *  this app; this is only its name. */
const PANEL_MAX_TOKEN = "--app-dropdown-panel-max-width";

/** One entry of the browse stack: what was clicked to get here. The root level
 *  is the empty stack, so it needs no entry of its own. */
interface Crumb {
  id: string;
  name: string;
  fullName: string;
  isLeaf: boolean;
}

export function TaxonomyField({
  value,
  onChange,
  onPick,
  currentLabel,
  label,
  disabled,
  known = true,
  onReload,
  foreignLocaleHint,
  helpKey,
  t,
}: TaxonomyFieldProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /**
   * The label of a category chosen in THIS session.
   *
   * `currentLabel` comes from the cache and only refreshes after a save plus a
   * loader revalidation — so without this, picking a category rendered "Not
   * set" (or, worse, kept showing the PREVIOUS one). A change the UI reports
   * as no change is indistinguishable from a mis-click.
   */
  const [pendingLabel, setPendingLabel] = useState<{ id: string; fullName: string; name: string } | null>(
    null,
  );

  /**
   * The stored category's name in the shop's language, or null while there is
   * none to be had (English shop, no import yet, a category newer than the
   * pinned release). Null is never rendered as a blank — the cached label
   * stands in.
   */
  const [localizedCurrent, setLocalizedCurrent] = useState<
    { id: string; fullName: string; name: string } | null
  >(null);
  const [results, setResults] = useState<TaxonomyOption[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "tooShort" | "failed">("idle");

  /** Where in the tree the browse half is standing. Empty = the top level. */
  const [path, setPath] = useState<Crumb[]>([]);
  const [level, setLevel] = useState<TaxonomyOption[] | null>(null);
  const [levelTruncated, setLevelTruncated] = useState(false);
  const [levelState, setLevelState] = useState<"idle" | "loading" | "failed">("idle");

  /**
   * Bumped per request, once for each half.
   *
   * Responses can arrive out of order — a slow request for "shi" landing after
   * a fast one for "shirt" would replace the right list with a stale one, and
   * the merchant would watch their results change back. The browse half has
   * the same race with a fast click through two levels.
   */
  const searchToken = useRef(0);
  const levelToken = useRef(0);

  /**
   * The one element inside the popover that may still scroll while the page
   * behind it is frozen. The panel around it is deliberately NOT allowed — see
   * `useScrollLock`.
   */
  const listRef = useRef<HTMLDivElement | null>(null);
  useScrollLock(open && !disabled, listRef);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;

  useEffect(() => {
    if (!searching) {
      setResults(null);
      setState("idle");
      return;
    }

    const token = ++searchToken.current;
    setState("loading");
    const timer = setTimeout(() => {
      fetch(`/api/product-taxonomy?kind=taxonomy&q=${encodeURIComponent(trimmedQuery)}`)
        .then((r) => r.json())
        .then((data) => {
          if (token !== searchToken.current) return;
          if (!data?.success) {
            // A failed lookup is NOT an empty result. Saying "no matches" here
            // would send the merchant looking for different words for a
            // category that exists.
            setState("failed");
            setResults(null);
            return;
          }
          if (data.tooShort) {
            setState("tooShort");
            setResults(null);
            return;
          }
          setState("idle");
          setResults((data.categories ?? []) as TaxonomyOption[]);
        })
        .catch(() => {
          if (token !== searchToken.current) return;
          setState("failed");
          setResults(null);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [trimmedQuery, searching]);

  /** Loads one level. `parentId` "" is the top level. */
  const loadLevel = useCallback((parentId: string) => {
    const token = ++levelToken.current;
    setLevelState("loading");
    setLevel(null);
    setLevelTruncated(false);
    fetch(`/api/product-taxonomy?kind=taxonomy-children&parent=${encodeURIComponent(parentId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (token !== levelToken.current) return;
        if (!data?.success) {
          setLevelState("failed");
          return;
        }
        setLevelState("idle");
        setLevel((data.level?.categories ?? []) as TaxonomyOption[]);
        setLevelTruncated(data.level?.truncated === true);
      })
      .catch(() => {
        if (token !== levelToken.current) return;
        setLevelState("failed");
      });
  }, []);

  // The top level is fetched when the popover opens, not on mount: most
  // merchants never touch the category of most products, and a request per
  // rendered product row is a request per product for nothing.
  //
  // A FAILED level is retried on the next open, not left standing. At the root
  // there is no Back row to reload from, so without this a single failed fetch
  // made the picker permanently empty until the page was reloaded — reopening
  // it is the merchant asking again, and the effect runs once per open, so it
  // cannot spin.
  useEffect(() => {
    if (!open) return;
    if (level === null && levelState !== "loading") loadLevel(path[path.length - 1]?.id ?? "");
    // Only `open` drives this: re-running it on every level change would
    // refetch the level that just arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const descend = useCallback(
    (option: TaxonomyOption) => {
      setPath((prev) => [...prev, { id: option.id, name: option.name, fullName: option.fullName, isLeaf: option.isLeaf }]);
      loadLevel(option.id);
    },
    [loadLevel],
  );

  const ascend = useCallback(() => {
    // Computed OUT here, never inside the `setPath` updater: an updater runs in
    // the render phase and React invokes it twice under StrictMode and on a
    // replayed render, so a fetch started in there fires two requests per click
    // (app.menus.tsx carries the same rule for the same reason).
    const next = path.slice(0, -1);
    setPath(next);
    loadLevel(next[next.length - 1]?.id ?? "");
  }, [path, loadLevel]);

  /**
   * Ask for the stored category's localized name.
   *
   * Keyed on `value` alone: one request per category a merchant actually looks
   * at, and none at all for a product without one. The response is dropped
   * unless the value is still the one it was asked for — switching products in
   * the item list is exactly the race that would otherwise label a product with
   * its predecessor's category.
   */
  useEffect(() => {
    if (!value) {
      setLocalizedCurrent(null);
      return;
    }
    let current = true;
    fetch(`/api/product-taxonomy?kind=taxonomy-name&id=${encodeURIComponent(value)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!current) return;
        // A failed lookup and "no localized name" land in the same place on
        // purpose: both mean the cached label is the best one available, and
        // neither is worth a message about a word that is already on screen.
        setLocalizedCurrent(data?.success && data.category ? data.category : null);
      })
      .catch(() => {
        if (current) setLocalizedCurrent(null);
      });
    return () => {
      current = false;
    };
  }, [value]);

  const choose = useCallback(
    (option: TaxonomyOption) => {
      onChange(option.id);
      onPick?.(option);
      setPendingLabel({ id: option.id, fullName: option.fullName, name: option.name });
      // Closed and reset, so the next open starts at the top rather than
      // wherever the last choice happened to leave the stack.
      setOpen(false);
      setQuery("");
      setResults(null);
      setPath([]);
      setLevel(null);
      setLevelState("idle");
      searchToken.current += 1;
      levelToken.current += 1;
    },
    [onChange, onPick],
  );

  // Every label survives only as long as the value it belongs to. A switch to
  // another item, an undo, or a save-and-reload all move `value` away from it,
  // and a name under a different category would be a confident lie.
  const shownEntry =
    (pendingLabel?.id === value ? pendingLabel : null) ??
    (localizedCurrent?.id === value ? localizedCurrent : null);
  // The cached label is the fallback, and it carries no leaf of its own — it is
  // a path, so the leaf is split out of it with the same rule the import uses.
  const shownPath = shownEntry?.fullName || currentLabel;
  const shownName = shownEntry?.name || leafNameOf(currentLabel);
  const here = path[path.length - 1];

  if (foreignLocaleHint) {
    return (
      <BlockStack gap="200">
        <FieldLabel label={label} helpKey={helpKey} />
        <Banner tone="info"><p>{foreignLocaleHint}</p></Banner>
      </BlockStack>
    );
  }

  if (!known) {
    return (
      <BlockStack gap="200">
        <FieldLabel label={label} helpKey={helpKey} />
        <Text as="p" variant="bodySm" tone="subdued">
          {t.unknown || "Not loaded from Shopify yet — reload this product to see its category."}
        </Text>
        {onReload && <Box><Button onClick={onReload}>{t.reload || "Reload"}</Button></Box>}
      </BlockStack>
    );
  }

  /**
   * One tappable row of the popover. Full width, so the whole strip is the
   * target rather than the few pixels the text happens to occupy.
   *
   * Three rules keep the list inside the panel instead of setting its width:
   *
   *   - The label column is `minWidth: 0` and breaks anywhere. A flex item
   *     refuses by default to shrink below its own content, so ONE long path
   *     ("Apparel & Accessories > Clothing > Shirts & Tops") would widen every
   *     row, the panel would scroll sideways, and the chevrons would sit off
   *     screen. `overflow-wrap` is inherited, so the `InlineStack`s inside it
   *     need nothing of their own.
   *   - `boxSizing: border-box`, so the padding is spent INSIDE the width the
   *     panel gave the row rather than added to it.
   *   - The trailing slot is reserved on EVERY row, chevron or not, and is the
   *     last thing in the row. That is what lines the arrows up on one vertical
   *     edge — with the slot rendered only where there is an arrow, each one
   *     landed wherever its own label happened to end.
   */
  const row = (
    key: string,
    content: React.ReactNode,
    onClick: () => void,
    trailing?: React.ReactNode,
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: "0.5rem",
        background: "none",
        border: "none",
        borderRadius: "6px",
        cursor: "pointer",
        textAlign: "left",
        font: "inherit",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "#f1f1f1"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
    >
      <span style={{ flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>{content}</span>
      <span
        style={{
          flex: "0 0 auto",
          width: TRAILING_SLOT,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        {trailing}
      </span>
    </button>
  );

  const chevron = <Icon source={ChevronRightIcon} tone="subdued" />;

  return (
    // The Clear button sits in the label row's top-right corner, the one place
    // every field in this editor puts it. It used to sit BESIDE the activator,
    // where it competed with a category path for the same line — which is what
    // the `minWidth: 0` note below was about.
    <FieldClearOverlay
      onClear={disabled ? undefined : () => onChange("")}
      hasValue={!!value}
      fieldLabel={label}
    >
      <BlockStack gap="200">
        <FieldLabel label={label} helpKey={helpKey} />

        {/* No longer a ROW: the Clear button that used to share it moved into
            the label's corner with every other field's. Kept as a flex line
            because the box below it is `flex: 1 1 auto`. */}
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          {/* THE max-width of this picker lives here — Polaris measures this
              box for the panel below, so the open list is exactly as wide as
              the closed one.

              `minWidth: 0` is the other half: the button carries a whole
              category PATH, and without it that string would set the width of
              the field. The path then wraps inside the button (Polaris sets no
              `nowrap`), and `overflowWrap` — inherited, so it reaches Polaris'
              own text span — is what keeps a single long word from doing the
              widening the wrapping otherwise prevents. */}
          <div
            // The whole path, for the one question the leaf cannot answer:
            // WHICH "Shirts" is this. It sits on the box rather than on the
            // button because Polaris' Button takes a string and nothing else.
            title={shownPath || undefined}
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              maxWidth: `var(${PANEL_MAX_TOKEN})`,
              overflowWrap: "anywhere",
            }}
          >
            <Popover
              active={open && !disabled}
              onClose={() => setOpen(false)}
              preferredAlignment="left"
              // See the header: this is what makes the open box the same width
              // as the closed one, by handing the panel the activator's own
              // measurement and lifting Polaris' 400px cap on it.
              fullWidth
              // The measurement must stay on the box. Polaris prefers an
              // `<input>` inside the activator, and the search field of this
              // very panel is one — it is out of reach only because the overlay
              // renders through a portal, which is too thin a rail to rely on.
              preferInputActivator={false}
              activator={
                <Button
                  disclosure
                  disabled={disabled}
                  onClick={toggle}
                  // Left-aligned like a value, not centred like an action: this
                  // button reads as the field's content. It shows the LEAF —
                  // the whole path is one hover away, on the box's `title`
                  // above.
                  textAlign="left"
                  fullWidth
                >
                  {/* The category, with the whole path one hover away on the box
                      around this button (Polaris types `children` as a string, so
                      the tooltip cannot ride in here) — see the header. A stored
                      id with no label at all is possible on a row that has not
                      been attribute-synced since the category was set; the id is
                      not a name, so the field says "not set" rather than printing
                      a GID at the merchant. */}
                  {(value && shownName) || t.none || "Not set"}
                </Button>
              }
            >
              {/* The box everything else has to fit into. `fullWidth` above has
                  already given every Polaris box in the chain the activator's
                  width, so this one only has to FILL it — a width of its own
                  here would be the second clamp the header rules out. The
                  padding is counted INSIDE that width. */}
              <div
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "0.5rem",
                }}
              >
                <BlockStack gap="200">
                  {/* Always at the top, at every depth — see the header. */}
                  <TextField
                    label=""
                    labelHidden
                    value={query}
                    onChange={setQuery}
                    autoComplete="off"
                    prefix={<Icon source={SearchIcon} tone="subdued" />}
                    placeholder={t.search || "Search categories…"}
                    clearButton
                    onClearButtonClick={() => setQuery("")}
                  />

                  {/* The ONE element that still scrolls while the page behind
                      the popover is frozen — hence the ref. `overscrollBehavior:
                      contain` stops a wheel at the end of the list from chaining
                      through to that page, which is the movement the lock exists
                      to prevent; `overflowX: hidden` makes a row that still manages
                      to overflow wrap or clip rather than turn the panel into a
                      horizontal scroller. */}
                  <div
                    ref={listRef}
                    style={{
                      maxHeight: "22rem",
                      overflowY: "auto",
                      overflowX: "hidden",
                      overscrollBehavior: "contain",
                    }}
                  >
                    {searching ? (
                      <BlockStack gap="050">
                        {state === "loading" && (
                          <Box padding="200">
                            <InlineStack gap="200" blockAlign="center">
                              <Spinner size="small" />
                              <Text as="span" variant="bodySm" tone="subdued">
                                {t.searching || "Searching…"}
                              </Text>
                            </InlineStack>
                          </Box>
                        )}

                        {state === "tooShort" && (
                          <Box padding="200">
                            <Text as="p" variant="bodySm" tone="subdued">
                              {t.keepTyping || "Type at least two characters."}
                            </Text>
                          </Box>
                        )}

                        {state === "failed" && (
                          <Banner tone="warning">
                            <p>{t.lookupFailed || "The category list could not be loaded. Try again in a moment."}</p>
                          </Banner>
                        )}

                        {state === "idle" && results !== null && results.length === 0 && (
                          <Box padding="200">
                            <Text as="p" variant="bodySm" tone="subdued">
                              {t.noMatches || "No category matches that."}
                            </Text>
                          </Box>
                        )}

                        {state === "idle" &&
                          results !== null &&
                          results.map((option) =>
                            row(
                              option.id,
                              <InlineStack gap="200" blockAlign="center" wrap>
                                {/* The whole path: a search for "shirt" returns
                                    several, and only the path tells them apart. */}
                                <Text as="span" variant="bodyMd">{option.fullName}</Text>
                                {/* A branch IS a valid value on Shopify's side, so
                                    this is a note and not a refusal — but a product
                                    filed under a branch shows up wrong in
                                    marketplace listings, and nothing else would say
                                    so until then. */}
                                {!option.isLeaf && (
                                  <Text as="span" variant="bodySm" tone="subdued">{t.broad || "(broad)"}</Text>
                                )}
                              </InlineStack>,
                              () => choose(option),
                            ),
                          )}
                      </BlockStack>
                    ) : (
                      <BlockStack gap="050">
                        {here &&
                          row(
                            "__back",
                            <InlineStack gap="200" blockAlign="center">
                              <Icon source={ArrowLeftIcon} tone="subdued" />
                              <Text as="span" variant="bodyMd" tone="subdued">
                                {path.length > 1
                                  ? (t.backTo || "Back to {name}").replace("{name}", path[path.length - 2].name)
                                  : t.backToAll || "Back to all"}
                              </Text>
                            </InlineStack>,
                            ascend,
                          )}

                        {/* The branch you are standing in — the ONE way to choose
                            it, so that opening a row and picking it stay separate
                            actions. */}
                        {here &&
                          row(
                            "__self",
                            <InlineStack gap="200" blockAlign="center" wrap>
                              <Text as="span" variant="bodyMd" fontWeight="semibold">{here.name}</Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {t.chooseThis || "choose this category"}
                              </Text>
                            </InlineStack>,
                            () =>
                              choose({
                                id: here.id,
                                name: here.name,
                                fullName: here.fullName,
                                isLeaf: here.isLeaf,
                              }),
                          )}

                        {levelState === "loading" && (
                          <Box padding="200">
                            <InlineStack gap="200" blockAlign="center">
                              <Spinner size="small" />
                              <Text as="span" variant="bodySm" tone="subdued">
                                {t.searching || "Searching…"}
                              </Text>
                            </InlineStack>
                          </Box>
                        )}

                        {levelState === "failed" && (
                          <Banner tone="warning">
                            <BlockStack gap="200">
                              <p>{t.lookupFailed || "The category list could not be loaded. Try again in a moment."}</p>
                              {/* The way out, spelled out. Closing and reopening
                                  also retries now, but nothing on screen says so. */}
                              <Box>
                                <Button onClick={() => loadLevel(here?.id ?? "")}>
                                  {t.reload || "Reload"}
                                </Button>
                              </Box>
                            </BlockStack>
                          </Banner>
                        )}

                        {levelState === "idle" && level !== null && level.length === 0 && (
                          <Box padding="200">
                            <Text as="p" variant="bodySm" tone="subdued">
                              {t.noChildren || "This category has no subcategories."}
                            </Text>
                          </Box>
                        )}

                        {levelState === "idle" &&
                          level !== null &&
                          level.map((option) =>
                            // A row DESCENDS while it has children and CHOOSES
                            // when it does not. A leaf has no level to open, and
                            // making it descend into an empty screen would be a
                            // dead end at exactly the moment the merchant is done.
                            row(
                              option.id,
                              <Text as="span" variant="bodyMd">{option.name}</Text>,
                              () => (option.isLeaf ? choose(option) : descend(option)),
                              option.isLeaf ? undefined : chevron,
                            ),
                          )}

                        {levelTruncated && (
                          <Box padding="200">
                            <Text as="p" variant="bodySm" tone="subdued">
                              {t.levelTruncated ||
                                "This level has more subcategories than were loaded — use the search above."}
                            </Text>
                          </Box>
                        )}
                      </BlockStack>
                    )}
                  </div>
                </BlockStack>
              </div>
            </Popover>
          </div>
        </InlineStack>
      </BlockStack>
    </FieldClearOverlay>
  );
}
