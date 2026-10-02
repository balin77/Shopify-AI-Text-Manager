/**
 * Settings → Probes → Translation: the image-stamp probe
 * (services/localized-media/image-stamp-probe.server.ts, run through
 * routes/api.translation-probe.tsx with `kind=imageStamp`). One button: it
 * edits ONE product image's alt text (original + marker), reads the image url
 * again, and restores the alt exactly.
 */
import { useCallback, useState } from "react";
import { Banner, BlockStack, Button, Card, Text } from "@shopify/polaris";
import type { ImageStampProbeReport } from "../services/localized-media/image-stamp-probe.shared";

export function ImageStampProbeCard() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ImageStampProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("kind", "imageStamp");
      fd.set("confirm", "true");
      const r = await fetch("/api/translation-probe", { method: "POST", body: fd });
      const j = (await r.json()) as { report?: ImageStampProbeReport; error?: string };
      if (!r.ok || !j.report) throw new Error(j.error || `HTTP ${r.status}`);
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">Image url stamp (alt edit)</Text>
        <Text as="p" tone="subdued">
          Answers whether Shopify changes a product image&apos;s url query (?v=) when only its alt
          text changes — the basis of the &quot;original changed&quot; flag on replacement images.
          It sets the alt of ONE image to its current alt plus &quot; [probe]&quot;, re-reads the url
          and restores the alt exactly. Images that belong to a replacement are never touched.
        </Text>
        <div>
          <Button onClick={run} loading={loading} disabled={loading}>
            Run (edits one alt and restores it)
          </Button>
        </div>
        {error && <Banner tone="critical"><Text as="p">Probe failed: {error}</Text></Banner>}
        {report && (
          <BlockStack gap="200">
            <Banner tone={report.restoreFailed ? "critical" : report.verdict[0]?.startsWith("ANSWER") ? "success" : "info"}>
              <BlockStack gap="100">
                {report.verdict.map((v, i) => <Text as="p" key={i}>{v}</Text>)}
              </BlockStack>
            </Banner>
            <Text as="p" variant="bodySm">Image: <code>{report.mediaId ?? "-"}</code> (product <code>{report.productId ?? "-"}</code>)</Text>
            <Text as="p" variant="bodySm">Original alt: <code>{JSON.stringify(report.originalAlt)}</code></Text>
            <Text as="p" variant="bodySm">urlBefore: <code>{report.urlBefore ?? "-"}</code></Text>
            <Text as="p" variant="bodySm">urlAfterAltChange: <code>{report.urlAfterAltChange ?? "-"}</code> (after {report.attemptsAfterChange} read(s))</Text>
            <Text as="p" variant="bodySm">urlAfterRestore: <code>{report.urlAfterRestore ?? "-"}</code></Text>
            <Text as="p" variant="bodySm">
              Path changed: {String(report.pathChanged)} · Query changed: {String(report.queryChanged)} ·
              Query changed after restore: {String(report.restoreQueryChanged)} ·
              Alt change confirmed: {String(report.altChangeConfirmed)} · Restore confirmed: {String(report.restoreConfirmed)}
            </Text>
            {report.error && <Text as="p" variant="bodySm" tone="critical">{report.error}</Text>}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
