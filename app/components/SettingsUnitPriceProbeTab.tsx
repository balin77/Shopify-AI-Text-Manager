/**
 * One-shot UI over `/api/unit-price-probe`.
 *
 * The question it settles: can this app WRITE a Grundpreis (Stückpreis), or is
 * `unitPriceMeasurement` read-only? Everything about a unit-price feature
 * depends on the answer, and the docs do not give it — so it is measured on a
 * real variant before anything is built.
 *
 * Two things about the flow are deliberate. The merchant supplies the product
 * and variant GIDs themselves: a probe that picks its own target writes to a
 * product nobody chose. And the run RESTORES whatever measurement the variant
 * had, so the storefront is not left showing "CHF x / kg" for a vase.
 */

import { useCallback, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";

interface Finding {
  ok: boolean;
  missing?: boolean;
  error?: string;
  detail?: unknown;
}

type Report = Record<string, Finding>;

/** What each step answers, in the order the probe asks it. */
const STEPS: Array<{ key: string; label: string; question: string }> = [
  {
    key: "inputShape",
    label: "Input shape",
    question: "Does ProductVariantsBulkInput carry a unit-price field at all?",
  },
  { key: "read", label: "Read", question: "What does the variant hold right now?" },
  { key: "write", label: "Write", question: "Does a 500 g / 1 kg measurement stick?" },
  { key: "clear", label: "Clear", question: "Can it be removed again?" },
  { key: "restored", label: "Restored", question: "Was the variant put back the way it was?" },
];

/**
 * Three states, never two.
 *
 * `missing` means the API answered and the field is not there — a real
 * negative. `error` means no answer arrived, which says nothing at all. One
 * read as the other would close a question that is still open.
 */
function verdict(finding: Finding | undefined) {
  if (!finding) return { tone: undefined as never, text: "not run" };
  if (finding.ok) return { tone: "success" as const, text: "yes" };
  if (finding.missing) return { tone: "critical" as const, text: "not supported" };
  return { tone: "warning" as const, text: "no answer" };
}

export function SettingsUnitPriceProbeTab() {
  const [productGid, setProductGid] = useState("");
  const [variantGid, setVariantGid] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("productGid", productGid.trim());
      body.set("variantGid", variantGid.trim());
      const res = await fetch("/api/unit-price-probe", { method: "POST", body });
      const data = await res.json();
      if (!data.success) {
        setError(typeof data.error === "string" ? data.error : "The probe returned no report.");
        setReport(null);
        return;
      }
      setReport(data.results as Report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [productGid, variantGid]);

  /** The report as markdown, to paste into the plan. */
  const markdown = useMemo(() => {
    if (!report) return "";
    const lines = ["# Unit-price probe", ""];
    for (const step of STEPS) {
      const finding = report[step.key];
      if (!finding) continue;
      lines.push(`## ${step.label} — ${verdict(finding).text}`);
      lines.push(step.question);
      if (finding.error) lines.push(`error: ${finding.error}`);
      if (finding.detail !== undefined) {
        lines.push("```json", JSON.stringify(finding.detail, null, 2), "```");
      }
      lines.push("");
    }
    return lines.join("\n");
  }, [report]);

  const canRun =
    productGid.trim().startsWith("gid://shopify/Product/") &&
    variantGid.trim().startsWith("gid://shopify/ProductVariant/");

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Unit price (Grundpreis)</Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Shopify shows a "Stückpreis" box on its variant page: a pack's total quantity and a
            reference unit, from which the storefront prints "CHF 45.80 / kg". It is a legal display
            rule for anything sold by weight or volume. <b>`unitPriceMeasurement` is readable; whether
            it can be written is the open question</b>, and this settles it before a feature is built
            on the assumption.
          </Text>
          <Banner tone="warning">
            <p>
              This WRITES to the variant you name — 500&nbsp;g per 1&nbsp;kg — and then puts back
              whatever was there. Use a product you do not mind touching.
            </p>
          </Banner>

          <TextField
            label="Product GID"
            value={productGid}
            onChange={setProductGid}
            autoComplete="off"
            placeholder="gid://shopify/Product/123"
            helpText="The variant's product. The mutation is addressed per product."
          />
          <TextField
            label="Variant GID"
            value={variantGid}
            onChange={setVariantGid}
            autoComplete="off"
            placeholder="gid://shopify/ProductVariant/456"
          />

          <InlineStack gap="200">
            <Button variant="primary" onClick={run} loading={running} disabled={!canRun}>
              Run probe
            </Button>
            {markdown && (
              <Button onClick={() => void navigator.clipboard?.writeText(markdown)}>
                Copy report
              </Button>
            )}
          </InlineStack>

          {error && (
            <Banner tone="critical">
              <p>{error}</p>
            </Banner>
          )}
        </BlockStack>
      </Card>

      {report && (
        <Card>
          <BlockStack gap="300">
            {STEPS.map((step) => {
              const finding = report[step.key];
              if (!finding) return null;
              const answer = verdict(finding);
              return (
                <Box
                  key={step.key}
                  borderColor="border"
                  borderWidth="025"
                  borderRadius="200"
                  padding="300"
                >
                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingSm">{step.label}</Text>
                      <Badge tone={answer.tone}>{answer.text}</Badge>
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">{step.question}</Text>
                    {finding.error && (
                      <Text as="p" variant="bodySm" tone="critical">{finding.error}</Text>
                    )}
                    {finding.detail !== undefined && (
                      <Box background="bg-surface-secondary" padding="200" borderRadius="100">
                        <pre style={{ margin: 0, fontSize: "12px", overflowX: "auto" }}>
                          {JSON.stringify(finding.detail, null, 2)}
                        </pre>
                      </Box>
                    )}
                  </BlockStack>
                </Box>
              );
            })}
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
