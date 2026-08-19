/**
 * One-shot UI over `/api/publication-probe`.
 *
 * Answers, per shop and in one click, the question that cost this app a wrong
 * feature: does `resourcePublicationsV2` hand over market and B2B catalogs at
 * all, what does the sales-channel list actually contain — and is Shopify's
 * "Agentic" channel among the shop's publications in the first place?
 *
 * Every block is shown SEPARATELY with its own outcome, because a refused
 * connection and a shop with no regions are indistinguishable once they have
 * been merged into one list of zero.
 *
 * The report is COPYABLE, like the other probes: a markdown block, a copy
 * button, and a read-only textarea underneath. A measurement that cannot leave
 * the browser tab is not a measurement — and the clipboard API is blocked
 * inside the embedded admin iframe often enough for the textarea to matter.
 */

import { useCallback, useMemo, useState } from "react";
import { Badge, BlockStack, Banner, Button, Card, InlineStack, Text, TextField } from "@shopify/polaris";
import type { ProbeCatalogBlock, PublicationProbeResult } from "../routes/api.publication-probe";

/** The label chain the real channel list uses, so both show the same name. */
function displayName(row: ProbeCatalogBlock["rows"][number]): string {
  return row.name || row.catalogTitle || "(unnamed)";
}

const BLOCKS: Array<{
  id: string;
  title: string;
  note: string;
  /** A GETTER, not a key cast: a response missing a block is skipped, and an
   *  older server build must not blank the whole tab with a thrown read. */
  pick: (report: PublicationProbeResult) => ProbeCatalogBlock | undefined;
}> = [
  {
    id: "defaultCatalogType",
    pick: (r) => r.defaultCatalogType,
    title: "Product · default (no catalogType)",
    note:
      "What this app read for months. If the two blocks below hold rows this one does not, the default is APP-only — confirmed on this shop.",
  },
  {
    id: "market",
    pick: (r) => r.market,
    title: "Product · catalogType: MARKET",
    note:
      "Region catalogs. These decide who may SEE the product, and a translation made for a market the product is not in can never be read.",
  },
  {
    id: "companyLocation",
    pick: (r) => r.companyLocation,
    title: "Product · catalogType: COMPANY_LOCATION",
    note: "B2B catalogs, one per company location. Empty on a shop without B2B — which is not the same as refused.",
  },
  {
    id: "shopPublications",
    pick: (r) => r.shopPublications,
    title: "Shop · every publication",
    note:
      "Product-independent: what this shop HAS, asked across all three catalog types. A channel present here but missing from the product blocks is one the product cannot be published to; missing from both, this app never sees it at all — which is the question for Shopify's Agentic channel.",
  },
];

function formatBlock(title: string, block: ProbeCatalogBlock): string {
  const lines: string[] = [`### ${title}`];
  if (!block.ok) {
    lines.push(`REFUSED: ${block.error || "no answer"}`, "");
    return lines.join("\n");
  }
  lines.push(`ok, ${block.rows.length} publications${block.truncated ? " (TRUNCATED)" : ""}`);
  if (block.rows.length === 0) {
    lines.push("(the call succeeded and returned nothing — this shop genuinely has none)");
  }
  for (const row of block.rows) {
    // `null` means the block has no per-product state to report. Printing
    // "not published" there claimed a live channel was off.
    const state = row.isPublished === null ? "" : ` | ${row.isPublished ? "published" : "not published"}`;
    const scheduled = row.publishDate ? ` scheduled=${row.publishDate}` : "";
    lines.push(
      `- ${displayName(row)} | ${row.catalogTypename}${state}${scheduled} | name=${JSON.stringify(row.name)} title=${JSON.stringify(row.catalogTitle)} | ${row.publicationId}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatMarkdown(report: PublicationProbeResult): string {
  return [
    "## Publication probe",
    "",
    `Product: ${report.productTitle || "(untitled)"} (${report.productId})`,
    "",
    ...BLOCKS.flatMap((b) => {
      const block = b.pick(report);
      return block ? [formatBlock(b.title, block)] : [];
    }),
  ].join("\n");
}

function CatalogBlock({ title, note, block }: { title: string; note: string; block: ProbeCatalogBlock }) {
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center" wrap>
          <Text as="h3" variant="headingSm">{title}</Text>
          {block.ok ? (
            <Badge tone={block.rows.length > 0 ? "success" : undefined}>
              {`${block.rows.length} publications`}
            </Badge>
          ) : (
            <Badge tone="critical">Refused</Badge>
          )}
          {block.truncated && <Badge tone="warning">Truncated</Badge>}
        </InlineStack>

        <Text as="p" variant="bodySm" tone="subdued">{note}</Text>

        {!block.ok && (
          <Banner tone="critical">
            {/* The message verbatim: a schema-level refusal names the argument
                or enum value Shopify did not accept, which is the diagnosis. */}
            <p>{block.error || "The connection returned no answer."}</p>
          </Banner>
        )}

        {block.ok && block.rows.length === 0 && (
          <Text as="p" variant="bodySm">
            The call succeeded and returned nothing — this shop genuinely has none of these.
          </Text>
        )}

        {block.rows.map((row) => (
          <InlineStack key={row.publicationId} gap="200" blockAlign="center" wrap>
            <Text as="span" variant="bodyMd">{displayName(row)}</Text>
            <Badge>{row.catalogTypename}</Badge>
            {/* Which of the two fields carried the name is the finding, not a
                detail: `Publication.name` is empty on a market catalog. */}
            {!row.name && row.catalogTitle && <Badge tone="warning">name empty → catalog.title</Badge>}
            {row.isPublished === true && <Badge tone="success">published</Badge>}
            {/* Rendered explicitly: without it an unpublished product row and
                a shop row with no applicable state look identical. */}
            {row.isPublished === false && <Badge>not published</Badge>}
            {row.publishDate && <Badge tone="warning">{`scheduled ${row.publishDate}`}</Badge>}
            <Text as="span" variant="bodySm" tone="subdued">{row.publicationId}</Text>
          </InlineStack>
        ))}
      </BlockStack>
    </Card>
  );
}

export function SettingsPublicationProbeTab() {
  const [productGid, setProductGid] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<PublicationProbeResult | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const query = productGid ? `?productId=${encodeURIComponent(productGid)}` : "";
      const res = await fetch(`/api/publication-probe${query}`);
      const data = await res.json();
      if (!data?.success) {
        setError(typeof data?.error === "string" ? data.error : "The probe returned no report.");
        setReport(null);
        return;
      }
      setReport(data as PublicationProbeResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [productGid]);

  const markdown = useMemo(() => (report ? formatMarkdown(report) : ""), [report]);

  const copyToClipboard = useCallback(async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      // The textarea below is the fallback — click into it, ctrl+a, ctrl+c.
    }
  }, [markdown]);

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Publications by catalog type (dev only)</Text>
          <Text as="p" variant="bodyMd">
            resourcePublicationsV2 defaults to catalogType: APP and says nothing about it — so a query
            without the argument returns sales channels only, and a shop with regions looks exactly like a
            shop without any. This asks each connection separately and reports every outcome on its own.
          </Text>
          <TextField
            label="Product GID (optional)"
            value={productGid}
            onChange={setProductGid}
            autoComplete="off"
            placeholder="gid://shopify/Product/… — empty uses the first cached product"
          />
          <InlineStack gap="200">
            <Button onClick={() => void run()} loading={running} variant="primary">Run probe</Button>
            {markdown && <Button onClick={() => void copyToClipboard()}>Copy markdown report</Button>}
          </InlineStack>
        </BlockStack>
      </Card>

      {error && <Banner tone="critical"><p>{error}</p></Banner>}

      {report && (
        <BlockStack gap="300">
          <Text as="p" variant="bodySm" tone="subdued">
            {`Product: ${report.productTitle || report.productId}`}
          </Text>

          {BLOCKS.flatMap((entry) => {
            const block = entry.pick(report);
            if (!block) return [];
            return [<CatalogBlock key={entry.id} title={entry.title} note={entry.note} block={block} />];
          })}

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Report</Text>
              {/* A read-only TEXTAREA, not a <pre>: one click into it selects
                  the whole report, so Ctrl+C works even where the clipboard
                  API is blocked — which it is inside an embedded admin iframe
                  often enough to matter. Same affordance the other probes use. */}
              <textarea
                readOnly
                value={markdown}
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  width: "100%",
                  minHeight: "320px",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: "12px",
                  padding: "12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "8px",
                  background: "#fafbfb",
                  resize: "vertical",
                }}
              />
              <Text as="p" variant="bodySm" tone="subdued">
                Click into the box to select everything, or use the copy button above.
              </Text>
            </BlockStack>
          </Card>
        </BlockStack>
      )}
    </BlockStack>
  );
}
