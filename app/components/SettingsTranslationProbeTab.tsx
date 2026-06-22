/**
 * Translation Coverage Probe — Settings tab (Phase 0 dev tool)
 *
 * One-shot UI that hits /api/translation-probe and renders a
 * paste-ready markdown report. Use this to populate
 * docs/PLAN_TRANSLATION_COVERAGE.md §12 spike findings before
 * starting Phase 1 backend work.
 *
 * Read-only by default. "Run + write test" attempts a single SHOP
 * write to answer the built-in-override question. Safe to run
 * repeatedly — write writes a uniquely-tagged value and instructions
 * for restoring it via admin are shown after.
 */

import { useState, useCallback, useMemo } from "react";
import { Card, Text, BlockStack, Button, Banner, InlineStack, Checkbox } from "@shopify/polaris";

interface KeyStats {
  prefix: string;
  count: number;
  samples: string[];
}

interface ResourceReport {
  resourceType: string;
  status: "ok" | "error";
  errorMessage?: string;
  resourceCount: number;
  totalKeys: number;
  keysByPrefix: KeyStats[];
  sampleKeys: Array<{ key: string; value: string | null; locale: string; digest: string }>;
  translationLocalesSeen: string[];
}

interface WriteTestReport {
  attempted: boolean;
  targetLocale?: string;
  targetKey?: string;
  before?: string | null;
  attemptedValue?: string;
  result?: "success" | "failure";
  errors?: string[];
  note?: string;
}

interface ProbeReport {
  generatedAt: string;
  shop: string;
  primaryLocale: string;
  enabledLocales: string[];
  apiVersion: string;
  resources: ResourceReport[];
  writeTest: WriteTestReport;
}

function formatMarkdown(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push(`# Translation Probe Report`);
  lines.push(``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Shop: ${report.shop}`);
  lines.push(`- Primary locale: ${report.primaryLocale}`);
  lines.push(`- Enabled locales: ${report.enabledLocales.join(", ") || "(none)"}`);
  lines.push(`- API version: ${report.apiVersion}`);
  lines.push(``);

  lines.push(`## Per-resource summary`);
  lines.push(``);
  lines.push(`| Resource | Status | Resources | Total keys | Top prefixes |`);
  lines.push(`|---|---|---:|---:|---|`);
  for (const r of report.resources) {
    const prefixes = r.keysByPrefix.slice(0, 5).map((p) => `${p.prefix} (${p.count})`).join(", ") || "—";
    lines.push(`| \`${r.resourceType}\` | ${r.status === "ok" ? "✅" : "❌"} | ${r.resourceCount} | ${r.totalKeys} | ${prefixes} |`);
  }
  lines.push(``);

  for (const r of report.resources) {
    lines.push(`### ${r.resourceType}`);
    lines.push(``);
    if (r.status === "error") {
      lines.push(`**Error:** \`${r.errorMessage}\``);
      lines.push(``);
      continue;
    }
    lines.push(`- Resources: ${r.resourceCount}`);
    lines.push(`- Total translatable keys: ${r.totalKeys}`);
    lines.push(`- Locales seen on \`translatableContent\`: ${r.translationLocalesSeen.join(", ") || "(none)"}`);
    if (r.keysByPrefix.length > 0) {
      lines.push(`- Key prefixes:`);
      for (const p of r.keysByPrefix) {
        lines.push(`  - \`${p.prefix}.*\` — ${p.count} keys (e.g. ${p.samples.slice(0, 3).map((s) => `\`${s}\``).join(", ")})`);
      }
    }
    if (r.sampleKeys.length > 0) {
      lines.push(`- Sample entries:`);
      for (const s of r.sampleKeys.slice(0, 5)) {
        const val = s.value === null ? "(null)" : `"${s.value.replace(/\n/g, " ⏎ ")}"`;
        lines.push(`  - \`${s.key}\` [${s.locale}] = ${val}`);
      }
    }
    lines.push(``);
  }

  lines.push(`## Write test (SHOP override probe)`);
  lines.push(``);
  if (!report.writeTest.attempted) {
    lines.push(`Not attempted.${report.writeTest.note ? ` ${report.writeTest.note}` : ""}`);
  } else {
    lines.push(`- Target key: \`${report.writeTest.targetKey}\``);
    lines.push(`- Target locale: \`${report.writeTest.targetLocale}\``);
    lines.push(`- Value before: ${report.writeTest.before === null ? "(no existing override)" : `"${report.writeTest.before}"`}`);
    lines.push(`- Value written: "${report.writeTest.attemptedValue}"`);
    lines.push(`- Result: ${report.writeTest.result === "success" ? "✅ accepted by API" : "❌ failed"}`);
    if (report.writeTest.errors?.length) {
      lines.push(`- Errors:`);
      for (const e of report.writeTest.errors) lines.push(`  - ${e}`);
    }
    if (report.writeTest.note) {
      lines.push(``);
      lines.push(`**Manual verification step:** ${report.writeTest.note}`);
    }
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`_Paste this report back into the assistant to populate \`docs/PLAN_TRANSLATION_COVERAGE.md\` §12 spike findings._`);

  return lines.join("\n");
}

export function SettingsTranslationProbeTab() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeWriteTest, setIncludeWriteTest] = useState(false);

  const runProbe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      if (includeWriteTest) fd.set("writeTest", "true");
      const r = await fetch("/api/translation-probe", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { success: boolean; report?: ProbeReport; error?: string };
      if (!j.success || !j.report) throw new Error(j.error || "Probe failed");
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [includeWriteTest]);

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
          <Text as="h2" variant="headingMd">Translation Coverage Probe</Text>
          <Text as="p" tone="subdued">
            One-shot diagnostic for Phase 0 of the Translation Coverage plan. Queries every new
            <code> TranslatableResourceType </code> the plan calls out, plus an optional SHOP
            write test that answers the built-in-override question.
          </Text>
          <Banner tone="info">
            <Text as="p">
              Read-only by default. The optional write test registers a uniquely-tagged value
              against <code>checkout.general.continue_button</code> in the first non-primary
              locale. Restore the original via Shopify Admin → Settings → Languages → Translate
              after running.
            </Text>
          </Banner>
          <Checkbox
            label="Also run write test (registers one tagged SHOP override — see banner)"
            checked={includeWriteTest}
            onChange={(checked) => setIncludeWriteTest(checked)}
          />
          <InlineStack gap="200">
            <Button onClick={runProbe} loading={loading} variant="primary">
              {report ? "Re-run probe" : "Run probe"}
            </Button>
            {report && (
              <Button onClick={copyToClipboard}>Copy markdown report</Button>
            )}
          </InlineStack>
          {error && (
            <Banner tone="critical">
              <Text as="p">Probe failed: {error}</Text>
            </Banner>
          )}
        </BlockStack>
      </Card>

      {report && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Paste-ready report ({report.resources.length} types probed)
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
              Paste this report back into the assistant chat to populate the plan&apos;s §12 spike findings.
            </Text>
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
