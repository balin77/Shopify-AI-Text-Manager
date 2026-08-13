/**
 * Translation Coverage Probe — Settings tab (Phase 0 dev tool)
 *
 * One-shot UI that hits /api/translation-probe and renders a
 * paste-ready markdown report. Use this to populate
 * docs/architecture/TRANSLATION_COVERAGE.md §12 spike findings before
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

interface CookieHintHit {
  resourceType: string;
  resourceId: string;
  key: string;
  value: string | null;
  locale: string;
}

interface ThemeSelectionDiag {
  themes: Array<{ id: string; name: string; role: string }>;
  mainThemeId: string | null;
  storedSelectedThemeId: string | null;
  resolvedSelectedThemeId: string | null;
  dbThemeContentByThemeId: Array<{ themeId: string; count: number }>;
  dbThemeTranslationByThemeId: Array<{ themeId: string; count: number }>;
  resourceThemeIds: Array<{ resourceType: string; resourceId: string; extractedThemeId: string | null }>;
  verdict: string;
}

interface ThemeFetchWorkaround {
  targetTheme: { id: string; name: string; role: string } | null;
  translationsApiRewrite: { resourceId: string; contentCount: number; error?: string };
  translationsApiByIds: { contentCount: number; error?: string };
  themeFilesRead: Array<{ theme: "MAIN" | "target"; filename: string; found: boolean; byteSize: number; sampleKeys: string[]; error?: string }>;
  verdict: string;
}

interface ProbeReport {
  generatedAt: string;
  shop: string;
  primaryLocale: string;
  enabledLocales: string[];
  apiVersion: string;
  resources: ResourceReport[];
  cookieHints?: CookieHintHit[];
  writeTest: WriteTestReport;
  themeSelectionDiag?: ThemeSelectionDiag;
  themeFetchWorkaround?: ThemeFetchWorkaround;
  imageAltDiag?: ImageAltDiag;
}

/** Mirrors ImageAltDiag in api.translation-probe.tsx — "which images can carry
 * a translated alt text?", answered with data from this shop. */
interface ImageAltDiag {
  enumSupport: Array<{ resourceType: string; supported: boolean; sampleCount: number; error?: string }>;
  subjects: Array<{
    kind: string;
    resourceId: string;
    label: string;
    imageProbe?: { hasImage: boolean; imageId: string | null; altText: string | null; idSelectable: boolean };
    translatableKeys: string[];
    hasAltKey: boolean;
    error?: string;
  }>;
  verdict: string;
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

  const tsd = report.themeSelectionDiag;
  if (tsd) {
    lines.push(`## Theme-Selection 404 diagnostic`);
    lines.push(``);
    lines.push(`**Verdict:** ${tsd.verdict}`);
    lines.push(``);
    lines.push(`- Stored \`AISettings.selectedThemeId\`: ${tsd.storedSelectedThemeId === null ? "(null → MAIN fallback)" : `\`${tsd.storedSelectedThemeId}\``}`);
    lines.push(`- Resolved selection (read scope): ${tsd.resolvedSelectedThemeId === null ? "(null → no theme filter)" : `\`${tsd.resolvedSelectedThemeId}\``}`);
    lines.push(`- MAIN theme id: ${tsd.mainThemeId === null ? "(none)" : `\`${tsd.mainThemeId}\``}`);
    lines.push(``);
    lines.push(`Installed themes:`);
    if (tsd.themes.length === 0) {
      lines.push(`- (none returned by GET_THEMES)`);
    } else {
      for (const t of tsd.themes) lines.push(`  - \`${t.id}\` — ${t.name} [${t.role}]`);
    }
    lines.push(``);
    lines.push(`Stored \`ThemeContent.themeId\` (domain=theme):`);
    if (tsd.dbThemeContentByThemeId.length === 0) {
      lines.push(`- (no rows)`);
    } else {
      for (const x of tsd.dbThemeContentByThemeId) lines.push(`  - ${x.themeId === "" ? '"" (legacy/theme-agnostic)' : `\`${x.themeId}\``} — ${x.count} rows`);
    }
    lines.push(``);
    lines.push(`Stored \`ThemeTranslation.themeId\` (domain=theme):`);
    if (tsd.dbThemeTranslationByThemeId.length === 0) {
      lines.push(`- (no rows)`);
    } else {
      for (const x of tsd.dbThemeTranslationByThemeId) lines.push(`  - ${x.themeId === "" ? '"" (legacy/theme-agnostic)' : `\`${x.themeId}\``} — ${x.count} rows`);
    }
    lines.push(``);
    lines.push(`Theme-GID extracted from live resourceIds (what a sync would stamp):`);
    lines.push(``);
    lines.push(`| Resource type | resourceId (truncated) | extracted themeId |`);
    lines.push(`|---|---|---|`);
    for (const r of tsd.resourceThemeIds) {
      const rid = r.resourceId.length > 90 ? `${r.resourceId.slice(0, 87)}…` : r.resourceId;
      lines.push(`| \`${r.resourceType}\` | \`${rid.replace(/\|/g, "\\|")}\` | ${r.extractedThemeId === null ? "(none)" : `\`${r.extractedThemeId}\``} |`);
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  const iad = report.imageAltDiag;
  if (iad) {
    lines.push(`## Image alt-text translatability`);
    lines.push(``);
    lines.push(`**Verdict:** ${iad.verdict}`);
    lines.push(``);
    lines.push(`\`translatableResources(resourceType:)\` enum support:`);
    lines.push(``);
    lines.push(`| resourceType | accepted | sample rows | error |`);
    lines.push(`|---|---|---|---|`);
    for (const e of iad.enumSupport) {
      lines.push(
        `| \`${e.resourceType}\` | ${e.supported ? "yes" : "**no**"} | ${e.sampleCount} | ${(e.error ?? "").replace(/\|/g, "\\|") || "—"} |`,
      );
    }
    lines.push(``);
    lines.push(`Sample subjects:`);
    lines.push(``);
    lines.push(`| subject | GID | image? | primary alt | translatable keys | has \`alt\` |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const s of iad.subjects) {
      const gid = s.resourceId ? `\`${s.resourceId.length > 60 ? `${s.resourceId.slice(0, 57)}…` : s.resourceId}\`` : "(none)";
      const img = !s.imageProbe
        ? "—"
        : !s.imageProbe.idSelectable
          ? "**`image { id }` not selectable**"
          : s.imageProbe.hasImage
            ? `id ${s.imageProbe.imageId ? `\`${s.imageProbe.imageId}\`` : "**null**"}`
            : "no image";
      const keys = s.error ? `_${s.error.replace(/\|/g, "\\|")}_` : s.translatableKeys.join(", ") || "(none)";
      const alt = s.imageProbe
        ? s.imageProbe.altText
          ? `"${s.imageProbe.altText.slice(0, 40).replace(/\|/g, "\\|")}"`
          : "**(empty)**"
        : "—";
      lines.push(
        `| ${s.kind} — ${s.label.replace(/\|/g, "\\|")} | ${gid} | ${img} | ${alt} | ${keys} | ${s.hasAltKey ? "yes" : "no"} |`,
      );
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  const wa = report.themeFetchWorkaround;
  if (wa) {
    lines.push(`## Unpublished-theme fetch workaround test`);
    lines.push(``);
    lines.push(`**Verdict:** ${wa.verdict}`);
    lines.push(``);
    lines.push(`- Target theme (non-MAIN): ${wa.targetTheme ? `\`${wa.targetTheme.id}\` — ${wa.targetTheme.name} [${wa.targetTheme.role}]` : "(none)"}`);
    lines.push(``);
    lines.push(`**1) Translations API with rewritten \`theme_id\`:**`);
    lines.push(`- resourceId tried: \`${wa.translationsApiRewrite.resourceId || "(none)"}\``);
    lines.push(`- \`translatableResource\` → ${wa.translationsApiRewrite.contentCount} content entries${wa.translationsApiRewrite.error ? ` (error: ${wa.translationsApiRewrite.error})` : ""}`);
    lines.push(`- \`translatableResourcesByIds\` → ${wa.translationsApiByIds.contentCount} content entries${wa.translationsApiByIds.error ? ` (error: ${wa.translationsApiByIds.error})` : ""}`);
    lines.push(``);
    lines.push(`**2) Theme-files API (per Theme-GID):**`);
    if (wa.themeFilesRead.length === 0) {
      lines.push(`- (not run)`);
    } else {
      lines.push(``);
      lines.push(`| Theme | File | Found | Bytes | Sample top-level keys | Error |`);
      lines.push(`|---|---|---|---:|---|---|`);
      for (const f of wa.themeFilesRead) {
        lines.push(`| ${f.theme} | \`${f.filename}\` | ${f.found ? "✅" : "❌"} | ${f.byteSize} | ${f.sampleKeys.map((k) => `\`${k}\``).join(", ") || "—"} | ${f.error ? f.error.replace(/\|/g, "\\|") : "—"} |`);
      }
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

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

  lines.push(`## Cookie-banner hunt`);
  lines.push(``);
  const hints = report.cookieHints ?? [];
  if (hints.length === 0) {
    lines.push(`No keys matching cookie/consent_banner/cookie_banner/privacy_banner/consent_dialog/gdpr_compliance/shopify.consent found across the probed resource types. The cookie-banner content lives elsewhere — likely a non-public resource type, or it surfaces only under specific shop conditions (Customer Privacy region selection, banner customized via Language Editor, etc.).`);
  } else {
    lines.push(`Found ${hints.length} candidate entries:`);
    lines.push(``);
    lines.push(`| Resource | Key | Value (truncated) |`);
    lines.push(`|---|---|---|`);
    for (const h of hints) {
      const v = h.value === null ? "(null)" : `"${h.value.replace(/\n/g, " ⏎ ").replace(/\|/g, "\\|")}"`;
      lines.push(`| \`${h.resourceType}\` | \`${h.key}\` | ${v} |`);
    }
  }
  lines.push(``);

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
  lines.push(`_Paste this report back into the assistant to populate \`docs/architecture/TRANSLATION_COVERAGE.md\` §12 spike findings._`);

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

      {report?.imageAltDiag && (
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">Image alt-text translatability</Text>
            <Banner tone="info">
              <Text as="p">{report.imageAltDiag.verdict}</Text>
            </Banner>
            <Text as="p" tone="subdued">
              Details (enum support per resource type, sample GIDs and their translatable keys) are in
              the markdown report below.
            </Text>
          </BlockStack>
        </Card>
      )}

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
