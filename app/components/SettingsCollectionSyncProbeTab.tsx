/**
 * Collection-Sync Probe — Settings tab.
 *
 * One-shot UI over /api/collection-sync-probe. It answers ONE question, the
 * one that cannot be answered from a log the merchant does not read: why does
 * a collection sync leave `Collection.attributesSyncedAt` NULL, which is what
 * makes the product editor's collection picker say "unknown whether this
 * collection picks its members by rule — sync the Collections tab" and keep
 * saying it after a sync.
 *
 * The route reproduces the sync's own query (same builder, same pin, same
 * client) and BISECTS it when it fails, so the report names the field rather
 * than the symptom. The report is paste-ready on purpose: the answer usually
 * has to travel from the shop to whoever is fixing it.
 */

import { useState, useCallback, useMemo } from "react";
import { Card, Text, BlockStack, Button, Banner, InlineStack, Checkbox } from "@shopify/polaris";

interface CallOutcome {
  ok: boolean;
  errors: string[];
  codes: string[];
  gotCollection: boolean;
  keys?: string[];
  transportError?: string;
}

interface SyncProbeReport {
  shop: string;
  ranAt: string;
  apiVersion: string;
  envApiVersion: string | null;
  rulesModel: "sources" | "ruleSet";
  db: { total: number; withAttributes: number; newestSync: string | null };
  samples: Array<{
    id: string;
    title: string;
    attributesSyncedAtBefore: string | null;
    syncQuery: CallOutcome;
    blockComplete: boolean;
    wouldStampAttributes: boolean;
    ladder: Array<{ level: string; what: string; outcome: CallOutcome }>;
  }>;
  projection: {
    checked: number;
    ruleBased: number;
    truncated: boolean;
    disagreements: Array<{ id: string; title: string; hasSources: boolean; hasRuleSet: boolean }>;
    shapes: Array<{
      title: string;
      types: string[];
      inclusionConditions: number;
      exclusionConditions: number;
      hasSelections: boolean;
      shareable: boolean;
    }>;
    error?: string;
    skipped?: string;
  };
  realSync: { ran: boolean; collectionId?: string; error?: string; attributesSyncedAtAfter?: string | null };
  verdicts: string[];
}

function formatMarkdown(r: SyncProbeReport): string {
  const lines: string[] = [];
  const outcome = (o: CallOutcome) =>
    o.transportError
      ? `no answer (${o.transportError})`
      : o.ok
        ? `ok${o.gotCollection ? "" : ", but no collection came back"}`
        : `FAILED: ${o.errors.join(" | ") || "(no message)"}${o.codes.length ? ` [${o.codes.join(",")}]` : ""}`;

  lines.push(`# Collection-Sync Probe — ${r.shop}`);
  lines.push("");
  lines.push(`- Run: ${r.ranAt}`);
  lines.push(`- Sync talks to: **${r.apiVersion}** (SHOPIFY_API_VERSION=${r.envApiVersion ?? "unset"})`);
  lines.push(`- Rule model asked for: **${r.rulesModel}**`);
  lines.push(`- Cache: **${r.db.withAttributes}/${r.db.total}** collections carry attributesSyncedAt`);
  lines.push(`- Newest lastSyncedAt: ${r.db.newestSync ?? "(never)"}`);
  lines.push("");
  lines.push("## Verdicts");
  for (const v of r.verdicts) lines.push(`- ${v}`);
  lines.push("");
  lines.push("## Samples");
  for (const s of r.samples) {
    lines.push(`### ${s.title} (${s.id})`);
    lines.push(`- attributesSyncedAt before: ${s.attributesSyncedAtBefore ?? "NULL"}`);
    lines.push(`- sync query: ${outcome(s.syncQuery)}`);
    if (s.syncQuery.keys) lines.push(`- delivered keys: ${s.syncQuery.keys.join(", ")}`);
    lines.push(`- attribute block complete: ${s.blockComplete} / would stamp: ${s.wouldStampAttributes}`);
    if (s.ladder.length > 0) {
      lines.push("- bisect:");
      for (const rung of s.ladder) lines.push(`  - ${rung.level} ${rung.what} → ${outcome(rung.outcome)}`);
    }
    lines.push("");
  }
  lines.push("## sources vs ruleSet (what the PRODUCT sync reads)");
  if (r.projection.skipped) {
    lines.push(`- skipped: ${r.projection.skipped}`);
  } else if (r.projection.error) {
    lines.push(`- could not be checked: ${r.projection.error}`);
  } else {
    lines.push(
      `- checked ${r.projection.checked} collections${r.projection.truncated ? " (the window ended before the shop did — first 50 only)" : ""}, ${r.projection.ruleBased} of them rule-based`,
    );
    if (r.projection.checked === 0) {
      lines.push("- nothing was measured, which is not the same as agreement");
    } else if (r.projection.disagreements.length === 0) {
      lines.push("- every collection that carries conditions still projects into ruleSet");
    } else {
      for (const d of r.projection.disagreements) {
        lines.push(`- **${d.title}**: has conditions, ruleSet=${d.hasRuleSet} → the product sync stores this as MANUAL`);
      }
    }
    lines.push("");
    lines.push("### What is inside those sources (the isSmart question)");
    if (r.projection.shapes.length === 0) {
      lines.push("- no collection on this shop carries a source");
    } else {
      for (const shape of r.projection.shapes) {
        lines.push(
          `- **${shape.title}**: ${shape.types.join("/")}, conditions ${shape.inclusionConditions}+${shape.exclusionConditions}, selections ${shape.hasSelections ? "yes" : "no"}${shape.shareable ? ", shareable" : ""}`,
        );
      }
    }
  }
  lines.push("");

  if (r.realSync.ran) {
    lines.push("## Real syncCollection");
    lines.push(`- collection: ${r.realSync.collectionId}`);
    lines.push(`- threw: ${r.realSync.error ?? "no"}`);
    lines.push(`- attributesSyncedAt after: ${r.realSync.attributesSyncedAtAfter ?? "NULL"}`);
  }
  return lines.join("\n");
}

export function SettingsCollectionSyncProbeTab() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<SyncProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [realSync, setRealSync] = useState(true);

  const runProbe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      if (realSync) fd.set("realSync", "true");
      const r = await fetch("/api/collection-sync-probe", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { success: boolean; report?: SyncProbeReport; error?: string };
      if (!j.success || !j.report) throw new Error(j.error || "Probe failed");
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [realSync]);

  const markdown = useMemo(() => (report ? formatMarkdown(report) : ""), [report]);

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Collection-Sync Probe</Text>
          <Text as="p" tone="subdued">
            Why does a collection sync leave <code>attributesSyncedAt</code> NULL? That column is
            what the product editor&apos;s collection picker reads, and it is written by exactly one
            thing: a per-collection sync that got through. This runs the sync&apos;s OWN query — same
            builder, same API pin, same client — and, when it fails, asks the same collection for
            progressively more until it finds the field that breaks it.
          </Text>

          <Checkbox
            label="Also run the real syncCollection on the first sample"
            checked={realSync}
            onChange={setRealSync}
            helpText="The query above only covers the fetch. The sync also reads locales, markets and translations, and a throw in any of them fails the collection just as silently. This runs the real thing, catches it, and reads the row back."
          />

          <InlineStack gap="200">
            <Button variant="primary" onClick={runProbe} loading={loading}>Run collection-sync probe</Button>
            {report && (
              <Button onClick={() => void navigator.clipboard.writeText(markdown).catch(() => undefined)}>
                Copy markdown report
              </Button>
            )}
          </InlineStack>
        </BlockStack>
      </Card>

      {error && (
        <Banner tone="critical" title="Probe failed">
          <p>{error}</p>
        </Banner>
      )}

      {report && (
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">Verdicts</Text>
            <Text as="p" tone="subdued">
              {report.db.withAttributes}/{report.db.total} cached collections carry the attribute
              block. Every one that does not is a locked row in the picker.
            </Text>
            {report.verdicts.map((v, i) => (
              <Text as="p" key={i}>{v}</Text>
            ))}
          </BlockStack>
        </Card>
      )}

      {report && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">Paste-ready report</Text>
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
        </Card>
      )}
    </BlockStack>
  );
}
