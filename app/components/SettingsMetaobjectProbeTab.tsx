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
  fieldDefinitions: Array<{
    key: string;
    name?: string;
    type: string;
    required?: boolean;
    validations?: Array<{ name: string; value: string | null }>;
  }>;
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
  taxonomy?: {
    taxonomyFields?: string[];
    valueTypeFields?: string[];
    resolvedValues?: Array<{ gid: string; typename?: string; label?: string; error?: string }>;
    valueSource?: string;
    valueCount?: number;
    valueSample?: string[];
    valuesTruncated?: boolean;
    steps: StepOutcome[];
  };
  reverseRelation?: {
    connectionType?: string;
    connectionFields?: string[];
    nodeType?: string;
    nodeFields?: string[];
    liveShape?: "nodes" | "edges";
    liveSample?: string;
    nodeSelection?: string;
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
        } | ${escapeCell(
          d.fieldDefinitions
            .map(
              (f) =>
                `${f.key}:${f.type}${f.required ? "*" : ""}${
                  f.validations?.length ? ` {${f.validations.map((v) => `${v.name}=${v.value ?? ""}`).join("; ")}}` : ""
                }`,
            )
            .join(", "),
        )} |`,
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

  if (r.taxonomy) {
    const t = r.taxonomy;
    lines.push("## Taxonomy reference values (T1-T3)");
    lines.push("");
    if (t.taxonomyFields) lines.push(`- \`Taxonomy\` fields: ${t.taxonomyFields.join(", ")}`);
    if (t.valueTypeFields) lines.push(`- Value type fields: ${t.valueTypeFields.join(", ")}`);
    if (t.resolvedValues?.length) {
      lines.push(`- Resolved GIDs: ${t.resolvedValues.map((v) => `${v.gid} → ${v.typename ?? v.error ?? "?"}`).join(", ")}`);
    }
    if (t.valueCount !== undefined) {
      lines.push(
        `- **Permitted values: ${t.valueCount}${t.valuesTruncated ? " or more" : ""}** via \`${t.valueSource}\`` +
          (t.valueSample?.length ? ` — ${t.valueSample.join(", ")}` : ""),
      );
    }
    lines.push("");
    lines.push("| Step | OK | Detail |");
    lines.push("|---|---|---|");
    for (const step of t.steps) {
      lines.push(`| ${escapeCell(step.step)} | ${step.ok ? "yes" : "no"} | ${escapeCell(step.detail)} |`);
    }
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
    if (rr.nodeSelection) lines.push(`- Node selection used: \`${rr.nodeSelection}\``);
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
  const [runTaxonomy, setRunTaxonomy] = useState(false);
  const [runWrite, setRunWrite] = useState(false);
  const [runLink, setRunLink] = useState(false);
  const [sampleType, setSampleType] = useState("shopify--color-pattern");
  const [writeType, setWriteType] = useState("shopify--color-pattern");
  /** GIDs a previous run reported as "could not be removed". */
  const [cleanupIds, setCleanupIds] = useState("");
  /** Kept SEPARATE from `report`: the banner's own flow is "put these in the
   *  box, then remove them", and overwriting the measurement report with a
   *  cleanup-only one destroys the thing the merchant was about to paste. */
  const [cleanupOutcomes, setCleanupOutcomes] = useState<StepOutcome[] | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const steps = [
        "definitions",
        ...(runReferences ? ["references"] : []),
        ...(runTaxonomy ? ["taxonomy"] : []),
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
  }, [runSamples, runReferences, runTaxonomy, runWrite, runLink, sampleType, writeType]);

  /**
   * Remove leftovers a previous run could not.
   *
   * Its own button, never a tick on the measurement run: this DELETES named
   * objects, and mixing that into "run the probe" is how somebody removes
   * something they only meant to measure. A Shopify STANDARD definition is not
   * listed under Content > Metaobjects, so a leftover entry of one cannot be
   * removed by hand in the admin at all — which is why this exists.
   */
  const runCleanup = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("steps", "cleanup");
      body.set("cleanupIds", cleanupIds);
      const res = await fetch("/api/metaobject-probe", { method: "POST", body });
      const data = await res.json();
      if (!data.success) {
        setError(typeof data.error === "string" ? data.error : "The cleanup returned no report.");
        return;
      }
      setCleanupOutcomes((data.report as { cleanup?: StepOutcome[] }).cleanup ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [cleanupIds]);

  const markdown = useMemo(() => (report ? formatMarkdown(report) : ""), [report]);

  const copyToClipboard = useCallback(async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      // The textarea below is the fallback — click into it, ctrl+a, ctrl+c.
    }
  }, [markdown]);

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
            label="Taxonomy: can the permitted values of a taxonomy-reference field be reached? (read-only)"
            checked={runTaxonomy}
            onChange={setRunTaxonomy}
            helpText="PLAN_METAOBJECT_TAXONOMY_CREATE Phase 0 — decides whether colour entries can ever be created from this app, and whether the editor is a list or a search."
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
            {markdown && <Button onClick={() => void copyToClipboard()}>Copy markdown report</Button>}
          </InlineStack>

          {error && (
            <Banner tone="critical">
              <p>{error}</p>
            </Banner>
          )}

          <TextField
            label="Leftover object GIDs to remove"
            value={cleanupIds}
            onChange={setCleanupIds}
            autoComplete="off"
            multiline={2}
            helpText={
              "Paste what a previous run listed as \u201ccould not be removed\u201d. " +
              "Entries of a Shopify STANDARD definition are not listed under Content \u2192 Metaobjects, " +
              "so they cannot be deleted by hand in the admin \u2014 this is the way to remove them."
            }
          />
          <InlineStack gap="200">
            <Button tone="critical" loading={running} disabled={!cleanupIds.trim()} onClick={() => void runCleanup()}>
              Remove listed objects
            </Button>
          </InlineStack>
          {cleanupOutcomes && (
            <Banner tone={cleanupOutcomes.every((o) => o.ok) ? "success" : "warning"}>
              <BlockStack gap="100">
                {cleanupOutcomes.length === 0 && <p>Nothing to remove.</p>}
                {cleanupOutcomes.map((o) => (
                  <p key={o.step}>
                    {o.ok ? "✓" : "✗"} {o.step} — {o.detail}
                  </p>
                ))}
              </BlockStack>
            </Banner>
          )}
        </BlockStack>
      </Card>

      {report && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Paste-ready report
            </Text>
            {(report.writeTest.leftovers?.length || report.linkTest.leftovers?.length) && (
              <Banner
                tone="warning"
                title="Not cleaned up"
                action={{
                  content: "Put these in the cleanup box",
                  onAction: () =>
                    setCleanupIds(
                      [...(report.writeTest.leftovers ?? []), ...(report.linkTest.leftovers ?? [])].join("\n"),
                    ),
                }}
              >
                <p>
                  These objects could not be removed and are still in the shop:{" "}
                  {[...(report.writeTest.leftovers ?? []), ...(report.linkTest.leftovers ?? [])].join(", ")}
                </p>
                <p>
                  An entry of a Shopify standard definition does not appear under Content → Metaobjects, so
                  the admin cannot remove it — use the cleanup box above.
                </p>
              </Banner>
            )}
            {/* A read-only TEXTAREA, not a <pre>: one click into it selects the
                whole report, so Ctrl+C works even where the clipboard API is
                blocked — which it is inside an embedded admin iframe often
                enough to matter. Same affordance the translation probe uses,
                and for the same reason: a measurement that cannot leave the
                browser tab was not a measurement. */}
            <textarea
              readOnly
              value={markdown}
              onFocus={(e) => e.currentTarget.select()}
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
            />
            <Text as="p" tone="subdued">
              Click into the box to select all of it, or use the button above. Paste it back into the
              assistant chat to have the plan&apos;s §2 measurement table updated.
            </Text>
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
