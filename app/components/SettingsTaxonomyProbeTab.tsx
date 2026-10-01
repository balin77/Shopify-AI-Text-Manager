/**
 * One-shot UI over `/api/taxonomy-probe`.
 *
 * Three questions, and each of them decides a piece of the category picker
 * rather than being nice to know:
 *
 *   - Is a bare `categories()` the ROOT list? If not, the picker has no first
 *     screen and has to start from a search after all.
 *   - Does `childrenOf` return ONE level? That is what a click-through is.
 *   - Do category names come back in the shop's other languages? That decides
 *     whether an auto-filled product type is translated from Shopify's own
 *     taxonomy or through this app's AI path.
 *
 * Read-only, so there is nothing to restore and no target to pick: the probe
 * reads Shopify's taxonomy, which is Shopify's data rather than the shop's.
 * The one thing it reads OF the shop is the locale list, to have something to
 * ask the third question in.
 */

import { useCallback, useMemo, useState } from "react";
import { Badge, Banner, BlockStack, Button, Card, InlineStack, Spinner, Text } from "@shopify/polaris";

interface Finding {
  ok: boolean;
  missing?: boolean;
  error?: string;
  detail?: unknown;
}

type Report = Record<string, Finding>;

/** What each key answers, in the order the picker needs them. Keys the report
 *  carries but this map does not still render — an unlabelled finding is
 *  better than a dropped one. */
const LABELS: Record<string, string> = {
  categoriesArguments: "Which arguments taxonomy.categories takes",
  categoryFields: "Which fields a TaxonomyCategory carries",
  inContextDirective: "Does @inContext accept a language",
  rootList: "T1 — is a bare categories() the top level",
  childrenOf: "T2 — does childrenOf return ONE level",
  childrenOfDepth2: "T2b — does it still work one level deeper",
  searchHitShape: "Can a search hit be placed in the tree",
  localizedNames: "T3 — are category names translated",
};

/**
 * The whole run as one pasteable block.
 *
 * A probe answer is worth nothing in a browser tab — it gets pasted into a
 * plan, an issue, a chat. Rendering it in cards only, as the first cut did,
 * made a reader select nine boxes by hand and lose the labels on the way. Same
 * shape the other probes emit, so a taxonomy report reads like a publication
 * or a metaobject one.
 */
function formatMarkdown(report: Report, order: string[], shop?: string): string {
  const lines: string[] = ["# Taxonomy probe", ""];
  if (shop) lines.push(`Shop: ${shop}`, "");
  for (const key of order) {
    const finding = report[key];
    if (!finding) continue;
    lines.push(`## ${LABELS[key] || key}`, "", `**${labelOf(finding)}**`, "");
    if (finding.error) lines.push(finding.error, "");
    if (finding.detail !== undefined) {
      const body =
        typeof finding.detail === "string" ? finding.detail : JSON.stringify(finding.detail, null, 2);
      lines.push("```", body, "```", "");
    }
  }
  return lines.join("\n");
}

function toneOf(finding: Finding): "success" | "critical" | "attention" {
  if (finding.ok) return "success";
  // The distinction the whole probe is built on: an unanswered question is
  // not a negative answer, and must not be rendered as one.
  return finding.error ? "attention" : "critical";
}

function labelOf(finding: Finding): string {
  if (finding.ok) return "yes";
  if (finding.error) return "not answered";
  return finding.missing ? "no" : "no";
}

export function SettingsTaxonomyProbeTab() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [shop, setShop] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/taxonomy-probe");
      const body = await response.json();
      if (!body?.success) {
        setError(body?.error || "The probe did not run.");
        // A partial report is still worth showing: the steps that DID answer
        // are measurements, and dropping them would waste the run.
        setReport((body?.report as Report) ?? null);
        return;
      }
      setReport(body.report as Report);
      setShop(typeof body.shop === "string" ? body.shop : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  const keys = report ? Object.keys(report) : [];
  const ordered = useMemo(
    () => [
      ...Object.keys(LABELS).filter((k) => keys.includes(k)),
      ...keys.filter((k) => !(k in LABELS)),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report],
  );

  const markdown = useMemo(
    () => (report ? formatMarkdown(report, ordered, shop) : ""),
    [report, ordered, shop],
  );

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
          <Text as="h2" variant="headingMd">Product taxonomy</Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Measures what Shopify's taxonomy API hands over before the category
            picker is built on it: whether a bare call is the top level, whether
            childrenOf walks one level at a time, and whether category names
            come back in the shop's other languages. Read-only — nothing is
            written and nothing is changed.
          </Text>
          <InlineStack gap="200" blockAlign="center">
            <Button variant="primary" onClick={run} disabled={running}>
              {running ? "Measuring…" : "Run probe"}
            </Button>
            {markdown && <Button onClick={() => void copyToClipboard()}>Copy markdown report</Button>}
            {running && <Spinner size="small" accessibilityLabel="Measuring" />}
          </InlineStack>
        </BlockStack>
      </Card>

      {error && (
        <Banner tone="warning">
          <p>{error}</p>
        </Banner>
      )}

      {report && (
        <BlockStack gap="300">
          {ordered.map((key) => {
            const finding = report[key];
            return (
              <Card key={key}>
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="h3" variant="headingSm">{LABELS[key] || key}</Text>
                    <Badge tone={toneOf(finding)}>{labelOf(finding)}</Badge>
                  </InlineStack>
                  {finding.error && (
                    <Text as="p" variant="bodySm" tone="subdued">{finding.error}</Text>
                  )}
                  {finding.detail !== undefined && (
                    <pre
                      style={{
                        margin: 0,
                        padding: "0.5rem",
                        background: "#f6f6f7",
                        borderRadius: "4px",
                        fontSize: "12px",
                        // The samples are long paths and locale tables; a page
                        // that scrolls sideways because of a diagnostic is a
                        // bad trade.
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: "20rem",
                        overflow: "auto",
                      }}
                    >
                      {typeof finding.detail === "string"
                        ? finding.detail
                        : JSON.stringify(finding.detail, null, 2)}
                    </pre>
                  )}
                </BlockStack>
              </Card>
            );
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
                  border: "1px solid var(--app-field-border-color)",
                  borderRadius: "8px",
                }}
              />
            </BlockStack>
          </Card>
        </BlockStack>
      )}
    </BlockStack>
  );
}
