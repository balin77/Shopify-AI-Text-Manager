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
  fileLink?: Array<{
    kind: string;
    ownerLabel: string;
    sourceImageId: string;
    sourceUrl: string;
    sourceBasename: string;
    arithmetic: { triedId: string; resolved: boolean; typename: string; url: string; urlMatch: boolean; error?: string };
    byFilename: {
      query: string;
      hits: Array<{ id: string; typename: string; url: string; alt: string | null }>;
      exactMatches: number;
      error?: string;
    };
  }>;
  ownerLinkage?: {
    cachedImages: number;
    groups: Array<{
      kind: string;
      sampled: number;
      withImage: number;
      unique: number;
      ambiguous: number;
      none: number;
      altDiverges: number;
      examples: Array<{ title: string; basename: string; matches: number; objectAlt: string; fileAlt: string | null }>;
    }>;
    verdict: string;
  };
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

    if (iad.fileLink?.length) {
      lines.push(`### Can a CollectionImage/ArticleImage be traced to a MediaImage?`);
      lines.push(``);
      lines.push(
        `A MediaImage IS translatable and the bulk editor already writes it, so a link would mean those alt texts need no new write path.`,
      );
      lines.push(``);
      lines.push(`| subject | source image GID | filename | A) same id → MediaImage | B) found in Files |`);
      lines.push(`|---|---|---|---|---|`);
      for (const l of iad.fileLink) {
        const esc = (v: string) => v.replace(/\|/g, "\\|");
        const arith = l.arithmetic.error
          ? `_${esc(l.arithmetic.error)}_`
          : l.arithmetic.urlMatch
            ? `**same picture** (\`${esc(l.arithmetic.typename)}\`)`
            : l.arithmetic.resolved
              ? `resolves to \`${esc(l.arithmetic.typename)}\` but a **different** picture`
              : "does not resolve";
        const files = l.byFilename.error
          ? `_${esc(l.byFilename.error)}_`
          : `${l.byFilename.exactMatches} exact / ${l.byFilename.hits.length} hit(s)`;
        lines.push(
          `| ${esc(l.kind)} — ${esc(l.ownerLabel)} | ${l.sourceImageId ? `\`${esc(l.sourceImageId)}\`` : "(none)"} | ${esc(l.sourceBasename) || "—"} | ${arith} | ${files} |`,
        );
      }
      lines.push(``);
      for (const l of iad.fileLink) {
        if (!l.sourceUrl) continue;
        lines.push(`- \`${l.kind}\` source URL: ${l.sourceUrl}`);
        if (l.arithmetic.triedId) lines.push(`  - tried: \`${l.arithmetic.triedId}\` → ${l.arithmetic.url || "(no url)"}`);
        if (l.byFilename.query) lines.push(`  - files query: \`${l.byFilename.query}\``);
        for (const hit of l.byFilename.hits) {
          lines.push(`    - \`${hit.id}\` [${hit.typename}] alt=${hit.alt === null ? "(null)" : `"${hit.alt}"`} — ${hit.url || "(no url)"}`);
        }
      }
      lines.push(``);
    }

    const ol = iad.ownerLinkage;
    if (ol) {
      lines.push(`### Could collection/article images be ATTRIBUTED in the media library?`);
      lines.push(``);
      lines.push(`**Verdict:** ${ol.verdict}`);
      lines.push(``);
      lines.push(
        `The only possible link is the filename (a collection's picture is a CollectionImage, not a MediaImage, and \`files()\` has no "used by" facet). Matched from the owner side against the local media cache — what an implementation would do without extra Shopify calls.`,
      );
      lines.push(``);
      lines.push(`| sample | with image | exactly 1 match | ambiguous | not in library | of the unique: alt differs |`);
      lines.push(`|---|---:|---:|---:|---:|---:|`);
      for (const g of ol.groups) {
        lines.push(
          `| ${g.kind} (${g.sampled} sampled) | ${g.withImage} | ${g.unique} | ${g.ambiguous} | ${g.none} | ${g.altDiverges} |`,
        );
      }
      lines.push(``);
      for (const g of ol.groups) {
        if (g.examples.length === 0) continue;
        lines.push(`\`${g.kind}\` examples:`);
        for (const e of g.examples) {
          const esc = (v: string) => v.replace(/\|/g, "\\|");
          lines.push(
            `  - ${esc(e.title)} — \`${esc(e.basename)}\` → ${e.matches} match(es); object alt=${
              e.objectAlt ? `"${esc(e.objectAlt.slice(0, 40))}"` : "**(empty)**"
            }, file alt=${e.fileAlt === null ? "—" : e.fileAlt ? `"${esc(e.fileAlt.slice(0, 40))}"` : "**(empty)**"}`,
          );
        }
        lines.push(``);
      }
    }

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

// ── IndexNow probe ───────────────────────────────────────────────────────────
// Separate diagnostic sharing this tab (see api.indexnow-probe.tsx): it is the
// only way to find out whether IndexNow accepts a key file served from the app
// proxy instead of the storefront root, and whether the key fetch stays on the
// declared host. Both are unanswerable from the code alone.

interface IndexNowProbeReport {
  generatedAt: string;
  shop: string;
  configured: boolean;
  enabled: boolean;
  host: string;
  primaryDomain: string;
  hostIsPrimaryDomain: boolean;
  keyLocation: string;
  keyPath: string;
  keyRedirectPresent: boolean;
  keyFile: {
    reachable: boolean;
    finalStatus: number | null;
    hops: Array<{ url: string; status: number; location: string | null; crossHost: boolean }>;
    bodyMatchesKey: boolean | null;
    body: string | null;
    error?: string;
  };
  submitTest: {
    url: string;
    status: number | null;
    kind: string;
    responseBody: string | null;
    error?: string;
  };
  verdict: string[];
}

function formatIndexNowMarkdown(r: IndexNowProbeReport): string {
  const lines: string[] = [];
  lines.push(`# IndexNow Probe Report`);
  lines.push(``);
  lines.push(`- Generated: ${r.generatedAt}`);
  lines.push(`- Shop: ${r.shop}`);
  lines.push(`- Configured: ${r.configured ? "yes" : "no"} / enabled: ${r.enabled ? "yes" : "no"}`);
  lines.push(`- Declared host: \`${r.host || "(none)"}\``);
  lines.push(`- Primary domain: \`${r.primaryDomain}\` ${r.hostIsPrimaryDomain ? "(match)" : "(MISMATCH)"}`);
  lines.push(`- keyLocation: \`${r.keyLocation || "(none)"}\` (path \`${r.keyPath || "(none)"}\`)`);
  lines.push(`- Key-file redirect on record: ${r.keyRedirectPresent ? "yes" : "no"}`);
  lines.push(``);
  lines.push(`## Key file fetch`);
  lines.push(``);
  lines.push(`- Reachable: ${r.keyFile.reachable ? "yes" : "no"} (final status ${r.keyFile.finalStatus ?? "none"})`);
  lines.push(`- Content matches key: ${r.keyFile.bodyMatchesKey === null ? "n/a" : r.keyFile.bodyMatchesKey ? "yes" : "NO"}`);
  if (r.keyFile.error) lines.push(`- Error: ${r.keyFile.error}`);
  if (r.keyFile.hops.length > 0) {
    lines.push(``);
    lines.push(`| # | URL | Status | Location | Cross-host |`);
    lines.push(`|---|---|---|---|---|`);
    r.keyFile.hops.forEach((h, i) => {
      lines.push(`| ${i + 1} | \`${h.url}\` | ${h.status} | ${h.location ? `\`${h.location}\`` : "—"} | ${h.crossHost ? "YES" : "no"} |`);
    });
  }
  lines.push(``);
  lines.push(`## Live submission test`);
  lines.push(``);
  lines.push(`- URL: \`${r.submitTest.url || "(none)"}\``);
  lines.push(`- Status: ${r.submitTest.status ?? "none"} (${r.submitTest.kind})`);
  if (r.submitTest.responseBody) lines.push(`- Response body: \`${r.submitTest.responseBody}\``);
  if (r.submitTest.error) lines.push(`- Error: ${r.submitTest.error}`);
  lines.push(``);
  lines.push(`## Verdict`);
  lines.push(``);
  for (const v of r.verdict) lines.push(`- ${v}`);
  return lines.join("\n");
}

// ── Redirect × locale-prefix probe ───────────────────────────────────────────
// PLAN_CONTENT_CREATION §Phase 3.3, open question 3: does a path-based Shopify
// redirect also apply under a locale prefix (`/es/products/old`)? Unanswerable
// from the docs or the code, and the answer decides whether bulk-translate's
// foreign-handle column may create redirects at all — which is why that path
// creates none today.

interface RedirectLocaleHop {
  url: string;
  status: number | null;
  location: string | null;
  error?: string;
}

interface RedirectLocaleProbeReport {
  generatedAt: string;
  shop: string;
  primaryDomain: string;
  locale: string | null;
  probePath: string;
  /** Where the throwaway redirect points — the Location is read against it. */
  target: string;
  redirectCreated: boolean;
  control: RedirectLocaleHop;
  prefixed: RedirectLocaleHop | null;
  verdict: string[];
}

function RedirectLocaleProbeCard() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<RedirectLocaleProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runProbe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/redirect-locale-probe", { method: "POST" });
      const j = (await r.json()) as { report?: RedirectLocaleProbeReport; error?: string };
      if (!r.ok || !j.report) {
        throw new Error(j.error === "gated" ? "Requires the Pro plan" : j.error || `HTTP ${r.status}`);
      }
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const hopRow = (label: string, hop: RedirectLocaleHop | null) =>
    hop ? (
      <Text as="p" variant="bodySm">
        <strong>{label}:</strong> <code>{hop.url}</code> → {hop.status ?? "no response"}
        {hop.location ? ` → ${hop.location}` : ""}
        {hop.error ? ` (${hop.error})` : ""}
      </Text>
    ) : null;

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">Redirect under a locale prefix</Text>
        <Text as="p" tone="subdued">
          Creates a throwaway redirect, fetches it once plain and once behind a published
          language prefix, then deletes it again. Answers TWO things: whether a translated
          handle can be redirected at all, and whether the target keeps the prefix — the
          second decides whether one row covers every locale. Nothing is left behind.
        </Text>
        <InlineStack gap="200" blockAlign="center">
          <Button onClick={runProbe} loading={loading}>Run redirect probe</Button>
        </InlineStack>
        {error && (
          <Banner tone="critical"><Text as="p">Probe failed: {error}</Text></Banner>
        )}
        {report && (
          <BlockStack gap="200">
            <Banner tone={report.verdict.some((v) => v.startsWith("ANSWER: YES")) ? "success" : "info"}>
              <BlockStack gap="100">
                {report.verdict.map((v, i) => <Text as="p" key={i}>{v}</Text>)}
              </BlockStack>
            </Banner>
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>Redirect under test:</strong> <code>{report.probePath}</code> → <code>{report.target}</code>
            </Text>
            {hopRow("Control", report.control)}
            {hopRow(`Prefixed (${report.locale ?? "no second language"})`, report.prefixed)}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

// ── Menu translation probe ────────────────────────────────────────────────
// Answers the one question /app/menus has been asserting an answer to since it
// was written: menu SUB-items ("Stifthalter" under "Produkte") do not take a
// translation while their parent does. Shapes mirror
// api.menu-translation-probe.tsx — re-declared rather than imported, because
// importing from a route module drags its server code into the client bundle
// (same reason the other probe reports are duplicated here).

interface MenuProbeStructure {
  menuId: string;
  title: string;
  handle: string;
  itemsByDepth: number[];
}

interface MenuProbeNested {
  menuId: string;
  menuTitle: string;
  error?: string;
  menuKeys: string[];
  linkCount: number;
  hasNextPage: boolean;
  matchedByDepth: number[];
  ambiguousByDepth: number[];
  unmatchedLinks: number;
}

interface MenuProbeSweep {
  error?: string;
  total: number;
  pages: number;
  truncated: boolean;
  lookupByDepth: Array<{ depth: number; items: number; unique: number; ambiguous: number; absent: number }>;
  deepHits: Array<{ title: string; depth: number; menuItemId: string; linkId: string }>;
}

interface MenuProbeDerivation {
  checked: number;
  aligned: number;
  sample?: { menuItemId: string; linkId: string };
  probes: Array<{
    menuItemId: string;
    title: string;
    depth: number;
    derivedLinkId: string;
    resolved: boolean;
    keys: string[];
    valueMatchesTitle: boolean;
    error?: string;
  }>;
}

interface MenuProbeVersion {
  apiVersion: string;
  fatalError?: string;
  structures: MenuProbeStructure[];
  nested: MenuProbeNested[];
  sweep: MenuProbeSweep;
  derivation: MenuProbeDerivation;
}

interface MenuProbeWrite {
  attempted: boolean;
  skipReason?: string;
  apiVersion?: string;
  locale?: string;
  linkId?: string;
  title?: string;
  depth?: number;
  attemptedValue?: string;
  registerEcho?: string | null;
  readBack?: string | null;
  result?: "confirmed" | "silent-noop" | "failure";
  removed?: boolean;
  errors?: string[];
}

interface MenuProbeExistingScan {
  apiVersion: string;
  locale: string;
  samples: Array<{ linkId: string; title: string; depth: number; existing: string | null; error?: string }>;
}

interface MenuTranslationProbeReport {
  generatedAt: string;
  shop: string;
  pinnedApiVersion: string;
  primaryLocale: string | null;
  writeLocale: string | null;
  versions: MenuProbeVersion[];
  existingTranslations?: MenuProbeExistingScan;
  writeProbe: MenuProbeWrite;
  verdict: string[];
}

function formatMenuProbeMarkdown(r: MenuTranslationProbeReport): string {
  const lines: string[] = [];
  lines.push(`# Menu Translation Probe — ${r.shop}`);
  lines.push("");
  lines.push(`- Generated: ${r.generatedAt}`);
  lines.push(`- Pinned API version: \`${r.pinnedApiVersion}\``);
  lines.push(`- Primary locale: \`${r.primaryLocale ?? "unknown"}\``);
  lines.push(`- Write locale: \`${r.writeLocale ?? "none published"}\``);
  lines.push("");
  lines.push("## Verdict");
  for (const v of r.verdict) lines.push(`- ${v}`);

  for (const version of r.versions) {
    lines.push("");
    lines.push(`## API ${version.apiVersion}`);
    if (version.fatalError) {
      lines.push(`Not measured: ${version.fatalError}`);
      continue;
    }

    lines.push("");
    lines.push("### A. Menu structure");
    lines.push("| Menu | Handle | Items per depth (1 → n) |");
    lines.push("|---|---|---|");
    for (const s of version.structures) {
      lines.push(`| ${s.title} | \`${s.handle}\` | ${s.itemsByDepth.map((c, i) => `d${i + 1}=${c ?? 0}`).join(", ") || "(none)"} |`);
    }

    lines.push("");
    lines.push("### B. nestedTranslatableResources(LINK) per menu");
    lines.push("| Menu | Menu keys | Links returned | More pages | Matched per depth | Ambiguous | Unmatched links |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const n of version.nested) {
      if (n.error) {
        lines.push(`| ${n.menuTitle} | — | — | — | ERROR: ${n.error} | — | — |`);
        continue;
      }
      lines.push(
        `| ${n.menuTitle} | ${n.menuKeys.join(", ") || "(none)"} | ${n.linkCount} | ${n.hasNextPage ? "⚠️ yes" : "no"} | ` +
          `${n.matchedByDepth.map((c, i) => `d${i + 1}=${c ?? 0}`).join(", ") || "(none)"} | ` +
          `${n.ambiguousByDepth.map((c, i) => `d${i + 1}=${c ?? 0}`).join(", ") || "(none)"} | ${n.unmatchedLinks} |`,
      );
    }

    lines.push("");
    lines.push("### C. Flat translatableResources(LINK) sweep");
    if (version.sweep.error) {
      lines.push(`ERROR: ${version.sweep.error}`);
    } else {
      lines.push(`${version.sweep.total} Link resources over ${version.sweep.pages} page(s)${version.sweep.truncated ? " — ⚠️ page cap hit, absences below are unproven" : ""}.`);
      lines.push("");
      lines.push("| Depth | Menu items | Unique match | Ambiguous title | Absent |");
      lines.push("|---|---|---|---|---|");
      for (const l of version.sweep.lookupByDepth) {
        lines.push(`| ${l.depth} | ${l.items} | ${l.unique} | ${l.ambiguous} | ${l.absent} |`);
      }
      if (version.sweep.deepHits.length) {
        lines.push("");
        lines.push("Sub-level items found as Link resources:");
        for (const h of version.sweep.deepHits) {
          lines.push(`- d${h.depth} "${h.title}" — MenuItem \`${h.menuItemId}\` → Link \`${h.linkId}\``);
        }
      }
    }

    lines.push("");
    lines.push("### D. Is a Link GID derivable from a MenuItem GID?");
    lines.push(`Top-level pairs with equal numeric ids: ${version.derivation.aligned}/${version.derivation.checked}.`);
    if (version.derivation.sample) {
      lines.push(`Sample: \`${version.derivation.sample.menuItemId}\` ↔ \`${version.derivation.sample.linkId}\``);
    }
    lines.push("");
    lines.push("| Depth | Title | Derived Link GID | Resolved | Keys | Title matches |");
    lines.push("|---|---|---|---|---|---|");
    for (const p of version.derivation.probes) {
      lines.push(
        `| ${p.depth} | ${p.title} | \`${p.derivedLinkId || "—"}\` | ${p.resolved ? "✅" : `❌${p.error ? ` (${p.error})` : ""}`} | ` +
          `${p.keys.join(", ") || "—"} | ${p.valueMatchesTitle ? "✅" : "—"} |`,
      );
    }
  }

  lines.push("");
  lines.push("## F. Existing translations on sub-level Links");
  if (!r.existingTranslations) {
    lines.push("Not scanned (no write locale, or no sub-level Link resource found).");
  } else {
    lines.push(`Read on API ${r.existingTranslations.apiVersion}, locale \`${r.existingTranslations.locale}\`.`);
    lines.push("");
    lines.push("| Depth | Title | Link GID | Existing translation |");
    lines.push("|---|---|---|---|");
    for (const s of r.existingTranslations.samples) {
      const cell = s.error ? `ERROR: ${s.error}` : s.existing === null ? "— (empty slot)" : `"${s.existing}"`;
      lines.push(`| ${s.depth} | ${s.title} | \`${s.linkId}\` | ${cell} |`);
    }
  }

  lines.push("");
  lines.push("## E. Write probe");
  if (!r.writeProbe.attempted) {
    lines.push(r.writeProbe.skipReason ? `Not attempted: ${r.writeProbe.skipReason}` : "Not attempted.");
  } else {
    lines.push(`- Target: d${r.writeProbe.depth} "${r.writeProbe.title}" (\`${r.writeProbe.linkId}\`) on API ${r.writeProbe.apiVersion}`);
    lines.push(`- Locale: \`${r.writeProbe.locale}\``);
    lines.push(`- Value written: "${r.writeProbe.attemptedValue}"`);
    lines.push(`- Mutation echo: ${r.writeProbe.registerEcho === null ? "(nothing echoed)" : `"${r.writeProbe.registerEcho}"`}`);
    lines.push(`- Fresh read-back: ${r.writeProbe.readBack === null ? "(nothing stored)" : `"${r.writeProbe.readBack}"`}`);
    lines.push(`- Result: ${r.writeProbe.result}`);
    lines.push(`- Probe value removed again: ${r.writeProbe.removed ? "yes" : "⚠️ NO — remove it manually"}`);
    if (r.writeProbe.errors?.length) {
      lines.push("- Errors:");
      for (const e of r.writeProbe.errors) lines.push(`  - ${e}`);
    }
  }

  return lines.join("\n");
}

function MenuTranslationProbeCard() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<MenuTranslationProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeWriteTest, setIncludeWriteTest] = useState(false);

  const runProbe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      if (includeWriteTest) fd.set("writeTest", "true");
      const r = await fetch("/api/menu-translation-probe", { method: "POST", body: fd });
      const j = (await r.json()) as { report?: MenuTranslationProbeReport; error?: string };
      if (!r.ok || !j.report) {
        throw new Error(j.error === "gated" ? "Requires the Pro plan" : j.error || `HTTP ${r.status}`);
      }
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [includeWriteTest]);

  const markdown = useMemo(() => (report ? formatMenuProbeMarkdown(report) : ""), [report]);

  const tone = (() => {
    if (!report) return "info" as const;
    if (report.verdict.some((v) => v.includes("ANSWER: NO") || v.includes("silent no-op"))) return "warning" as const;
    if (report.verdict.some((v) => v.includes("ARE translatable"))) return "success" as const;
    return "info" as const;
  })();

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">Menu sub-item translations</Text>
        <Text as="p" tone="subdued">
          Separates the two explanations for the long-standing symptom that a top-level menu item
          translates while its children do not: either Shopify never hands out the child links
          (<code>nestedTranslatableResources</code> covers one level of nesting), or the child links
          have no translatable resource at all. Reads the menu tree, both enumeration paths, and
          tries a <code>gid://shopify/Link/…</code> derived from a child&apos;s MenuItem id. Runs the
          whole measurement against the pinned API version <em>and</em> 2026-07, so &quot;does the new
          version change this&quot; is answered rather than argued.
        </Text>
        <Banner tone="info">
          <Text as="p">
            Read-only unless the write test is ticked. That step registers one uniquely tagged
            translation on a single sub-item, re-reads it (an accepted mutation is not proof) and
            removes it again. It refuses any item that already has a translation, so nothing of
            yours can be overwritten.
          </Text>
        </Banner>
        <Checkbox
          label="Also run the write test (one tagged translation on one sub-item, removed again)"
          checked={includeWriteTest}
          onChange={(checked) => setIncludeWriteTest(checked)}
        />
        <InlineStack gap="200">
          <Button onClick={runProbe} loading={loading}>{report ? "Re-run menu probe" : "Run menu probe"}</Button>
        </InlineStack>
        {error && <Banner tone="critical"><Text as="p">Probe failed: {error}</Text></Banner>}
        {report && (
          <BlockStack gap="200">
            <Banner tone={tone}>
              <BlockStack gap="100">
                {report.verdict.map((v, i) => <Text as="p" key={i}>{v}</Text>)}
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

// ── Menu WRITE probe ──────────────────────────────────────────────────────
// The other half of the menu question: translating an item is measured and
// shipped, EDITING its primary title is not — because menuUpdate takes the
// whole item tree and nobody here had measured what it does with it. Shapes
// mirror api.menu-write-probe.tsx, re-declared for the same reason as above
// (importing a route module drags its server code into the client bundle).

interface MenuWriteProbeItem {
  id: string;
  title: string;
  type: string | null;
  url: string | null;
  resourceId: string | null;
  tags: string[];
  depth: number;
  path: string;
}

interface MenuWriteSchemaField {
  name: string;
  type: string;
  required: boolean;
}

interface MenuWriteProbeReport {
  generatedAt: string;
  shop: string;
  apiVersion: string;
  schema: { error?: string; createInput: MenuWriteSchemaField[]; updateInput: MenuWriteSchemaField[]; itemTypes: string[] };
  setup: {
    handle: string;
    menuId: string | null;
    boundResource: { type: string; id: string; title: string } | null;
    created: boolean;
    errors: string[];
  };
  baseline: { items: MenuWriteProbeItem[]; resourceIdStoredOnCreate: boolean | null };
  rename: {
    attempted: boolean;
    targetItemId: string | null;
    targetPath: string | null;
    newTitle: string | null;
    echoedTitle: string | null;
    readBackTitle: string | null;
    idsStable: boolean | null;
    idChanges: Array<{ path: string; before: string; after: string }>;
    collateralTitleChanges: Array<{ path: string; before: string; after: string }>;
    resourceIdPreserved: boolean | null;
    itemCountBefore: number;
    itemCountAfter: number;
    errors: string[];
  };
  omission: {
    attempted: boolean;
    omittedItemId: string | null;
    omittedPath: string | null;
    stillPresentAfterwards: boolean | null;
    siblingsSurvived: boolean | null;
    errors: string[];
  };
  translation: {
    attempted: boolean;
    locale: string | null;
    linkId: string | null;
    linkResolved: boolean | null;
    registered: boolean | null;
    valueBeforeRename: string | null;
    valueAfterRename: string | null;
    outdatedAfterRename: boolean | null;
    digestChanged: boolean | null;
    errors: string[];
  };
  move: {
    attempted: boolean;
    movedItemId: string | null;
    idAfterMove: string | null;
    idKept: boolean | null;
    childIdKept: boolean | null;
    depthBefore: number | null;
    depthAfter: number | null;
    siblingIdsKept: boolean | null;
    translationAfterMove: string | null;
    translationOutdated: boolean | null;
    errors: string[];
  };
  create: {
    attempted: boolean;
    sentAtPosition: number | null;
    createdId: string | null;
    positionHeld: boolean | null;
    existingIdsKept: boolean | null;
    linkResolved: boolean | null;
    errors: string[];
  };
  depth: {
    attempted: boolean;
    results: Array<{ depth: number; accepted: boolean; observedDepth: number | null; error?: string }>;
    maxAccepted: number | null;
    readableDepth: number;
  };
  deleteTranslation: {
    attempted: boolean;
    linkId: string | null;
    valueBeforeDelete: string | null;
    resourceStillResolves: boolean | null;
    valueAfterDelete: string | null;
    errors: string[];
  };
  translationDurability: {
    attempted: boolean;
    menuId: string | null;
    locale: string | null;
    links: Array<{ role: string; linkId: string }>;
    observations: Array<{ stage: string; role: string; value: string | null; outdated: boolean | null }>;
    reRegisterAfterMove: { attempted: boolean; digestFound: boolean | null; restored: boolean | null };
    errors: string[];
  };
  marketScoped: {
    attempted: boolean;
    reason?: string;
    marketId: string | null;
    marketName: string | null;
    locale: string | null;
    storedAtAll: boolean | null;
    globalReadShowsIt: boolean | null;
    survivesMove: boolean | null;
    restorable: boolean | null;
    errors: string[];
  };
  resourceBound: {
    attempted: boolean;
    menuId: string | null;
    samples: Record<string, string | null>;
    createErrors: string[];
    readBack: Record<string, string | null>;
    bound: Record<string, boolean | null>;
    retarget: {
      attempted: boolean;
      itemId: string | null;
      fromType: string | null;
      resourceIdCleared: boolean | null;
      urlStored: boolean | null;
      reboundOk: boolean | null;
      urlClearedOnRebind: boolean | null;
      errors: string[];
    };
    errors: string[];
  };
  typeRoundTrip: {
    attempted: boolean;
    menuId: string | null;
    typesTried: string[];
    createErrors: string[];
    read: Array<{ type: string | null; title: string; url: string | null; resourceId: string | null }>;
    asReadOk: boolean | null;
    asReadErrors: string[];
    withoutUrlOk: boolean | null;
    withoutUrlErrors: string[];
  };
  cleanup: { menus: Array<{ handle: string; id: string; deleted: boolean; error?: string }>; allDeleted: boolean };
  verdict: string[];
}

function formatMenuWriteProbeMarkdown(r: MenuWriteProbeReport): string {
  const lines: string[] = [];
  const yesNo = (v: boolean | null) => (v === null ? "not measured" : v ? "yes" : "no");

  lines.push(`# Menu write probe — ${r.shop}`);
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push(`API version: ${r.apiVersion}`);
  lines.push(
    `Throwaway menus: ${r.cleanup.menus.length} created, ${r.cleanup.allDeleted ? "all deleted again" : "NOT all deleted"}`,
  );
  for (const m of r.cleanup.menus) {
    lines.push(`  - ${m.handle}: ${m.deleted ? "deleted" : `NOT DELETED (${m.error ?? "?"})`}`);
  }
  lines.push("");

  lines.push("## Verdict");
  for (const v of r.verdict) lines.push(`- ${v}`);
  lines.push("");

  lines.push("## Schema (introspected from the shop)");
  if (r.schema.error) lines.push(`- Introspection error: ${r.schema.error}`);
  const printFields = (label: string, fields: MenuWriteSchemaField[]) => {
    lines.push(`- ${label}: ${fields.length === 0 ? "(none returned)" : ""}`);
    for (const f of fields) lines.push(`  - ${f.name}: ${f.type}${f.required ? "!" : ""}`);
  };
  printFields("MenuItemCreateInput", r.schema.createInput);
  printFields("MenuItemUpdateInput", r.schema.updateInput);
  lines.push(`- MenuItemType values: ${r.schema.itemTypes.join(", ") || "(none returned)"}`);
  lines.push("");

  lines.push("## Baseline tree");
  for (const item of r.baseline.items) {
    lines.push(`- ${item.path} (d${item.depth}) "${item.title}" type=${item.type ?? "-"} resourceId=${item.resourceId ?? "-"} id=${item.id}`);
  }
  lines.push(`- resourceId stored on create: ${yesNo(r.baseline.resourceIdStoredOnCreate)}`);
  lines.push("");

  lines.push("## Rename");
  lines.push(`- Attempted: ${r.rename.attempted ? "yes" : "no"}`);
  lines.push(`- Target: ${r.rename.targetPath ?? "-"} (${r.rename.targetItemId ?? "-"})`);
  lines.push(`- New title: ${r.rename.newTitle ?? "-"}`);
  lines.push(`- Mutation echo: ${r.rename.echoedTitle ?? "(nothing)"}`);
  lines.push(`- Fresh read-back: ${r.rename.readBackTitle ?? "(nothing)"}`);
  lines.push(`- Item ids stable: ${yesNo(r.rename.idsStable)}`);
  for (const c of r.rename.idChanges) lines.push(`  - ${c.path}: ${c.before} -> ${c.after}`);
  lines.push(`- Collateral title changes: ${r.rename.collateralTitleChanges.length}`);
  for (const c of r.rename.collateralTitleChanges) lines.push(`  - ${c.path}: "${c.before}" -> "${c.after}"`);
  lines.push(`- Item count: ${r.rename.itemCountBefore} -> ${r.rename.itemCountAfter}`);
  lines.push(`- resourceId preserved: ${yesNo(r.rename.resourceIdPreserved)}`);
  for (const e of r.rename.errors) lines.push(`  - error: ${e}`);
  lines.push("");

  lines.push("## Omission (is an unmentioned item deleted?)");
  lines.push(`- Attempted: ${r.omission.attempted ? "yes" : "no"}`);
  lines.push(`- Omitted: ${r.omission.omittedPath ?? "-"} (${r.omission.omittedItemId ?? "-"})`);
  lines.push(`- Still present afterwards: ${yesNo(r.omission.stillPresentAfterwards)}`);
  lines.push(`- Siblings survived: ${yesNo(r.omission.siblingsSurvived)}`);
  for (const e of r.omission.errors) lines.push(`  - error: ${e}`);
  lines.push("");

  lines.push("## Translation across a rename");
  lines.push(`- Attempted: ${r.translation.attempted ? "yes" : "no"} (locale ${r.translation.locale ?? "-"})`);
  lines.push(`- Link GID: ${r.translation.linkId ?? "-"} (resolved: ${yesNo(r.translation.linkResolved)})`);
  lines.push(`- Registered before rename: ${yesNo(r.translation.registered)} -> "${r.translation.valueBeforeRename ?? ""}"`);
  lines.push(`- Value after rename: ${r.translation.valueAfterRename === null ? "(gone)" : `"${r.translation.valueAfterRename}"`}`);
  lines.push(`- Flagged outdated: ${yesNo(r.translation.outdatedAfterRename)}`);
  lines.push(`- Digest changed: ${yesNo(r.translation.digestChanged)}`);
  for (const e of r.translation.errors) lines.push(`  - error: ${e}`);
  lines.push("");

  lines.push("## Move (does an item keep its id when re-parented?)");
  lines.push(`- Attempted: ${r.move.attempted ? "yes" : "no"}`);
  lines.push(`- Moved: ${r.move.movedItemId ?? "-"} (depth ${r.move.depthBefore ?? "?"} -> ${r.move.depthAfter ?? "?"})`);
  lines.push(`- Id after the move: ${r.move.idAfterMove ?? "(not found)"}`);
  lines.push(`- Id kept: ${yesNo(r.move.idKept)}`);
  lines.push(`- Child id kept: ${yesNo(r.move.childIdKept)}`);
  lines.push(`- Untouched siblings kept their ids: ${yesNo(r.move.siblingIdsKept)}`);
  lines.push(
    `- Translation after the move: ${r.move.translationAfterMove === null ? "(gone)" : `"${r.move.translationAfterMove}"`} (outdated: ${yesNo(r.move.translationOutdated)})`,
  );
  for (const e of r.move.errors) lines.push(`  - error: ${e}`);
  lines.push("");

  lines.push("## Create (an item sent without an id)");
  lines.push(`- Attempted: ${r.create.attempted ? "yes" : "no"}, sent at position ${r.create.sentAtPosition ?? "-"}`);
  lines.push(`- Created id: ${r.create.createdId ?? "(none)"}`);
  lines.push(`- Came back at the sent position: ${yesNo(r.create.positionHeld)}`);
  lines.push(`- Existing ids kept: ${yesNo(r.create.existingIdsKept)}`);
  lines.push(`- New item's Link resource resolves: ${yesNo(r.create.linkResolved)}`);
  for (const e of r.create.errors) lines.push(`  - error: ${e}`);
  lines.push("");

  lines.push("## Depth accepted by Shopify");
  for (const d of r.depth.results) {
    lines.push(
      `- ${d.depth} levels: ${d.accepted ? "accepted" : `refused (${d.error ?? "?"})`}, read back as ${d.observedDepth ?? "-"}`,
    );
  }
  lines.push(`- Maximum accepted and confirmed by a read: ${r.depth.maxAccepted ?? "(none)"} (this probe reads ${r.depth.readableDepth} levels)`);
  lines.push("");

  lines.push("## A deleted item's translation");
  lines.push(`- Attempted: ${r.deleteTranslation.attempted ? "yes" : "no"} (${r.deleteTranslation.linkId ?? "-"})`);
  lines.push(`- Value before the delete: ${r.deleteTranslation.valueBeforeDelete ?? "(none registered)"}`);
  lines.push(`- Link resource still resolves: ${yesNo(r.deleteTranslation.resourceStillResolves)}`);
  lines.push(`- Value after the delete: ${r.deleteTranslation.valueAfterDelete ?? "(gone)"}`);
  for (const e of r.deleteTranslation.errors) lines.push(`  - error: ${e}`);
  lines.push("");

  lines.push("## Which write kills a translation?");
  lines.push(`- Attempted: ${r.translationDurability.attempted ? "yes" : "no"} (locale ${r.translationDurability.locale ?? "-"})`);
  const stages = [...new Set(r.translationDurability.observations.map((o) => o.stage))];
  const roles = [...new Set(r.translationDurability.observations.map((o) => o.role))];
  if (stages.length > 0) {
    lines.push(`| stage | ${roles.join(" | ")} |`);
    lines.push(`|---|${roles.map(() => "---").join("|")}|`);
    for (const stage of stages) {
      const cells = roles.map((role) => {
        const o = r.translationDurability.observations.find((x) => x.stage === stage && x.role === role);
        if (!o) return "-";
        return o.value ? (o.outdated ? "present (outdated)" : "present") : "GONE";
      });
      lines.push(`| ${stage} | ${cells.join(" | ")} |`);
    }
  }
  lines.push(
    `- Re-register right after the move: ${r.translationDurability.reRegisterAfterMove.attempted ? yesNo(r.translationDurability.reRegisterAfterMove.restored) : "not attempted"}`,
  );
  for (const e of r.translationDurability.errors) lines.push(`  - error: ${e}`);
  lines.push("");

  lines.push("## Market-scoped translation on a menu item");
  lines.push(`- Attempted: ${r.marketScoped.attempted ? "yes" : `no — ${r.marketScoped.reason ?? "?"}`}`);
  lines.push(`- Market: ${r.marketScoped.marketName ?? "-"} (${r.marketScoped.marketId ?? "-"}), locale ${r.marketScoped.locale ?? "-"}`);
  lines.push(`- Can be stored at all: ${yesNo(r.marketScoped.storedAtAll)}`);
  lines.push(`- Global read returns it (it must not): ${yesNo(r.marketScoped.globalReadShowsIt)}`);
  lines.push(`- Survives a re-parent: ${yesNo(r.marketScoped.survivesMove)}`);
  lines.push(`- Restorable afterwards: ${yesNo(r.marketScoped.restorable)}`);
  for (const e of r.marketScoped.errors) lines.push(`  - error: ${e}`);
  lines.push("");

  lines.push("## Resource-bound target types (does resourceId bind?)");
  lines.push(`- Attempted: ${r.resourceBound.attempted ? "yes" : "no"}`);
  for (const [type, sample] of Object.entries(r.resourceBound.samples)) {
    const bound = r.resourceBound.bound[type];
    const verdict = bound === true ? "BOUND" : bound === false ? "NOT BOUND" : "not measured";
    lines.push(
      `  - ${type}: ${verdict} (sent=${sample ?? "no sample on this shop"}, read back=${r.resourceBound.readBack[type] ?? "-"})`,
    );
  }
  for (const e of r.resourceBound.createErrors) lines.push(`  - create error: ${e}`);
  for (const e of r.resourceBound.errors) lines.push(`  - error: ${e}`);
  const rt = r.resourceBound.retarget;
  lines.push(`- Retarget an existing item: ${rt.attempted ? `yes (from ${rt.fromType ?? "-"})` : "no"}`);
  if (rt.attempted) {
    lines.push(`  - resourceId cleared by omitting it: ${yesNo(rt.resourceIdCleared)}`);
    lines.push(`  - new url stored: ${yesNo(rt.urlStored)}`);
    lines.push(`  - bound back to ${rt.fromType ?? "-"}: ${yesNo(rt.reboundOk)}`);
    lines.push(`  - old http url gone again: ${yesNo(rt.urlClearedOnRebind)}`);
    for (const e of rt.errors) lines.push(`  - error: ${e}`);
  }
  lines.push("");

  lines.push("## Item types that are neither HTTP nor resource-bound");
  lines.push(`- Attempted: ${r.typeRoundTrip.attempted ? "yes" : "no"} (${r.typeRoundTrip.typesTried.join(", ") || "-"})`);
  for (const item of r.typeRoundTrip.read) {
    lines.push(`  - ${item.type ?? "-"} "${item.title}" url=${item.url ?? "-"} resourceId=${item.resourceId ?? "-"}`);
  }
  lines.push(`- Write-back exactly as read: ${yesNo(r.typeRoundTrip.asReadOk)}`);
  for (const e of r.typeRoundTrip.asReadErrors) lines.push(`  - error: ${e}`);
  if (r.typeRoundTrip.withoutUrlOk !== null) {
    lines.push(`- Write-back with url stripped from non-HTTP items: ${yesNo(r.typeRoundTrip.withoutUrlOk)}`);
    for (const e of r.typeRoundTrip.withoutUrlErrors) lines.push(`  - error: ${e}`);
  }
  for (const e of r.typeRoundTrip.createErrors) lines.push(`  - create error: ${e}`);
  lines.push("");

  if (r.setup.errors.length > 0) {
    lines.push("## Setup errors");
    for (const e of r.setup.errors) lines.push(`- ${e}`);
  }

  return lines.join("\n");
}

function MenuWriteProbeCard() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<MenuWriteProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const runProbe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("confirm", "true");
      const r = await fetch("/api/menu-write-probe", { method: "POST", body: fd });
      const j = (await r.json()) as { report?: MenuWriteProbeReport; error?: string };
      if (!r.ok || !j.report) {
        throw new Error(j.error === "gated" ? "Requires the Pro plan" : j.error || `HTTP ${r.status}`);
      }
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const markdown = useMemo(() => (report ? formatMenuWriteProbeMarkdown(report) : ""), [report]);

  // A failed CLEANUP outranks every other verdict: it is the one outcome that
  // leaves something behind in the merchant's shop.
  const tone = (() => {
    if (!report) return "info" as const;
    if (!report.cleanup.allDeleted) return "critical" as const;
    if (report.verdict.some((v) => v.includes("⚠️") || v.includes("FAILED") || v.includes("BLOCKED"))) return "warning" as const;
    return "success" as const;
  })();

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">Menu item renaming (menuUpdate behaviour)</Text>
        <Text as="p" tone="subdued">
          Measures what <code>menuUpdate</code> actually does, because that mutation takes the WHOLE
          item tree: whether a MenuItem keeps its id across an update (its translation lives on
          <code> gid://shopify/Link/&lt;same number&gt;</code>, so a new id would orphan it), whether an
          item left out of the list is deleted, whether a resource-bound item keeps its
          <code> resourceId</code>, and what a rename does to an existing translation. Also
          introspects <code>MenuItemCreateInput</code> / <code>MenuItemUpdateInput</code> from your shop.
          Further throwaway menus answer what a tree EDITOR would need: whether an item keeps its id
          when it is re-parented (its translation lives on that number, so a new id would lose it),
          whether a menu item can hold a market-scoped translation at all (and whether a move takes
          that one too), whether an item sent without an id is created and can be found again by position, how deep
          Shopify really accepts (documented is three), what becomes of a deleted item&apos;s
          translation, and whether a write-back survives item types that are neither HTTP nor
          resource-bound (<code>FRONTPAGE</code>, <code>SEARCH</code>, …) — every default main menu
          has one, and a single refused field fails the entire mutation.
        </Text>
        <Banner tone="warning">
          <Text as="p">
            This probe WRITES. It creates up to six menus of its own under stamped handles — one it
            renames, moves, extends and prunes, one per item-type question, and one per depth it
            tries — and deletes every one of them again. Your real menus are never
            read or written. A menu is only rendered by a theme that references its handle, so the
            throwaway one is invisible in the storefront for the seconds it exists — and if the delete
            ever fails, the report names the handle so you can remove it by hand.
          </Text>
        </Banner>
        <Checkbox
          label="I understand this creates and deletes several throwaway menus in my shop"
          checked={confirmed}
          onChange={(checked) => setConfirmed(checked)}
        />
        <InlineStack gap="200">
          <Button onClick={runProbe} loading={loading} disabled={!confirmed}>
            {report ? "Re-run menu write probe" : "Run menu write probe"}
          </Button>
        </InlineStack>
        {error && <Banner tone="critical"><Text as="p">Probe failed: {error}</Text></Banner>}
        {report && (
          <BlockStack gap="200">
            <Banner tone={tone}>
              <BlockStack gap="100">
                {report.verdict.map((v, i) => <Text as="p" key={i}>{v}</Text>)}
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

function IndexNowProbeCard() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<IndexNowProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runProbe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/indexnow-probe", { method: "POST" });
      const j = (await r.json()) as { report?: IndexNowProbeReport; error?: string };
      if (!r.ok || !j.report) {
        throw new Error(j.error === "gated" ? "Requires the Pro plan" : j.error || `HTTP ${r.status}`);
      }
      setReport(j.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const markdown = useMemo(() => (report ? formatIndexNowMarkdown(report) : ""), [report]);

  const tone = (() => {
    if (!report) return "info" as const;
    if (report.verdict.some((v) => v.startsWith("❌"))) return "critical" as const;
    if (report.verdict.some((v) => v.startsWith("⚠️"))) return "warning" as const;
    return "success" as const;
  })();

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">IndexNow Probe</Text>
        <Text as="p" tone="subdued">
          Verifies the two things about IndexNow that only a live shop can answer: whether the key
          file served from the app proxy (<code>/apps/contentpilot/indexnow-key</code>) is accepted
          even though it is not at the storefront root, and whether fetching it stays on the domain
          we declare. Fetches the key file the way a search engine does, then submits the shop
          homepage to the real IndexNow endpoint and reports the raw status code.
        </Text>
        <Banner tone="info">
          <Text as="p">
            Requires IndexNow to be enabled in SEO → IndexNow. The only side effect is one
            submission of your homepage URL — the same call the section makes.
          </Text>
        </Banner>
        <InlineStack gap="200">
          <Button onClick={runProbe} loading={loading}>
            {report ? "Re-run IndexNow probe" : "Run IndexNow probe"}
          </Button>
        </InlineStack>
        {error && (
          <Banner tone="critical">
            <Text as="p">IndexNow probe failed: {error}</Text>
          </Banner>
        )}
        {report && (
          <>
            <Banner tone={tone}>
              <BlockStack gap="100">
                {report.verdict.map((v, i) => (
                  <Text as="p" key={i}>{v}</Text>
                ))}
              </BlockStack>
            </Banner>
            <textarea
              readOnly
              value={markdown}
              style={{
                width: "100%",
                minHeight: "260px",
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
          </>
        )}
      </BlockStack>
    </Card>
  );
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

      <IndexNowProbeCard />

      <RedirectLocaleProbeCard />

      <MenuTranslationProbeCard />

      <MenuWriteProbeCard />

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
                border: "1px solid var(--app-field-border-color)",
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
