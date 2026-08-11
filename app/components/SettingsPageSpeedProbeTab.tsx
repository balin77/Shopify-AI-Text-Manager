/**
 * PageSpeed Raw-Response Probe — Settings tab (dev-only).
 *
 * PROBE (accessibility plan §3.3): one button that fetches the COMPLETE,
 * unparsed PageSpeed Insights response for one storefront path + device and
 * downloads it as a file, plus shows the top-level category keys inline. It
 * exists to answer one open question: does Google ship an `agentic-browsing`
 * category we never requested? See docs/architecture/SEO_SPEED_AND_QUALITY.md.
 *
 * Posts to the `debugRawPsi` intent of /app/seo/performance via useFetcher
 * (NOT a raw fetch): /app/seo/performance is a UI route, so a plain fetch is a
 * Remix *document* request and comes back as the HTML shell ("<!DOCTYPE …" —
 * not JSON). A Remix fetcher submits a *data* request and gets the action JSON.
 * That route owns the domain resolution, allow-list check and raw PSI fetch;
 * the call bypasses cache and the daily budget but spends one real Google PSI
 * request per click. Temporary — remove together with the §3.3 finding.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useFetcher } from "react-router";
import { Card, Text, BlockStack, Button, InlineStack, ButtonGroup, TextField, Banner } from "@shopify/polaris";

type DebugRawPsiResult =
  | { ok: true; categories: string[]; raw: unknown }
  | { ok: false; error: string };

export function SettingsPageSpeedProbeTab() {
  const [path, setPath] = useState("/");
  const [strategy, setStrategy] = useState<"mobile" | "desktop">("mobile");
  const fetcher = useFetcher<DebugRawPsiResult>();
  const loading = fetcher.state !== "idle";
  const downloadedRef = useRef<unknown>(null);

  const run = useCallback(() => {
    fetcher.submit(
      { intent: "debugRawPsi", url: path.trim() || "/", strategy },
      { method: "post", action: "/app/seo/performance" },
    );
  }, [fetcher, path, strategy]);

  // Download the complete raw response as a file, once per new successful
  // response (the category banner below shows the answer at a glance anyway).
  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const d = fetcher.data;
    if (!d || !d.ok || d.raw === downloadedRef.current) return;
    downloadedRef.current = d.raw;
    try {
      const blob = new Blob([JSON.stringify(d.raw, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `psi-raw-${strategy}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch {
      // Download blocked (sandboxed frame) — the category banner still shows.
    }
  }, [fetcher.state, fetcher.data, strategy]);

  const data = fetcher.data;

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">PageSpeed Raw-Response (Debug §3.3)</Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Ruft die komplette, ungeparste PageSpeed-Insights-Antwort für eine Seite deines Shops ab,
            lädt sie als JSON-Datei herunter und zeigt die enthaltenen Kategorie-Keys an. Damit lässt
            sich prüfen, ob Google eine nicht angeforderte Kategorie (z. B. „agentic-browsing")
            mitliefert. Verbraucht pro Klick eine echte Google-PSI-Anfrage, zählt aber nicht gegen
            das Tageslimit.
          </Text>
        </BlockStack>

        <InlineStack gap="300" blockAlign="end" wrap>
          <div style={{ minWidth: "260px", flex: 1 }}>
            <TextField
              label="Pfad oder URL"
              value={path}
              onChange={setPath}
              autoComplete="off"
              placeholder="/ oder /products/mein-produkt"
            />
          </div>
          <ButtonGroup variant="segmented">
            <Button pressed={strategy === "mobile"} onClick={() => setStrategy("mobile")}>Mobil</Button>
            <Button pressed={strategy === "desktop"} onClick={() => setStrategy("desktop")}>Desktop</Button>
          </ButtonGroup>
          <Button variant="primary" loading={loading} disabled={loading} onClick={run}>
            Rohe API-Antwort laden
          </Button>
        </InlineStack>

        {data?.ok && (
          <Banner tone={data.categories.includes("agentic-browsing") ? "warning" : "success"}>
            <Text as="p" variant="bodyMd">
              Kategorien in der Antwort: {data.categories.join(", ") || "—"}
            </Text>
          </Banner>
        )}
        {data && !data.ok && (
          <Banner tone="critical">
            <Text as="p" variant="bodyMd">Fehler: {data.error}</Text>
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}
