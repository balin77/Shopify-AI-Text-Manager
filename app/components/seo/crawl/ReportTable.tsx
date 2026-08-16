/**
 * The crawl/on-page report table primitives (PLAN_SEO_CRAWL_EXPANSION §3.7).
 *
 * These were route-local in `app.seo.crawl.tsx` until the on-page tab needed
 * exactly the same rows. Moving them out is a PRECONDITION of that split, not
 * a tidy-up: two report tables with independently drifting styling is the
 * outcome the shared module prevents.
 *
 * Layout note (kept from the original): rows used to be an `InlineStack` with
 * `align="space-between"`, so a row without an editor link pushed its badge to
 * the right edge while a row with one didn't — the status column zig-zagged
 * down the list. Each section is now ONE css grid and every row contributes
 * one cell per column, empty cells included, so the columns are defined by the
 * section rather than by whatever each row happens to carry.
 *
 * Client-safe by construction: nothing here imports `crawl.service` (which
 * drags `url-resolver.server` into the client bundle) — `statusClass` is
 * computed in the loader and passed in.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useFetcher } from "react-router";
import { BlockStack, Badge, Button, Text, Tooltip } from "@shopify/polaris";
import { EditIcon } from "@shopify/polaris-icons";
import type { AuditType } from "../../../services/seo/audit.service";

/** Mirrors `LinkStatusClass` from crawl.service without importing it. */
export type ReportStatusClass = "ok" | "broken" | "server_error" | "blocked";

/** A page the crawler actually fetched. */
export interface CrawledPageRow {
  url: string;
  title: string | null;
  statusCode: number;
  /** Classified server-side — see the module note above. */
  statusClass: ReportStatusClass;
  responseMs: number;
  resourceType: AuditType | null;
  resourceId: string | null;
  /** §4.4 — observed redirect chain length, rendered as a badge behind the
   *  status. 0 on every row of a snapshot crawled before the column existed. */
  redirectHops?: number;
}

/** url · response time · status · action */
export const PAGE_COLUMNS = "minmax(0, 1fr) auto auto auto";
/** url · status · action */
export const STATUS_COLUMNS = "minmax(0, 1fr) auto auto";
/** url · one trailing column (badge or action, depending on the section) */
export const ACTION_COLUMNS = "minmax(0, 1fr) auto";

const REPORT_GRID_STYLE: CSSProperties = {
  display: "grid",
  columnGap: "var(--p-space-400)",
  rowGap: "var(--p-space-200)",
  alignItems: "center",
};
/** URLs are long and unbreakable — the first column takes the slack. */
const MAIN_CELL_STYLE: CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };
const TRAILING_CELL_STYLE: CSSProperties = { justifySelf: "end" };
const INDENT_STYLE: CSSProperties = { paddingInlineStart: "var(--p-space-500)" };
const GROUP_SPACING_STYLE: CSSProperties = { marginBlockStart: "var(--p-space-300)" };

export function ReportGrid({ columns, children }: { columns: string; children: ReactNode }) {
  return <div style={{ ...REPORT_GRID_STYLE, gridTemplateColumns: columns }}>{children}</div>;
}

/** One row of a `ReportGrid`. Renders a plain fragment on purpose: the cells
 *  have to be direct children of the grid to participate in its columns.
 *  `spacedAbove` separates groups (a broken page from the previous page's
 *  link sources) — the grid's uniform rowGap alone can't tell them apart. */
export function ReportRow({ cells, spacedAbove }: { cells: ReactNode[]; spacedAbove?: boolean }) {
  return (
    <>
      {cells.map((cell, i) => (
        <div
          key={i}
          style={{
            ...(i === 0 ? MAIN_CELL_STYLE : TRAILING_CELL_STYLE),
            ...(spacedAbove ? GROUP_SPACING_STYLE : null),
          }}
        >
          {cell}
        </div>
      ))}
    </>
  );
}

/** Sub-rows (a broken page's link sources) stay in the same grid — indenting
 *  the text, not the row, keeps their action column aligned. */
export function Indent({ children }: { children: ReactNode }) {
  return <div style={INDENT_STYLE}>{children}</div>;
}

/** The editor link, as the icon-with-tooltip used across the SEO section. */
export function EditAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip content={label}>
      <Button variant="plain" size="slim" icon={EditIcon} accessibilityLabel={label} onClick={onClick} />
    </Tooltip>
  );
}

/** "Showing the first N of M" — rendered only when the row cap actually
 *  dropped rows, so a complete list stays silent. */
export function CapNotice({ shown, total, template }: { shown: number; total: number; template: string }) {
  if (total <= shown) return null;
  return (
    <Text as="p" variant="bodySm" tone="subdued">
      {template.replace("{shown}", String(shown)).replace("{total}", String(total))}
    </Text>
  );
}

/**
 * "Export CSV" for the currently shown category (PLAN_SEO_CRAWL_EXPANSION §5).
 *
 * Goes through `useFetcher().load()` + a client-side Blob download, not a
 * plain link: a top-level navigation inside the embedded app lands on the App
 * Bridge HTML shell instead of the CSV body. Same mechanism as the redirects
 * export, including the consumed-key guard so one click yields exactly one
 * download even when the fetcher re-renders.
 *
 * The export route re-checks the plan itself — it is GET-reachable without
 * this button (§5.2).
 */
export function CsvExportButton({
  path,
  category,
  label,
  emptyLabel,
}: {
  /** Resource route, e.g. "/app/seo/crawl/export". */
  path: string;
  category: string;
  label: string;
  /** Shown once when the export came back with zero rows. */
  emptyLabel?: string;
}) {
  const fetcher = useFetcher<{ csv: string; filename: string; rowCount: number; error?: string }>();
  const consumedKey = useRef<string | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || fetcher.data.error) return;
    const { csv, filename, rowCount } = fetcher.data;
    const key = `${filename}:${rowCount}`;
    if (consumedKey.current === key) return;
    consumedKey.current = key;
    if (!csv) return;

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [fetcher.state, fetcher.data]);

  const empty = fetcher.state === "idle" && fetcher.data && !fetcher.data.error && fetcher.data.rowCount === 0;

  return (
    <>
      <Button
        size="slim"
        loading={fetcher.state !== "idle"}
        onClick={() => {
          // Re-clicking the same category has to download again, so the guard
          // is reset here rather than keyed only by the response.
          consumedKey.current = null;
          fetcher.load(`${path}?category=${encodeURIComponent(category)}`);
        }}
      >
        {label}
      </Button>
      {empty && emptyLabel && (
        <Text as="span" variant="bodySm" tone="subdued">{emptyLabel}</Text>
      )}
    </>
  );
}

/** One crawled page: URL (plus its title), HTTP status, server time and — when
 *  the URL resolved to a shop resource — the editor icon. */
export function PageRowLine({
  page,
  openLabel,
  onOpen,
  redirectLoopLabel,
  hopsLabel,
}: {
  page: CrawledPageRow;
  openLabel: string;
  onOpen: (type: AuditType, id: string) => void;
  redirectLoopLabel: string;
  /** "→ {count} hops" template (§4.4). Omitted = no hop badge. */
  hopsLabel?: string;
}) {
  const tone = page.statusClass === "ok" ? "success" : page.statusClass === "blocked" ? "warning" : "critical";
  const hops = page.redirectHops ?? 0;
  return (
    <ReportRow
      cells={[
        <BlockStack gap="050">
          <Text as="span" variant="bodySm">{page.url}</Text>
          {page.title && <Text as="span" variant="bodySm" tone="subdued">{page.title}</Text>}
        </BlockStack>,
        page.responseMs > 0 ? (
          <Text as="span" variant="bodySm" tone="subdued">{`${page.responseMs} ms`}</Text>
        ) : null,
        <BlockStack gap="050" inlineAlign="end">
          <Badge tone={tone}>{page.statusCode === -1 ? redirectLoopLabel : String(page.statusCode)}</Badge>
          {/* A chain the merchant's own redirect list may not even contain
              (theme/app/locale redirects) — worth a badge, not a whole tab. */}
          {hops > 0 && hopsLabel && (
            <Badge tone="attention">{hopsLabel.replace("{count}", String(hops))}</Badge>
          )}
        </BlockStack>,
        page.resourceType && page.resourceId ? (
          <EditAction
            label={openLabel}
            onClick={() => onOpen(page.resourceType as AuditType, page.resourceId as string)}
          />
        ) : null,
      ]}
    />
  );
}
