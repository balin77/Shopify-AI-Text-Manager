/**
 * Where a menu item points — one control for all three shapes of target.
 *
 * Shopify's own menu editor has a single field that answers "link to what?":
 * you type, and it offers pages, collections, products and posts of your shop
 * alongside the fixed destinations (home page, search, catalogue) — and it
 * still takes a pasted URL. Until this existed, this app offered a bare URL box
 * and only on a brand-new item, so every other target meant leaving for the
 * Shopify admin, which is the one thing the menu editor exists to avoid.
 *
 * ── The three shapes ────────────────────────────────────────────────────────
 * They come from `menu-targets.shared.ts`, which reads them off the write
 * path's own constants so the picker cannot offer a type the save refuses:
 * a free URL (HTTP), a target-less type (the type IS the destination), and a
 * resource-bound type (a GID has to be chosen). `menuTargetPatch` builds the
 * patch for all three, so no branch here can forget that switching to a
 * target-less type must CLEAR the resourceId.
 *
 * ── Two rules that are not cosmetic ─────────────────────────────────────────
 * The dropdown FREEZES the page behind it (`useScrollLock`), because these rows
 * live in the app's inner scroll frames that Polaris cannot see — the third
 * time this defect shipped is why CLAUDE.md states it as a rule. The pane
 * getter is SCOPED through the activator's `aria-controls`: a menu renders one
 * of these per row, two can legitimately be open at once during Polaris' enter
 * transition, and a document-wide query would then let the WRONG panel scroll.
 *
 * And an UNRESOLVED target is named, never blanked: an item bound to a resource
 * this app has not synced shows its type and its raw id, because an empty field
 * reads as "no target" and the next save would make that true.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Combobox,
  InlineStack,
  Listbox,
  Text,
} from "@shopify/polaris";
import { useScrollLock } from "../../hooks/useScrollLock";
import {
  looksLikeMenuUrl,
  menuTargetPatch,
  menuTargetlessTypes,
  summarizeMenuTarget,
  type MenuTargetSearchResult,
} from "../../services/menu-targets.shared";

export interface MenuTargetPickerStrings {
  label: string;
  placeholder: string;
  /** "Diese URL verwenden: …" — takes the typed value. */
  useUrl: (value: string) => string;
  /** Section headers, keyed as in MENU_TARGET_GROUPS.labelKey — PLURAL. */
  groupLabels: Record<string, string>;
  /**
   * The SINGULAR name of a resource type, keyed by MenuItemType.
   *
   * Separate from the section headers because they answer different
   * questions: a header names a list ("Produkte"), a resting value names one
   * thing ("Produkt: Vase"). Spending the plural on both read as a bug in
   * every language the app ships in.
   */
  typeNames: Record<string, string>;
  /** Header over the fixed destinations. */
  targetlessGroup: string;
  /** One label per target-less type. */
  targetlessLabels: Record<string, string>;
  /** Shown under a group whose list was cut. */
  moreMatches: string;
  /** Shown when a group's lookup failed. */
  lookupFailed: string;
  /** Shown when nothing matched and the value is not a URL either. */
  noMatches: string;
  /** Under the field: the current target, for a resource we could not name. */
  unresolved: (type: string, id: string) => string;
  /** Under the field: a resource target we could name. */
  resolved: (type: string, title: string) => string;
  /** Nothing chosen yet. */
  noTarget: string;
  /** Blogs come from the article cache — a blog with no posts is not offered. */
  blogsFromArticles: string;
  searching: string;
}

export interface MenuTargetPickerProps {
  type: string;
  url?: string | null;
  resourceId?: string | null;
  /** GID → title, resolved by the loader. */
  targetTitles: Record<string, string>;
  onChange: (patch: { type: string; url: string | null; resourceId: string | null }) => void;
  disabled?: boolean;
  error?: string;
  strings: MenuTargetPickerStrings;
}

/** One flat option the listbox can render, plus what picking it does. */
interface PickerOption {
  id: string;
  label: string;
  subtitle?: string;
  apply: () => { type: string; url: string | null; resourceId: string | null };
}

export function MenuTargetPicker({
  type,
  url,
  resourceId,
  targetTitles,
  onChange,
  disabled,
  error,
  strings,
}: MenuTargetPickerProps) {
  /**
   * `null` = not editing, so the field shows the current target; a string = the
   * merchant is typing and the field shows the query. One state, because a
   * separate "display value" would be a second answer to what the box holds.
   */
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<MenuTargetSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const activatorRef = useRef<HTMLDivElement | null>(null);

  const summary = useMemo(
    () => summarizeMenuTarget({ type, url, resourceId }, (id) => targetTitles[id]),
    [type, url, resourceId, targetTitles],
  );

  /** What the box reads when nobody is typing in it. */
  const restingValue = useMemo(() => {
    if (summary.kind === "url") return summary.url || "";
    if (summary.kind === "targetless") return strings.targetlessLabels[summary.type] ?? summary.type;
    if (summary.kind === "resource") {
      const typeName = strings.typeNames[summary.type] ?? summary.type;
      return summary.resourceTitle
        ? strings.resolved(typeName, summary.resourceTitle)
        : summary.resourceId
          ? strings.unresolved(typeName, summary.resourceId)
          : "";
    }
    return summary.type || "";
  }, [summary, strings]);

  /**
   * The search, debounced.
   *
   * It runs on an EMPTY query too — the dropdown has to be browsable, not only
   * searchable, or a merchant who does not know a product's exact name has no
   * way in. That is one small query per group and only while the popover is up.
   */
  useEffect(() => {
    if (!open) return;
    const q = query ?? "";
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/menu-targets?q=${encodeURIComponent(q)}`);
        const data = (await response.json()) as MenuTargetSearchResult;
        if (!cancelled) setResults(data);
      } catch {
        // A failed fetch leaves the previous list standing and stops the
        // spinner. The fixed destinations and the URL option below do not
        // depend on it, so the picker still works for those.
        if (!cancelled) setResults((prev) => prev ?? { groups: [], failed: [] });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  /**
   * Polaris' popover pane, looked up per event and SCOPED to this picker.
   *
   * Polaris writes the overlay's id onto the activator as `aria-controls`; the
   * pane sits inside the element with that id. The document-wide query is only
   * the fallback for the one frame before the attribute is written — with many
   * rows on a page it would otherwise answer with somebody else's panel.
   */
  const paneRef = useMemo(
    () => ({
      get current(): HTMLElement | null {
        const activator = activatorRef.current?.querySelector<HTMLElement>("[aria-controls]");
        const overlayId = activator?.getAttribute("aria-controls");
        const scoped = overlayId
          ? document.getElementById(overlayId)?.querySelector<HTMLElement>(".Polaris-Popover__Pane")
          : null;
        return (
          scoped ??
          document.querySelector<HTMLElement>(".Polaris-PositionedOverlay .Polaris-Popover__Pane")
        );
      },
    }),
    [],
  );

  const typedUrl = (query ?? "").trim();

  const options = useMemo<PickerOption[]>(() => {
    const out: PickerOption[] = [];
    const q = (query ?? "").trim().toLowerCase();

    if (looksLikeMenuUrl(typedUrl)) {
      out.push({
        id: "url",
        label: strings.useUrl(typedUrl),
        apply: () => menuTargetPatch({ kind: "url", url: typedUrl }),
      });
    }

    for (const targetless of menuTargetlessTypes()) {
      const label = strings.targetlessLabels[targetless] ?? targetless;
      if (q && !label.toLowerCase().includes(q)) continue;
      out.push({
        id: `type:${targetless}`,
        label,
        apply: () => menuTargetPatch({ kind: "targetless", type: targetless }),
      });
    }

    for (const group of results?.groups ?? []) {
      for (const item of group.items) {
        out.push({
          id: `${group.type}:${item.id}`,
          label: item.title,
          subtitle: item.subtitle,
          apply: () => menuTargetPatch({ kind: "resource", type: group.type, id: item.id }),
        });
      }
    }
    return out;
  }, [query, typedUrl, results, strings]);

  const applyById = useCallback(
    (id: string) => {
      const option = options.find((o) => o.id === id);
      if (!option) return;
      onChange(option.apply());
      setQuery(null);
      setOpen(false);
    },
    [options, onChange],
  );

  // Gated on there BEING a popover: Polaris renders none for an empty option
  // list, and freezing the page around a dropdown that is not there reads as
  // the app having hung.
  useScrollLock(open && options.length > 0, paneRef);

  /**
   * The listbox, section by section.
   *
   * Sections are built here rather than flattened into one list because the
   * headers are the point: "Vase" matching a product and a collection is two
   * different links, and a flat list of titles cannot say which is which.
   */
  const listbox = (
    <Listbox onSelect={applyById}>
      {looksLikeMenuUrl(typedUrl) && (
        <Listbox.Option value="url" accessibilityLabel={strings.useUrl(typedUrl)}>
          <Listbox.TextOption>{strings.useUrl(typedUrl)}</Listbox.TextOption>
        </Listbox.Option>
      )}

      <Listbox.Section
        divider={false}
        title={<Listbox.Header>{strings.targetlessGroup}</Listbox.Header>}
      >
        {options
          .filter((o) => o.id.startsWith("type:"))
          .map((o) => (
            <Listbox.Option key={o.id} value={o.id} accessibilityLabel={o.label}>
              <Listbox.TextOption>{o.label}</Listbox.TextOption>
            </Listbox.Option>
          ))}
      </Listbox.Section>

      {(results?.groups ?? []).map((group) => (
        <Listbox.Section
          key={group.type}
          divider={false}
          title={<Listbox.Header>{strings.groupLabels[group.labelKey] ?? group.type}</Listbox.Header>}
        >
          {group.items.map((item) => (
            <Listbox.Option
              key={`${group.type}:${item.id}`}
              value={`${group.type}:${item.id}`}
              accessibilityLabel={item.title}
            >
              <Listbox.TextOption>
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <Text as="span" variant="bodyMd">{item.title}</Text>
                  {item.subtitle && (
                    <Text as="span" variant="bodySm" tone="subdued">{item.subtitle}</Text>
                  )}
                </InlineStack>
              </Listbox.TextOption>
            </Listbox.Option>
          ))}
          {group.truncated && (
            <Listbox.Option value={`more:${group.type}`} disabled accessibilityLabel={strings.moreMatches}>
              <Listbox.TextOption>
                <Text as="span" variant="bodySm" tone="subdued">{strings.moreMatches}</Text>
              </Listbox.TextOption>
            </Listbox.Option>
          )}
          {/* Named, not hidden: blogs are derived from the article cache, so a
              blog without a single post cannot appear in this list at all. A
              merchant hunting for one should learn why rather than conclude the
              picker is broken. */}
          {group.type === "BLOG" && (
            <Listbox.Option value="blogNote" disabled accessibilityLabel={strings.blogsFromArticles}>
              <Listbox.TextOption>
                <Text as="span" variant="bodySm" tone="subdued">{strings.blogsFromArticles}</Text>
              </Listbox.TextOption>
            </Listbox.Option>
          )}
        </Listbox.Section>
      ))}

      {(results?.failed ?? []).length > 0 && (
        <Listbox.Option value="failed" disabled accessibilityLabel={strings.lookupFailed}>
          <Listbox.TextOption>
            <Text as="span" variant="bodySm" tone="critical">{strings.lookupFailed}</Text>
          </Listbox.TextOption>
        </Listbox.Option>
      )}

      {options.length === 0 && (
        <Listbox.Option value="none" disabled accessibilityLabel={loading ? strings.searching : strings.noMatches}>
          <Listbox.TextOption>
            <Text as="span" variant="bodySm" tone="subdued">
              {loading ? strings.searching : strings.noMatches}
            </Text>
          </Listbox.TextOption>
        </Listbox.Option>
      )}
    </Listbox>
  );

  return (
    <div
      ref={activatorRef}
      className="app-field-clear-scope"
      // Escape closes Polaris' own popover without moving focus, so no blur
      // fires — and this component would be left holding the page scroll with
      // no panel left to release it. Same mirror, same reason, as
      // ChipCombobox's.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setQuery(null);
          setOpen(false);
        }
      }}
    >
      <Combobox
        activator={
          <Combobox.TextField
            label={strings.label}
            value={query ?? restingValue}
            onChange={(next) => {
              setQuery(next);
              setOpen(true);
            }}
            // Focus CLEARS the box to a query, the way every combobox does —
            // and blur puts the current target back, so a merchant who clicked
            // in and changed their mind is not left looking at an empty field
            // that suggests the link is gone.
            onFocus={() => {
              setQuery("");
              setOpen(true);
            }}
            onBlur={() => {
              setQuery(null);
              setOpen(false);
            }}
            placeholder={strings.placeholder}
            disabled={disabled}
            error={error}
            helpText={targetHelpText(summary, strings)}
            autoComplete="off"
          />
        }
      >
        {/* Polaris renders no popover for an empty child, and an empty dropdown
            on focus reads as a control that ignored the click — so the listbox
            always carries at least its own "nothing matched" row. */}
        {listbox}
      </Combobox>
    </div>
  );
}

/**
 * The line under the box.
 *
 * It exists for exactly one case and is silent otherwise: a resource target
 * whose title this app could not resolve. Repeating a target the box already
 * shows would be noise; leaving the unresolved one unexplained would let a
 * merchant read a raw GID as a defect in their menu rather than in our cache.
 */
function targetHelpText(
  summary: ReturnType<typeof summarizeMenuTarget>,
  strings: MenuTargetPickerStrings,
): string | undefined {
  if (summary.kind === "resource" && summary.resourceId && !summary.resourceTitle) {
    return strings.unresolved(strings.typeNames[summary.type] ?? summary.type, summary.resourceId);
  }
  if (summary.kind === "unknown" && !summary.type) return strings.noTarget;
  return undefined;
}
