/**
 * One-shot UI over `/api/publication-probe`.
 *
 * Answers, per shop and in one click, the question that cost this app a wrong
 * feature: does `resourcePublicationsV2` hand over market and B2B catalogs at
 * all, and what does the sales-channel list actually contain — is Shopify's
 * "Agentic" channel in it, and under which name?
 *
 * The three blocks are shown SEPARATELY, each with its own outcome, because a
 * refused connection and a shop with no regions are indistinguishable once
 * they have been merged into one list of zero.
 */

import { useCallback, useState } from "react";
import { Badge, BlockStack, Banner, Button, Card, InlineStack, Text, TextField } from "@shopify/polaris";
import type { ProbeCatalogBlock, PublicationProbeResult } from "../routes/api.publication-probe";

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
                or enum value Shopify did not accept, which is the whole
                diagnosis. */}
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
            <Text as="span" variant="bodyMd">{row.name || "(unnamed)"}</Text>
            <Badge>{row.catalogTypename}</Badge>
            {row.isPublished ? <Badge tone="success">published</Badge> : <Badge>not published</Badge>}
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

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Publications by catalog type</Text>
          <Text as="p" variant="bodyMd">
            `resourcePublicationsV2` defaults to <code>catalogType: APP</code> and says nothing about
            it — so a query without the argument returns sales channels only, and a shop with regions
            looks exactly like a shop without any. This asks all three connections separately and
            reports each outcome on its own.
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
          </InlineStack>
        </BlockStack>
      </Card>

      {error && <Banner tone="critical"><p>{error}</p></Banner>}

      {report && (
        <BlockStack gap="300">
          <Text as="p" variant="bodySm" tone="subdued">
            {`Product: ${report.productTitle || report.productId}`}
          </Text>
          <CatalogBlock
            title="Default (no catalogType)"
            note="What this app read for months. If the two blocks below hold rows this one does not, the default is APP-only — confirmed on this shop."
            block={report.defaultCatalogType}
          />
          <CatalogBlock
            title="catalogType: MARKET"
            note="Region catalogs. These decide who may SEE the product, and a translation made for a market the product is not in can never be read."
            block={report.market}
          />
          <CatalogBlock
            title="catalogType: COMPANY_LOCATION"
            note="B2B catalogs, one per company location. Empty on a shop without B2B — which is not the same as refused."
            block={report.companyLocation}
          />
        </BlockStack>
      )}
    </BlockStack>
  );
}
