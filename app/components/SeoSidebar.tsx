import { Card, BlockStack, Text, InlineStack, Badge, Button, ProgressBar, TextField } from "@shopify/polaris";
import { useState, useMemo, useEffect } from "react";
import { useFetcher } from "@remix-run/react";
import { useI18n } from "../contexts/I18nContext";
import { useSeoSettings } from "../contexts/SeoSettingsContext";
import {
  validateJsonLd,
  renderJsonLdScript,
  type JsonLd,
} from "../services/structured-data.service";
import {
  computeSeoScore,
  scoreTone,
  scoreLabelKey,
  progressTone,
  seoTitleEffectiveLimit,
} from "../utils/seo-score";
import {
  analyzeOnPage,
  type KeywordResourceType,
  type DensityBand,
} from "../services/seo/keywords.service";

interface SeoIssue {
  type: "error" | "warning" | "success";
  message: string;
  points: number;
}

interface SeoAnalysis {
  score: number;
  issues: SeoIssue[];
  recommendations: string[];
}

interface SeoSidebarProps {
  title: string;
  description: string;
  handle?: string;
  seoTitle: string;
  metaDescription: string;
  imagesWithAlt?: number;
  totalImages?: number;
  /** Skip description from SEO evaluation (e.g. blog containers have no body) */
  excludeDescription?: boolean;
  /** Skip image alt text from SEO evaluation (e.g. blog containers have no images) */
  excludeImages?: boolean;
  /**
   * Optional JSON-LD for the current resource. When provided, a collapsible
   * "Structured data" section with a copyable code block + schema validation
   * feedback is shown. Omit it and the sidebar behaves exactly as before.
   */
  structuredData?: JsonLd | null;
  /**
   * When true, `validateJsonLd` runs in preview mode: warnings that depend on
   * data the editor can't supply (Offer from variant price, Article.publishedAt,
   * Organization.logo) are suppressed. The storefront Liquid block emits these
   * from native/metafield/shop-brand data — flagging them here would be a
   * false positive. See structured-data.service.ValidateJsonLdOptions.
   */
  structuredDataPreviewMode?: boolean;
  /**
   * Optional target-keyword tracking (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 5 / A6
   * companion). When BOTH resourceId and resourceType are provided, a collapsible
   * "Target keyword" section is shown: it loads/saves the one tracked keyword for
   * this item (via /api/seo-keyword) and shows live on-page presence/density
   * feedback computed from the current edited title/seoTitle/metaDescription/
   * description as the merchant types. Omit either prop and the section is not
   * rendered — existing callers are unaffected.
   */
  resourceId?: string;
  resourceType?: KeywordResourceType;
}

export function SeoSidebar({
  title,
  description,
  handle,
  seoTitle,
  metaDescription,
  imagesWithAlt = 0,
  totalImages = 0,
  excludeDescription = false,
  excludeImages = false,
  structuredData = null,
  structuredDataPreviewMode = false,
  resourceId,
  resourceType,
}: SeoSidebarProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const jsonLdString = useMemo(
    () => (structuredData ? renderJsonLdScript(structuredData) : ""),
    [structuredData],
  );
  const jsonLdWarnings = useMemo(
    () =>
      structuredData
        ? validateJsonLd(structuredData, { previewMode: structuredDataPreviewMode })
        : [],
    [structuredData, structuredDataPreviewMode],
  );
  const { seoTitleSuffix, seoLimits } = useSeoSettings();
  const [showDetails, setShowDetails] = useState(false);

  // Effective upper limit accounts for the suffix Shopify appends (e.g., " – Shop Name").
  // Passes the merchant's seoTitleMax override to the helper so a Pro shop
  // that raised the cap to 70 doesn't get flagged at char 61.
  const effectiveSeoTitleLimit = seoTitleEffectiveLimit(seoTitleSuffix, seoLimits ?? null);

  // ── Target keyword (only when the caller supplies both ids) ──
  const keywordTrackingEnabled = !!resourceId && !!resourceType;
  const [keywordInput, setKeywordInput] = useState("");
  const [trackedKeyword, setTrackedKeyword] = useState<string | null>(null);
  const [keywordSaved, setKeywordSaved] = useState(false);
  const keywordLoadFetcher = useFetcher<{ keyword: string | null }>();
  const keywordSaveFetcher = useFetcher<{ ok: boolean; keyword?: string | null; error?: string }>();

  // Reload the tracked keyword whenever the selected item changes. Fetching
  // eagerly (not gated on showKeywordSection) means the badges below are
  // ready the moment the merchant expands the section.
  useEffect(() => {
    setKeywordSaved(false);
    if (!resourceId || !resourceType) {
      setTrackedKeyword(null);
      setKeywordInput("");
      return;
    }
    keywordLoadFetcher.load(`/api/seo-keyword?resourceId=${encodeURIComponent(resourceId)}`);
    // keywordLoadFetcher is intentionally omitted — Remix fetchers are stable,
    // but including it would re-trigger the effect on every fetcher state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId, resourceType]);

  useEffect(() => {
    if (keywordLoadFetcher.state === "idle" && keywordLoadFetcher.data) {
      const loaded = keywordLoadFetcher.data.keyword ?? "";
      setTrackedKeyword(keywordLoadFetcher.data.keyword ?? null);
      setKeywordInput(loaded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordLoadFetcher.state, keywordLoadFetcher.data]);

  useEffect(() => {
    if (keywordSaveFetcher.state === "idle" && keywordSaveFetcher.data?.ok) {
      setTrackedKeyword(keywordSaveFetcher.data.keyword ?? null);
      setKeywordSaved(true);
      const timeout = setTimeout(() => setKeywordSaved(false), 2000);
      return () => clearTimeout(timeout);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordSaveFetcher.state, keywordSaveFetcher.data]);

  const handleSaveKeyword = () => {
    if (!resourceId || !resourceType) return;
    keywordSaveFetcher.submit(
      { resourceId, resourceType, keyword: keywordInput },
      { method: "post", action: "/api/seo-keyword" },
    );
  };

  // Live on-page analysis of the TRACKED (saved) keyword against the current
  // edited field values — so toggling between title/description drafts updates
  // the badges immediately without re-saving the keyword itself.
  const keywordAnalysis = useMemo(() => {
    if (!trackedKeyword) return null;
    return analyzeOnPage({
      keyword: trackedKeyword,
      title,
      seoTitle,
      metaDescription,
      bodyHtml: description,
      resourceType,
    });
  }, [trackedKeyword, title, seoTitle, metaDescription, description, resourceType]);

  const densityTone: Record<DensityBand, "success" | "warning" | "critical" | undefined> = {
    ok: "success",
    low: "warning",
    high: "critical",
    none: undefined,
  };

  const kw = t.seo.keywordsPage;

  // Scoring is computed by the shared pure function (app/utils/seo-score.ts) so
  // the Sidebar and the store-wide Audit-Dashboard never drift. The function
  // returns i18n *codes*; we map them to the canonical t.seo.* strings here.
  const analysis = useMemo((): SeoAnalysis => {
    const result = computeSeoScore({
      title,
      description,
      seoTitle,
      metaDescription,
      imagesWithAlt,
      totalImages,
      excludeDescription,
      excludeImages,
      seoTitleEffectiveLimit: effectiveSeoTitleLimit,
      limits: seoLimits ?? null,
    });

    const issues: SeoIssue[] = result.findings.map((f) => {
      let message = (t.seo.issues as Record<string, string>)[f.code] ?? f.code;
      if (f.data) {
        for (const [key, value] of Object.entries(f.data)) {
          message = message.replace(`{${key}}`, String(value));
        }
      }
      return { type: f.severity, message, points: f.points };
    });

    const recommendations = result.recommendations.map((rec) => {
      let message = (t.seo.recommendations as Record<string, string>)[rec.code] ?? rec.code;
      if (rec.data) {
        for (const [key, value] of Object.entries(rec.data)) {
          message = message.replace(`{${key}}`, String(value));
        }
      }
      return message;
    });

    return { score: result.score, issues, recommendations };
  }, [title, description, seoTitle, metaDescription, imagesWithAlt, totalImages, excludeDescription, excludeImages, t, effectiveSeoTitleLimit, seoLimits]);

  const getScoreColor = scoreTone;

  const getScoreLabel = (scoreValue: number): string =>
    t.seo.scoreLabels[scoreLabelKey(scoreValue)];

  // Sub-tabs (Score / Keywords / JSON-LD). Hide a tab entirely when its data
  // isn't applicable to this caller (theme content has no JSON-LD, foreign
  // locales have no keyword tracking) — otherwise merchants would land on an
  // empty pane. With only "score" available, the tab bar is omitted.
  type SidebarTab = "score" | "keywords" | "jsonld";
  const availableTabs: SidebarTab[] = ["score"];
  if (keywordTrackingEnabled) availableTabs.push("keywords");
  if (structuredData) availableTabs.push("jsonld");
  const [activeTab, setActiveTab] = useState<SidebarTab>("score");
  const currentTab = availableTabs.includes(activeTab) ? activeTab : "score";
  const tabLabels = (t.seo as unknown as { sidebarTabs?: Record<string, string> }).sidebarTabs;
  const tabLabel = (id: SidebarTab): string => {
    const key = id === "jsonld" ? "jsonLd" : id;
    return tabLabels?.[key] ?? (id === "jsonld" ? "JSON-LD" : id === "keywords" ? "Keywords" : "Score");
  };

  return (
    <Card>
      <BlockStack gap="400">
        {/* Sub-tab bar (Score / Keywords / JSON-LD) */}
        {availableTabs.length > 1 && (
          <div style={{ display: "flex", borderBottom: "1px solid #e1e3e5", marginTop: "-0.25rem" }}>
            {availableTabs.map((id) => {
              const isActive = id === currentTab;
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  style={{
                    flex: 1,
                    padding: "6px 4px",
                    border: "none",
                    background: "none",
                    borderBottom: isActive ? "2px solid #005bd3" : "2px solid transparent",
                    cursor: "pointer",
                    fontWeight: isActive ? 600 : 400,
                    fontSize: 12,
                    color: isActive ? "#005bd3" : "#616161",
                  }}
                >
                  {tabLabel(id)}
                </button>
              );
            })}
          </div>
        )}

        {currentTab === "score" && (
        <BlockStack gap="400">
        {/* SEO Score Header */}
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: "80px",
              height: "80px",
              borderRadius: "50%",
              background: analysis.score >= 70 ? "#e3f2e9" : analysis.score >= 40 ? "#fff4e5" : "#fbeae5",
              border: `3px solid ${analysis.score >= 70 ? "#008060" : analysis.score >= 40 ? "#f59e00" : "#d72c0d"}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto",
              cursor: "pointer",
            }}
            onClick={() => setShowDetails(!showDetails)}
          >
            <Text as="h1" variant="heading2xl" fontWeight="bold">
              {analysis.score}
            </Text>
          </div>
          <div style={{ marginTop: "0.5rem" }}>
            <Text as="p" variant="headingMd">
              {t.seo.title}
            </Text>
            <Badge tone={getScoreColor(analysis.score) as any}>{getScoreLabel(analysis.score)}</Badge>
          </div>
        </div>

        {/* Progress Bar */}
        <div>
          <ProgressBar progress={analysis.score} tone={progressTone(analysis.score)} size="small" />
        </div>

        {/* Issues Summary */}
        <BlockStack gap="200">
          <Text as="p" variant="headingSm" fontWeight="semibold">
            {analysis.issues.some((issue) => issue.type === "warning" || issue.type === "error")
              ? t.seo.issuesTitle
              : t.seo.noIssuesTitle}
          </Text>
          {analysis.issues.map((issue, index) => (
            <InlineStack key={index} gap="200" align="start">
              <div style={{ marginTop: "2px" }}>
                {issue.type === "success" && "✅"}
                {issue.type === "warning" && "⚠️"}
                {issue.type === "error" && "❌"}
              </div>
              <div style={{ flex: 1 }}>
                <Text as="p" variant="bodySm">
                  {issue.message}
                </Text>
              </div>
            </InlineStack>
          ))}
        </BlockStack>

        {/* Recommendations */}
        {analysis.recommendations.length > 0 && (
          <BlockStack gap="200">
            <Text as="p" variant="headingSm" fontWeight="semibold">
              {t.seo.recommendationsTitle}
            </Text>
            {analysis.recommendations.map((recommendation, index) => (
              <InlineStack key={index} gap="200" align="start">
                <div style={{ marginTop: "2px" }}>💡</div>
                <div style={{ flex: 1 }}>
                  <Text as="p" variant="bodySm">
                    {recommendation}
                  </Text>
                </div>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        {/* Score Details (Expandable) */}
        {showDetails && (
          <div
            style={{
              padding: "1rem",
              background: "#f6f6f7",
              borderRadius: "8px",
              border: "1px solid #c9cccf",
            }}
          >
            <BlockStack gap="200">
              <Text as="p" variant="headingSm" fontWeight="semibold">
                {t.seo.scoreDetailsTitle}
              </Text>
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      15 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.titleLength}
                  </Text>
                </InlineStack>
              </div>
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      15 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.seoTitle}
                  </Text>
                </InlineStack>
              </div>
              {!excludeDescription && (
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      20 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.description}
                  </Text>
                </InlineStack>
              </div>
              )}
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      20 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.metaDescription}
                  </Text>
                </InlineStack>
              </div>
              {!excludeImages && (
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      30 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.imageAlt}
                  </Text>
                </InlineStack>
              </div>
              )}
            </BlockStack>
          </div>
        )}

        {/* Toggle Details Button */}
        <Button onClick={() => setShowDetails(!showDetails)} variant="plain" size="slim">
          {showDetails ? t.seo.hideDetails : t.seo.showDetails}
        </Button>
        </BlockStack>
        )}

        {/* JSON-LD tab */}
        {currentTab === "jsonld" && structuredData && (
          <BlockStack gap="200">
                {jsonLdWarnings.length === 0 ? (
                  <Badge tone="success">
                    {t.seo?.structuredDataValid || "Schema looks valid"}
                  </Badge>
                ) : (
                  <BlockStack gap="100">
                    {jsonLdWarnings.map((w, i) => {
                      // Prefer the localized copy via the stable warning code;
                      // fall back to the validator's English default so a
                      // future warning without a translation still renders.
                      const localized =
                        (t.seo?.structuredDataPage?.warnings as
                          | Record<string, string>
                          | undefined
                        )?.[w.code];
                      return (
                        <InlineStack key={i} gap="100" blockAlign="center">
                          <Badge
                            tone={w.severity === "error" ? "critical" : "warning"}
                          >
                            {w.severity}
                          </Badge>
                          <Text as="span" variant="bodySm">
                            {localized || w.message}
                          </Text>
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                )}
                <pre
                  style={{
                    maxHeight: "260px",
                    overflow: "auto",
                    background: "#f6f6f7",
                    padding: "8px",
                    borderRadius: "4px",
                    fontSize: "11px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {jsonLdString}
                </pre>
                <Button
                  size="slim"
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(
                        `<script type="application/ld+json">\n${jsonLdString}\n</script>`,
                      )
                      .then(
                        () => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        },
                        () => setCopied(false),
                      );
                  }}
                >
                  {copied
                    ? t.seo?.copied || "Copied!"
                    : t.seo?.copyJsonLd || "Copy <script> tag"}
                </Button>
          </BlockStack>
        )}

        {/* Keywords tab */}
        {currentTab === "keywords" && keywordTrackingEnabled && (
              <BlockStack gap="200">
                <TextField
                  label={t.seo?.targetKeywordLabel || "Target keyword"}
                  autoComplete="off"
                  placeholder={t.seo?.targetKeywordPlaceholder || "e.g. blue running shoes"}
                  value={keywordInput}
                  onChange={setKeywordInput}
                  disabled={keywordLoadFetcher.state !== "idle"}
                />
                <InlineStack gap="200" blockAlign="center">
                  <Button
                    size="slim"
                    onClick={handleSaveKeyword}
                    loading={keywordSaveFetcher.state !== "idle"}
                  >
                    {keywordSaved
                      ? t.seo?.targetKeywordSaved || "Saved"
                      : t.seo?.targetKeywordSave || "Save"}
                  </Button>
                  {!keywordInput.trim() && trackedKeyword && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {t.seo?.targetKeywordRemoveHint || "Clear the field and save to stop tracking this keyword."}
                    </Text>
                  )}
                </InlineStack>

                {keywordAnalysis && (
                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone={scoreTone(keywordAnalysis.score) as any}>
                        {`${t.seo?.targetKeywordScoreLabel || "On-page score"}: ${keywordAnalysis.score}`}
                      </Badge>
                      <Badge tone={densityTone[keywordAnalysis.densityBand]}>
                        {`${kw?.density?.[keywordAnalysis.densityBand] ?? keywordAnalysis.densityBand} (${keywordAnalysis.densityPct}%)`}
                      </Badge>
                    </InlineStack>
                    <InlineStack gap="100" wrap>
                      {(["title", "seoTitle", "metaDescription", "body"] as const).map((key) => (
                        <Badge key={key} tone={keywordAnalysis.presence[key] ? "success" : undefined}>
                          {kw?.presence?.[key] ?? key}
                        </Badge>
                      ))}
                    </InlineStack>
                  </BlockStack>
                )}
              </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
