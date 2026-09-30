/**
 * Settings → Probes → Translation: the market probe card (api.market-probe.tsx).
 *
 * Runs the "Märkte und Adressen" writes on a DRAFT market of its own and
 * prints a paste-ready report. Dev-only like every probe; it WRITES, so the
 * run is behind an explicit switch.
 */

import { useCallback, useMemo, useState } from "react";
import { Banner, BlockStack, Button, Card, InlineStack, Text, TextField } from "@shopify/polaris";
import { ToggleRow } from "./ToggleRow";

// Mirrors the report in api.market-probe.tsx — re-declared rather than
// imported, because that module is a server route.
interface MarketProbeStep {
  id: string;
  title: string;
  outcome: "ok" | "failed" | "skipped" | "info" | "warning";
  detail: string;
  data?: unknown;
}
interface MarketProbeReport {
  generatedAt: string;
  shop: string;
  apiVersion: string;
  schema: {
    mutations: Array<{ name: string; exists: boolean; deprecated?: boolean; args?: string[] }>;
    types: Record<string, unknown>;
  };
  steps: MarketProbeStep[];
  cleanup: { allRemoved: boolean; leftovers: string[]; notes: string[] };
  verdict: string[];
}

function toMarkdown(r: MarketProbeReport): string {
  const lines: string[] = [];
  lines.push(`# Market probe — ${r.shop}`, "", `Generated ${r.generatedAt}, API ${r.apiVersion}`, "");
  lines.push("## Verdict", ...r.verdict.map((v) => `- ${v}`), "");
  lines.push("## Steps");
  for (const s of r.steps) {
    lines.push(`### ${s.title} — ${s.outcome.toUpperCase()}`, s.detail);
    if (s.data !== undefined) lines.push("```json", JSON.stringify(s.data, null, 2), "```");
    lines.push("");
  }
  lines.push("## Cleanup", `All removed: ${r.cleanup.allRemoved ? "yes" : "NO"}`);
  for (const l of r.cleanup.leftovers) lines.push(`- LEFTOVER: ${l}`);
  for (const n of r.cleanup.notes) lines.push(`- ${n}`);
  lines.push("", "## Mutations");
  for (const m of r.schema.mutations) {
    lines.push(`- ${m.name}: ${m.exists ? `yes${m.deprecated ? " (deprecated)" : ""} (${(m.args ?? []).join(", ")})` : "ABSENT"}`);
  }
  lines.push("", "## Types");
  for (const [name, shape] of Object.entries(r.schema.types)) {
    lines.push(`### ${name}`);
    if (!shape) {
      lines.push("(does not exist in this version)");
      continue;
    }
    const t = shape as { error?: string; inputFields?: string[]; fields?: string[]; enumValues?: string[] };
    if (t.error) lines.push(`error: ${t.error}`);
    for (const f of [...(t.inputFields ?? []), ...(t.fields ?? []), ...(t.enumValues ?? [])]) lines.push(`- ${f}`);
  }
  return lines.join("\n");
}

export function MarketProbeCard() {
  const [confirmed, setConfirmed] = useState(false);
  const [countries, setCountries] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<MarketProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("confirm", "true");
      if (countries.trim()) fd.set("countries", countries);
      const r = await fetch("/api/market-probe", { method: "POST", body: fd });
      const j = (await r.json()) as { report?: MarketProbeReport; error?: string };
      if (!r.ok || !j.report) throw new Error(j.error || `HTTP ${r.status}`);
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [countries]);

  const markdown = useMemo(() => (report ? toMarkdown(report) : ""), [report]);
  // A failed CLEANUP outranks every other verdict: it leaves something behind.
  const tone = !report
    ? ("info" as const)
    : !report.cleanup.allRemoved
      ? ("critical" as const)
      : report.steps.some((s) => s.outcome === "failed" || s.outcome === "warning")
        ? ("warning" as const)
        : ("success" as const);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">Markets and addresses (Sprachen und Märkte writes)</Text>
        <Text as="p" tone="subdued">
          Measures every write behind Settings → Sprachen und Märkte → Märkte und Adressen, through the app&apos;s own
          functions: creating a market as a DRAFT, giving it its own subfolder, assigning a language to that
          address (and whether <code>marketWebPresenceIds</code> REPLACES or ADDS), removing the address, and
          whether <code>marketDelete</code> takes an attached address with it. Also introspects every input type
          the code guesses at, including deprecated fields, and whether <code>Market.primary</code> exists.
        </Text>
        <Banner tone="warning">
          <Text as="p">
            This probe WRITES. It creates ONE draft market of its own (named &quot;ContentPilot probe …&quot;, for
            Tuvalu or the first country you name below that no market covers yet) plus a subfolder address for
            it, and deletes both again. A draft market sells nowhere. The language test ADDS the probe&apos;s
            address to your first second language and then restores that language&apos;s exact previous set —
            its existing markets are never taken away. If a cleanup fails, the report names what is left.
          </Text>
        </Banner>
        <TextField
          label="Countries to try (optional)"
          helpText="Two-letter codes, comma-separated. Default: TV, NR, KI, TO, WS — the first no market covers is used."
          value={countries}
          onChange={setCountries}
          autoComplete="off"
        />
        <ToggleRow
          layout="inline"
          label="I understand this creates and deletes a draft market and an address in my shop"
          checked={confirmed}
          onChange={setConfirmed}
        />
        <InlineStack gap="200">
          <Button onClick={run} loading={loading} disabled={!confirmed}>
            {report ? "Re-run market probe" : "Run market probe"}
          </Button>
          {report && <Button onClick={() => navigator.clipboard?.writeText(markdown)}>Copy markdown report</Button>}
        </InlineStack>
        {error && (
          <Banner tone="critical">
            <Text as="p">Probe failed: {error}</Text>
          </Banner>
        )}
        {report && (
          <BlockStack gap="200">
            <Banner tone={tone}>
              <BlockStack gap="100">
                {report.verdict.map((v, i) => (
                  <Text as="p" key={i}>
                    {v}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
            <textarea
              readOnly
              value={markdown}
              style={{
                width: "100%",
                minHeight: "320px",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "12px",
                padding: "12px",
                border: "1px solid var(--app-field-border-color)",
                borderRadius: "8px",
                background: "#fafbfb",
                resize: "vertical",
              }}
              onFocus={(e) => e.currentTarget.select()}
            />
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
