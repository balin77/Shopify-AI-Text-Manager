/**
 * Metaobject Probe -- Settings sub-tab (PLAN_METAOBJECTS_EDITOR Phase 0).
 *
 * One-shot UI over /api/metaobject-probe. The four steps are ticked
 * INDIVIDUALLY because two of them write to the merchant's live shop: the
 * write test creates and deletes a throwaway entry, the link test additionally
 * creates and deletes a throwaway product. Neither is ticked by default.
 *
 * The whole ROUTE is refused outside APP_ENV=development -- ticking nothing
 * still costs the shop a double-digit number of Admin API calls.
 *
 * The report is rendered as-is AND offered as markdown, because its purpose is
 * to be pasted into the plan's §2 table with a date next to it. A measurement
 * that stays in a browser tab was not a measurement.
 */

import { useCallback, useMemo, useState } from "react";
import { Card, Text, BlockStack, Button, Banner, InlineStack, Checkbox, TextField } from "@shopify/polaris";

interface StepOutcome {
  step: string;
  ok: boolean;
  detail: string;
}

interface DefinitionShape {
  id: string;
  type: string;
  name: string;
  standard: boolean;
  access?: { admin?: string | null; storefront?: string | null } | null;
  capabilities?: Record<string, unknown> | null;
  createdByApp?: string | null;
  fieldDefinitions: Array<{ key: string; name?: string; type: string; required?: boolean }>;
}

interface SampleEntry {
  id: string;
  handle: string;
  displayName: string;
  fields: Array<{ key: string; value: string | null; type: string }>;
  translatableKeys?: string[];
  translatableError?: string;
}

interface ProbeReport {
  shop: string;
  ranAt: string;
  apiVersion: string;
  requestedSteps: string[];
  definitions?: DefinitionShape[];
  definitionsError?: string;
  definitionsFullSelection?: boolean;
  samples?: { type: string; entries: SampleEntry[]; error?: string };
  metaobjectTypeFields?: string[];
  metaobjectTypeFieldsError?: string;
  reverseRelationField?: string | null;
  reverseRelation?: {
    connectionType?: string;
    connectionFields?: string[];
    nodeType?: string;
    nodeFields?: string[];
    liveShape?: "nodes" | "edges";
    liveSample?: string;
    error?: string;
  };
  writeTest: { attempted: boolean; skippedReason?: string; steps?: StepOutcome[]; verdict?: string; leftovers?: string[] };
  linkTest: { attempted: boolean; skippedReason?: string; steps?: StepOutcome[]; verdict?: string; leftovers?: string[] };
  verdicts: string[];
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").slice(0, 200);
}

function formatMarkdown(r: ProbeReport): string {
  const lines: string[] = [];
  lines.push(`# Metaobject Probe -- ${r.shop}`);
  lines.push("");
  lines.push(`- Run: ${r.ranAt}`);
  lines.push(`- API version: **${r.apiVersion}**`);
  lines.push(`- Steps run: ${r.requestedSteps.join(", ") || "(none)"}`);
  lines.push("");

  lines.push("## Verdicts");
  lines.push("");
  if (r.verdicts.length === 0) lines.push("_none_");
  for (const v of r.verdicts) lines.push(`- ${v}`);
  lines.push("");

  if (r.definitions) {
    lines.push("## Definitions");
    lines.push("");
    if (r.definitionsFullSelection === false) {
      lines.push(
        `> The full selection was refused, so access/capabilities are **UNKNOWN, not absent**: ${r.definitionsError}`,
      );
      lines.push("");
    }
    lines.push("| Type | Name | Standard | admin access | Fields |");
    lines.push("|---|---|---|---|---|");
    for (const d of r.definitions) {
      lines.push(
        `| ${escapeCell(d.type)} | ${escapeCell(d.name)} | ${d.standard ? "yes" : "no"} | ${
          d.access?.admin ?? "?"
        } | ${escapeCell(d.fieldDefinitions.map((f) => `${f.key}:${f.type}${f.required ? "*" : ""}`).join(", "))} |`,
      );
    }
    lines.push("");
  }
  if (r.definitionsError && !r.definitions?.length) {
    lines.push(`> Definition list unavailable: ${r.definitionsError}`);
    lines.push("");
  }

  if (r.metaobjectTypeFields || r.metaobjectTypeFieldsError) {
    lines.push("## Metaobject type (V4)");
    lines.push("");
    lines.push(
      r.metaobjectTypeFieldsError
        ? `> Introspection failed: ${r.metaobjectTypeFieldsError} -- **not** a negative answer.`
        : `Reverse relation: **${r.reverseRelationField ?? "none found"}**. Fields: ${(r.metaobjectTypeFields ?? []).join(", ")}`,
    );
    lines.push("");
  }

  if (r.reverseRelation) {
    const rr = r.reverseRelation;
    lines.push("## Reverse relation shape (V4)");
    lines.push("");
    lines.push(`- Connection type: **${rr.connectionType ?? "unknown"}**`);
    lines.push(`- Connection fields: ${(rr.connectionFields ?? []).join(", ") || "unknown"}`);
    lines.push(`- Node type: **${rr.nodeType ?? "unknown"}**`);
    if (rr.nodeFields?.length) lines.push(`- Node fields / members: ${rr.nodeFields.join(", ")}`);
    lines.push(`- Live run: ${rr.liveShape ? `works via \`${rr.liveShape}\`` : "not proven"}`);
    if (rr.liveSample) {
      lines.push("");
      lines.push("```json");
      lines.push(rr.liveSample);
      lines.push("```");
    }
    if (rr.error) lines.push(`> ${rr.error}`);
    lines.push("");
  }

  if (r.samples) {
    lines.push(`## Sample values -- ${r.samples.type}`);
    lines.push("");
    if (r.samples.error) lines.push(`> ${r.samples.error}`);
    for (const e of r.samples.entries) {
      lines.push(`### ${e.displayName || e.handle}`);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(e.fields, null, 2));
      lines.push("```");
      lines.push(
        e.translatableError
          ? `> translatable keys unknown: ${e.translatableError}`
          : `Translatable keys: ${(e.translatableKeys ?? []).join(", ") || "(none reported -- may just mean no primary value)"}`,
      );
      lines.push("");
    }
  }

  for (const [title, test] of [
    ["Write test (V1, M2)", r.writeTest],
    ["Link + delete test (V3, V4, V5)", r.linkTest],
  ] as const) {
    lines.push(`## ${title}`);
    lines.push("");
    if (!test.attempted) {
      lines.push(`_not run_${test.skippedReason ? ` -- ${test.skippedReason}` : ""}`);
      lines.push("");
      continue;
    }
    lines.push("| Step | OK | Detail |");
    lines.push("|---|---|---|");
    for (const s of test.steps ?? []) {
      lines.push(`| ${escapeCell(s.step)} | ${s.ok ? "yes" : "no"} | ${escapeCell(s.detail)} |`);
    }
    lines.push("");
    if (test.verdict) lines.push(`**${test.verdict}**`);
    if (test.leftovers?.length) {
      lines.push("");
      lines.push(`> NOT CLEANED UP -- remove by hand: ${test.leftovers.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function SettingsMetaobjectProbeTab() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ProbeReport | null>(null);

  const [runSamples, setRunSamples] = useState(true);
  const [runReferences, setRunReferences] = useState(true);
  const [runWrite, setRunWrite] = useState(false);
  const [runLink, setRunLink] = useState(false);
  const [sampleType, setSampleType] = useState("shopify--color-pattern");
  const [writeType, setWriteType] = useState("shopify--color-pattern");

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const steps = [
        "definitions",
        ...(runReferences ? ["references"] : []),
        ...(runSamples ? ["samples"] : []),
        ...(runWrite ? ["write"] : []),
        ...(runLink ? ["link"] : []),
      ];
      const body = new FormData();
      body.set("steps", steps.join(","));
      body.set("sampleType", sampleType);
      body.set("writeType", writeType);
      const res = await fetch("/api/metaobject-probe", { method: "POST", body });
      const data = await res.json();
      if (!data.success) {
        setError(typeof data.error === "string" ? data.error : "The probe returned no report.");
        setReport(null);
        return;
      }
      setReport(data.report as ProbeReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [runSamples, runReferences, runWrite, runLink, sampleType, writeType]);

  const markdown = useMemo(() => (report ? formatMarkdown(report) : ""), [report]);

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Metaobject probe (dev only)
          </Text>
          <Text as="p" tone="subdued">
            Measures PLAN_METAOBJECTS_EDITOR §2 V1-V5 and M2 against this shop. Steps 3 and 4 CREATE and delete real
            objects (a metaobject entry, and for step 4 a draft product) -- they are off by default.
          </Text>

          <Checkbox
            label="Step 2: sample entry values and translatable keys (read-only)"
            checked={runSamples}
            onChange={setRunSamples}
          />
          <Checkbox
            label="Step 2b: the shape of Metaobject.referencedBy — connection, node type, live run (read-only)"
            checked={runReferences}
            onChange={setRunReferences}
          />
          <TextField
            label="Sample / write definition type"
            value={sampleType}
            onChange={(v) => {
              setSampleType(v);
              setWriteType(v);
            }}
            autoComplete="off"
            helpText="Defaults to Shopify's standard colour definition."
          />
          <Checkbox
            label="Step 3: write test -- create, update and delete a throwaway entry of that type (WRITES)"
            checked={runWrite}
            onChange={setRunWrite}
          />
          <Checkbox
            label="Step 4: link + delete test -- also creates and deletes a draft product (WRITES)"
            checked={runLink}
            onChange={setRunLink}
          />

          <InlineStack gap="200">
            <Button variant="primary" loading={running} onClick={() => void run()}>
              Run probe
            </Button>
            {markdown && (
              <Button onClick={() => void navigator.clipboard?.writeText(markdown)}>Copy markdown</Button>
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
            <Text as="h3" variant="headingSm">
              Result
            </Text>
            {(report.writeTest.leftovers?.length || report.linkTest.leftovers?.length) && (
              <Banner tone="warning" title="Not cleaned up">
                <p>
                  These objects could not be removed and are still in the shop:{" "}
                  {[...(report.writeTest.leftovers ?? []), ...(report.linkTest.leftovers ?? [])].join(", ")}
                </p>
              </Banner>
            )}
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: "0.75rem",
                background: "var(--p-color-bg-surface-secondary)",
                padding: "0.75rem",
                borderRadius: "8px",
                maxHeight: "60vh",
                overflow: "auto",
              }}
            >
              {markdown}
            </pre>
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
