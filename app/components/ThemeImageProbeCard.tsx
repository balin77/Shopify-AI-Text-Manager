/**
 * Settings → Probes → Translation: the theme-image probe
 * (routes/api.theme-image-probe.tsx, PLAN_LOCALIZED_IMAGES Phase 0).
 * Two buttons, because the second one writes: "read only" answers whether
 * Shopify reports image settings as translatable; "with write check" also
 * registers and removes the sample's own value in an empty slot.
 */
import { useCallback, useState } from "react";
import { Banner, BlockStack, Button, Card, InlineStack, Text } from "@shopify/polaris";
import type { ThemeImageProbeReport } from "../routes/api.theme-image-probe";

export function ThemeImageProbeCard() {
  const [loading, setLoading] = useState<"read" | "write" | null>(null);
  const [report, setReport] = useState<ThemeImageProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (withWrite: boolean) => {
    setLoading(withWrite ? "write" : "read");
    setError(null);
    try {
      const fd = new FormData();
      if (withWrite) fd.set("confirm", "true");
      const r = await fetch("/api/theme-image-probe", { method: "POST", body: fd });
      const j = (await r.json()) as { report?: ThemeImageProbeReport; error?: string };
      if (!r.ok || !j.report) throw new Error(j.error || `HTTP ${r.status}`);
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }, []);

  const answered = report?.verdict.some((v) => v.startsWith("ANSWER 1: YES")) ?? false;

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">Theme images per language</Text>
        <Text as="p" tone="subdued">
          Answers whether Shopify reports theme image settings (shopify://shop_images/…) as
          translatable keys — the basis of choosing a different theme image per language and
          market. The write check registers the sample&apos;s OWN image as a translation in a
          language (then a language × market) that holds nothing for that key, reads it back
          and removes it again: nothing visible changes and nothing of yours is overwritten.
        </Text>
        <InlineStack gap="200" blockAlign="center">
          <Button onClick={() => run(false)} loading={loading === "read"} disabled={loading !== null}>
            Run (read only)
          </Button>
          <Button onClick={() => run(true)} loading={loading === "write"} disabled={loading !== null}>
            Run with write check
          </Button>
        </InlineStack>
        {error && (
          <Banner tone="critical"><Text as="p">Probe failed: {error}</Text></Banner>
        )}
        {report && (
          <BlockStack gap="200">
            <Banner tone={answered ? "success" : "info"}>
              <BlockStack gap="100">
                {report.verdict.map((v, i) => <Text as="p" key={i}>{v}</Text>)}
              </BlockStack>
            </Banner>
            <Text as="p" variant="bodySm" tone="subdued">
              Scanned {report.scannedRows} cached theme rows. Image keys per type:{" "}
              {Object.entries(report.imageKeysByResourceType).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}
            </Text>
            {report.samples.map((s, i) => (
              <Text as="p" variant="bodySm" key={i}>
                <code>{s.key}</code> = <code>{s.value}</code> ({s.resourceType})
              </Text>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
