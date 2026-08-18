/**
 * Collection-Model Probe — Settings tab (PLAN_CONTENT_CREATION Phase 0 dev tool)
 *
 * One-shot UI over /api/collection-model-probe. Answers the two Phase-0
 * measurements that need a live shop: what the collection RULE types look like
 * on a chosen API version (input for `collection-rules.shared.ts`), and whether
 * `collectionUpdate` with `sourcesToCreate` converts a manual collection.
 *
 * The version is selectable because the app is pinned to 2025-10 while the
 * question is about 2026-07 — the route reaches that version by raw-fetching it
 * directly. No deploy, no pin change. The value is validated against the known
 * version list server-side; it ends up as a path segment in the admin URL.
 *
 * Read-only unless "write test" is ticked — that one CREATES and deletes a
 * throwaway collection. The whole ROUTE is refused outside APP_ENV=development,
 * write test or not: even the read half costs the shop a double-digit number of
 * Admin API calls per run.
 */

import { useState, useCallback, useMemo } from "react";
import { Card, Text, BlockStack, Button, Banner, InlineStack, Checkbox, TextField } from "@shopify/polaris";

interface TypeShape {
  name: string;
  kind: string;
  fields?: Array<{ name: string; type: string }>;
  enumValues?: string[];
  /** The API answered and the type is not there — a real negative. */
  missing?: boolean;
  /** We never got an answer — NOT a negative. Must never render as "missing". */
  error?: string;
}

interface ProbeReport {
  shop: string;
  ranAt: string;
  pinnedApiVersion: string;
  probedApiVersion: string;
  versionReachability: Array<{ version: string; reachable: boolean; detail: string }>;
  discoveredTypeNames: string[];
  noiseTypesSkipped?: number;
  discoveryError?: string;
  typesTruncated: boolean;
  types: TypeShape[];
  verdicts: string[];
  writeTest: {
    attempted: boolean;
    skippedReason?: string;
    steps?: Array<{ step: string; ok: boolean; detail: string }>;
    verdict?: string;
  };
}

function formatMarkdown(r: ProbeReport): string {
  const lines: string[] = [];
  lines.push(`# Collection-Model Probe — ${r.shop}`);
  lines.push("");
  lines.push(`- Run: ${r.ranAt}`);
  lines.push(`- App is pinned to: **${r.pinnedApiVersion}**`);
  lines.push(`- Probed: **${r.probedApiVersion}**`);
  lines.push("");

  lines.push("## Verdicts");
  lines.push("");
  if (r.verdicts.length === 0) lines.push("_none_");
  for (const v of r.verdicts) lines.push(`- ${v}`);
  lines.push("");

  lines.push("## API version reachability");
  lines.push("");
  lines.push("| Version | Reachable | Detail |");
  lines.push("|---|---|---|");
  for (const v of r.versionReachability) {
    lines.push(`| ${v.version} | ${v.reachable ? "✅" : "❌"} | ${v.detail.replace(/\|/g, "\\|").slice(0, 120)} |`);
  }
  lines.push("");

  const found = r.types.filter((t) => !t.missing && !t.error).length;
  const missing = r.types.filter((t) => t.missing).length;
  const unknown = r.types.filter((t) => t.error).length;
  lines.push(`## Types (${found} found, ${missing} absent, ${unknown} UNKNOWN)`);
  if (unknown > 0) {
    lines.push("");
    lines.push(`> ⚠ ${unknown} type(s) could not be read. Unknown is not the same as absent — re-run before concluding anything about them.`);
  }
  if (r.typesTruncated) {
    lines.push("");
    lines.push(`> ⚠ The discovered-type list was capped. ${r.discoveredTypeNames.length} names matched; not all were introspected. Input types and enums are probed FIRST, so the cut tail is the least informative part.`);
  }
  lines.push("");
  for (const t of r.types) {
    if (t.error) {
      lines.push(`### ${t.name} — ⚠ UNKNOWN (could not be read: ${t.error})`);
      lines.push("");
      continue;
    }
    if (t.missing) {
      lines.push(`### ${t.name} — ❌ does not exist on ${r.probedApiVersion}`);
      lines.push("");
      continue;
    }
    lines.push(`### ${t.name} (${t.kind})`);
    lines.push("");
    if (t.enumValues && t.enumValues.length > 0) {
      lines.push("```");
      lines.push(t.enumValues.join("\n"));
      lines.push("```");
      lines.push("");
    }
    if (t.fields && t.fields.length > 0) {
      lines.push("```graphql");
      for (const f of t.fields) lines.push(`${f.name}: ${f.type}`);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Write test (measurement B)");
  lines.push("");
  if (!r.writeTest.attempted) {
    lines.push(`_Not run: ${r.writeTest.skippedReason ?? "—"}_`);
  } else {
    lines.push(`**${r.writeTest.verdict ?? "—"}**`);
    lines.push("");
    for (const s of r.writeTest.steps ?? []) {
      lines.push(`- ${s.ok ? "✅" : "❌"} **${s.step}** — ${s.detail.slice(0, 500)}`);
    }
  }
  lines.push("");

  lines.push("## All matching type names discovered");
  lines.push("");
  if (r.discoveryError) {
    lines.push(`> ⚠ The type sweep FAILED (${r.discoveryError}). An empty list below means "not measured", not "none exist".`);
    lines.push("");
  }
  lines.push("```");
  lines.push(r.discoveredTypeNames.join("\n") || "(none)");
  lines.push("```");

  return lines.join("\n");
}

export function SettingsCollectionModelProbeTab() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiVersion, setApiVersion] = useState("2026-07");
  const [includeWriteTest, setIncludeWriteTest] = useState(false);
  const [sourcesOverride, setSourcesOverride] = useState("");

  const runProbe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("apiVersion", apiVersion);
      if (includeWriteTest) fd.set("writeTest", "true");
      if (sourcesOverride.trim()) fd.set("sourcesToCreate", sourcesOverride.trim());
      const r = await fetch("/api/collection-model-probe", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { success: boolean; report?: ProbeReport; error?: string };
      if (!j.success || !j.report) throw new Error(j.error || "Probe failed");
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiVersion, includeWriteTest, sourcesOverride]);

  const markdown = useMemo(() => (report ? formatMarkdown(report) : ""), [report]);

  const copyToClipboard = useCallback(async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      // fallback handled by the textarea — user can ctrl+a / ctrl+c
    }
  }, [markdown]);

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Collection-Model Probe</Text>
          <Text as="p" tone="subdued">
            Phase-0 diagnostic for PLAN_CONTENT_CREATION. Asks the target API version which
            collection rule types actually exist and what their enums are — the input for the
            rule editor — and optionally whether <code>collectionUpdate</code> with{" "}
            <code>sourcesToCreate</code> converts a manual collection.
          </Text>
          <Text as="p" tone="subdued">
            The app is pinned to an older version; this probe talks to the version below directly,
            so no deploy and no pin change is needed. Type names are DISCOVERED, not assumed — a
            plan type that comes back missing is a real finding.
          </Text>

          <TextField
            label="API version to probe"
            value={apiVersion}
            onChange={setApiVersion}
            autoComplete="off"
            helpText="e.g. 2026-07 — the version PLAN §1.0 targets for both the deadline and the sources model. Validated server-side against the known version list."
          />

          <Checkbox
            label="Also run the write test (measurement B)"
            checked={includeWriteTest}
            onChange={setIncludeWriteTest}
            helpText="Creates a throwaway collection, tries to convert it, reads back, then deletes it. If the cleanup fails the report says so and names the collection to remove by hand."
          />

          {includeWriteTest && (
            <TextField
              label="sourcesToCreate override (JSON, optional)"
              value={sourcesOverride}
              onChange={setSourcesOverride}
              multiline={4}
              autoComplete="off"
              helpText="Leave empty to let the probe DERIVE the condition from the types it just introspected — the 2026-07 model uses one typed input per attribute, not a generic column/relation triple. Override only if that derivation fails; the report always shows what was sent."
            />
          )}

          <InlineStack gap="200">
            <Button variant="primary" onClick={runProbe} loading={loading}>
              {includeWriteTest ? "Run probe + write test" : "Run probe (read-only)"}
            </Button>
            {report && <Button onClick={copyToClipboard}>Copy markdown report</Button>}
          </InlineStack>
        </BlockStack>
      </Card>

      {error && (
        <Banner tone="critical" title="Probe failed">
          <p>{error}</p>
        </Banner>
      )}

      {report && report.verdicts.length > 0 && (
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">Verdicts</Text>
            {report.verdicts.map((v, i) => (
              <Text as="p" key={i}>{v}</Text>
            ))}
          </BlockStack>
        </Card>
      )}

      {report && (report.discoveryError || report.typesTruncated || report.types.some((t) => t.error)) && (
        <Banner tone="warning" title="Parts of this report are UNKNOWN, not negative">
          <BlockStack gap="100">
            {report.discoveryError && <Text as="p">Type sweep failed: {report.discoveryError}</Text>}
            {report.types.some((t) => t.error) && (
              <Text as="p">
                {report.types.filter((t) => t.error).length} type(s) could not be read. Re-run before
                concluding they do not exist.
              </Text>
            )}
            {report.typesTruncated && (
              <Text as="p">
                The discovered-type list was capped at the introspection limit — {report.discoveredTypeNames.length}{" "}
                names matched and not all were probed.
              </Text>
            )}
          </BlockStack>
        </Banner>
      )}

      {report && !report.writeTest.attempted && report.writeTest.skippedReason && (
        <Banner tone="info" title="Write test not run">
          <p>{report.writeTest.skippedReason}</p>
        </Banner>
      )}

      {report?.writeTest.attempted && (
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">Write test</Text>
            <Text as="p">{report.writeTest.verdict}</Text>
            {report.writeTest.steps?.map((s, i) => (
              <Text as="p" key={i} tone={s.ok ? "subdued" : "critical"}>
                {s.ok ? "✅" : "❌"} {s.step} — {s.detail.slice(0, 300)}
              </Text>
            ))}
          </BlockStack>
        </Card>
      )}

      {report && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Paste-ready report ({report.types.filter((t) => !t.missing && !t.error).length} types found)
            </Text>
            <textarea
              readOnly
              value={markdown}
              style={{
                width: "100%",
                minHeight: "400px",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "12px",
                padding: "12px",
                border: "1px solid #c9cccf",
                borderRadius: "8px",
                background: "#fafbfb",
                resize: "vertical",
              }}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Text as="p" tone="subdued">
              Paste this back into the assistant chat — it is what Phase 1.4b and §2.4 get planned from.
            </Text>
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
