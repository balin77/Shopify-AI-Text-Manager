/**
 * One-shot UI over `/api/unit-price-probe`.
 *
 * The question it settles: can this app WRITE a Grundpreis (Stückpreis), or is
 * `unitPriceMeasurement` read-only? Everything about a unit-price feature
 * depends on the answer, and the docs do not give it — so it is measured on a
 * real variant before anything is built.
 *
 * Two things about the flow are deliberate. The merchant PICKS the product and
 * the variant — from the cache, in two dropdowns — because a probe that chose
 * its own target would write to a product nobody selected, and one that asked
 * for a pasted GID would not get run at all. And the run RESTORES whatever
 * measurement the variant had, so the storefront is not left showing
 * "CHF x / kg" for a vase.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Select,
  Spinner,
  Text,
} from "@shopify/polaris";

interface Finding {
  ok: boolean;
  missing?: boolean;
  error?: string;
  detail?: unknown;
}

type Report = Record<string, Finding>;

interface ProbeVariant {
  gid: string;
  title: string;
  sku: string | null;
}
interface ProbeProduct {
  gid: string;
  title: string;
  variants: ProbeVariant[];
}

/** What each step answers, in the order the probe asks it.
 *
 *  `missingLabel` overrides the default "not supported" where that would
 *  overstate the finding: the clear step measures a LIST of candidate inputs,
 *  so all of them failing says none of these works, not that the platform has
 *  no way at all. */
const STEPS: Array<{ key: string; label: string; question: string; missingLabel?: string }> = [
  {
    key: "inputShape",
    label: "Input shape",
    question: "Does ProductVariantsBulkInput carry a unit-price field at all?",
  },
  { key: "read", label: "Read", question: "What does the variant hold right now?" },
  { key: "write", label: "Write", question: "Does a 500 g / 1 kg measurement stick?" },
  {
    key: "clear",
    label: "Clear",
    question: "Can it be removed again? Five candidate inputs are tried, in order.",
    missingLabel: "no way found",
  },
  {
    key: "hide",
    label: "Hide",
    question:
      "Is showUnitPrice a real switch? It is flipped away from where it was and flipped back.",
    missingLabel: "does not move",
  },
  { key: "restored", label: "Restored", question: "Was the variant put back the way it was?" },
];

/**
 * Three states, never two.
 *
 * `missing` means the API answered and the field is not there — a real
 * negative. `error` means no answer arrived, which says nothing at all. One
 * read as the other would close a question that is still open.
 */
function verdict(finding: Finding | undefined, missingLabel?: string) {
  if (!finding) return { tone: undefined as never, text: "not run" };
  if (finding.ok) return { tone: "success" as const, text: "yes" };
  if (finding.missing) return { tone: "critical" as const, text: missingLabel ?? "not supported" };
  return { tone: "warning" as const, text: "no answer" };
}

export function SettingsUnitPriceProbeTab() {
  const [productGid, setProductGid] = useState("");
  const [variantGid, setVariantGid] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  /** `null` while loading — an empty list and "not loaded yet" are different
   *  answers, and a picker showing "no products" for the first is a lie. */
  const [products, setProducts] = useState<ProbeProduct[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/unit-price-probe")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setProducts(data?.success ? (data.products as ProbeProduct[]) : []);
      })
      .catch(() => {
        if (!cancelled) setProducts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const product = products?.find((p) => p.gid === productGid);
  /** The variant, falling back to the product's first: a selection pointing at
   *  a variant of a product that is no longer chosen would leave the run
   *  button dead with nothing saying why. */
  const variant = product?.variants.find((v) => v.gid === variantGid) ?? product?.variants[0];

  const run = useCallback(async (mode: "probe" | "clear" = "probe") => {
    setRunning(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("productGid", productGid);
      body.set("variantGid", variantGid || variant?.gid || "");
      body.set("mode", mode);
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
  }, [productGid, variantGid, variant]);

  /** The report as markdown, to paste into the plan. */
  const markdown = useMemo(() => {
    if (!report) return "";
    const lines = ["# Unit-price probe", ""];
    for (const step of STEPS) {
      const finding = report[step.key];
      if (!finding) continue;
      lines.push(`## ${step.label} — ${verdict(finding, step.missingLabel).text}`);
      lines.push(step.question);
      if (finding.error) lines.push(`error: ${finding.error}`);
      if (finding.detail !== undefined) {
        lines.push("```json", JSON.stringify(finding.detail, null, 2), "```");
      }
      lines.push("");
    }
    return lines.join("\n");
  }, [report]);

  const canRun = !!product && !!variant;

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
              This WRITES to the variant you pick — 500&nbsp;g per 1&nbsp;kg — and then tries to put
              back whatever was there. <b>It may not manage to</b>: the measured behaviour is that
              Shopify accepts a removal and keeps the value, so the report says plainly when the
              variant was left carrying the probe's measurement. <b>Remove the measurement</b> runs
              only the removal ladder, which is how that is cleaned up. Use a product you do not
              mind touching.
            </p>
          </Banner>

          {products === null ? (
            <Spinner size="small" accessibilityLabel="Loading products" />
          ) : products.length === 0 ? (
            <Banner tone="warning">
              <p>
                No synced products with variants. Run a product sync first — this list comes from
                the cache, not from Shopify.
              </p>
            </Banner>
          ) : (
            <InlineStack gap="300" blockAlign="start" wrap>
              <Box minWidth="260px">
                <Select
                  label="Product"
                  options={[
                    { label: "Choose a product…", value: "" },
                    ...products.map((p) => ({ label: p.title || p.gid, value: p.gid })),
                  ]}
                  value={productGid}
                  onChange={(value) => {
                    setProductGid(value);
                    // The old variant belongs to the old product.
                    setVariantGid("");
                  }}
                />
              </Box>
              <Box minWidth="260px">
                <Select
                  label="Variant"
                  disabled={!product}
                  options={(product?.variants ?? []).map((v) => ({
                    label: v.sku ? `${v.title} · ${v.sku}` : v.title,
                    value: v.gid,
                  }))}
                  value={variant?.gid ?? ""}
                  onChange={setVariantGid}
                />
              </Box>
            </InlineStack>
          )}

          <InlineStack gap="200">
            <Button
              variant="primary"
              onClick={() => void run("probe")}
              loading={running}
              disabled={!canRun}
            >
              Run probe
            </Button>
            {/* The probe can only put the variant back if something is able to
                take the measurement off, and the first live run established
                that the obvious way does not. Re-running the whole probe is
                NOT the cleanup: it would read the leftover as the state to
                restore and put it back at the end. */}
            <Button onClick={() => void run("clear")} loading={running} disabled={!canRun}>
              Remove the measurement
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
              const answer = verdict(finding, step.missingLabel);
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
