/**
 * PageSpeed Raw-Response Probe — Settings tab (dev-only).
 *
 * PROBE (accessibility plan §3.3): one button that fetches the COMPLETE,
 * unparsed PageSpeed Insights response for one storefront path + device and
 * downloads it as a file, plus shows the top-level category keys inline. It
 * exists to answer one open question: does Google ship an `agentic-browsing`
 * category we never requested? See docs/plans/PLAN_ACCESSIBILITY.md §3.3.
 *
 * Posts to the `debugRawPsi` intent of /app/seo/performance (which owns the
 * domain resolution, allow-list check and the raw PSI fetch). Bypasses cache
 * and the daily budget, but spends one real Google PSI request per click.
 * Temporary — remove together with the §3.3 finding.
 */

import { useState, useCallback } from "react";
import { Card, Text, BlockStack, Button, InlineStack, ButtonGroup, TextField, Banner } from "@shopify/polaris";

type DebugRawPsiResult =
  | { ok: true; categories: string[]; raw: unknown }
  | { ok: false; error: string };

export function SettingsPageSpeedProbeTab() {
  const [path, setPath] = useState("/");
  const [strategy, setStrategy] = useState<"mobile" | "desktop">("mobile");
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCategories(null);
    try {
      const fd = new FormData();
      fd.set("intent", "debugRawPsi");
      fd.set("url", path.trim() || "/");
      fd.set("strategy", strategy);
      const res = await fetch("/app/seo/performance", { method: "POST", body: fd });
      const data = (await res.json()) as DebugRawPsiResult;
      if (!data.ok) {
        setError(data.error || "failed");
        return;
      }
      setCategories(data.categories);
      // Download the complete raw response as a file.
      try {
        const blob = new Blob([JSON.stringify(data.raw, null, 2)], { type: "application/json" });
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = `psi-raw-${strategy}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      } catch {
        // Download blocked (sandboxed frame) — the category list below still shows.
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [path, strategy]);

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

        {categories && (
          <Banner tone={categories.includes("agentic-browsing") ? "warning" : "success"}>
            <Text as="p" variant="bodyMd">
              Kategorien in der Antwort: {categories.join(", ") || "—"}
            </Text>
          </Banner>
        )}
        {error && (
          <Banner tone="critical">
            <Text as="p" variant="bodyMd">Fehler: {error}</Text>
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}
