/**
 * AEO section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 7 / Anhang D1) — Basic+.
 *
 * Two sequential steps rather than a pair of equal cards: robots.txt decides
 * whether AI crawlers may read the store at all, llms.txt only helps them
 * understand what they read.
 *
 * - robots.txt (step 1): rule-by-rule audit, plus an optional AI pass over the
 *   rules our classifier can't settle. Removing a rule regenerates a *managed*
 *   templates/robots.txt.liquid and is verified against the live robots.txt.
 * - llms.txt (step 2): generate/update templates/llms.txt.liquid from the store,
 *   with an up-to-date / stale status derived by rebuilding and comparing.
 *
 * Every theme write is gated on AEO_THEME_WRITES (default off) until Shopify
 * approves themeFilesUpsert for this app — enforced in the action, not just by
 * hiding buttons.
 */

import { useState, type ReactNode } from "react";
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  Banner,
  Box,
  Checkbox,
  Divider,
  List,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import {
  analyzeAeo,
  applyRobotsRuleRemovals,
  generateAndUpsertLlmsTxt,
  getShopIdentity,
  themeWritesEnabled,
  type RobotsAdvice,
  type RobotsCrawlerGroup,
  type RobotsRuleImpact,
} from "../services/seo/aeo.service";

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "basic")) {
    return json({
      gated: true,
      llmsTxtExists: false,
      blockedCrawlers: [] as string[],
      // Keep this shape in sync with the analysis branch below — TS infers
      // the loader's return type as the common shape across both `json()`
      // calls, so a field missing here (like this one previously) silently
      // disappears from `useLoaderData`'s type in the non-gated branch too.
      partiallyBlockedCrawlers: [] as string[],
      restrictedCrawlers: [] as string[],
      crawlerGroups: [] as RobotsCrawlerGroup[],
      robotsAuditAvailable: false,
      llmsTxtUpToDate: false,
      llmsProductCount: 0,
      llmsCollectionCount: 0,
      llmsPreview: "",
      llmsUrl: "",
      themeWrites: false,
      themesUrl: "",
    });
  }

  const { name, domain } = await getShopIdentity(admin, session.shop);
  const analysis = await analyzeAeo(admin, session.shop, { db, shopName: name, domain });
  return json({
    gated: false,
    ...analysis,
    themesUrl: `https://${session.shop}/admin/themes`,
  });
};

type ActionResult = { ok: true } | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "basic")) {
    return json<ActionResult>({ ok: false, error: "gated" }, { status: 403 });
  }

  const form = await request.formData();
  if (getFormString(form, "actionType") === "generateLlms") {
    // Server-side gate. Hiding the button is not enough — this action is
    // POST-reachable directly, and without the Shopify approval every
    // themeFilesUpsert must be refused here.
    if (!themeWritesEnabled()) {
      return json<ActionResult>({ ok: false, error: "theme_writes_disabled" }, { status: 403 });
    }
    const { name, domain } = await getShopIdentity(admin, session.shop);
    const result = await generateAndUpsertLlmsTxt(admin, db, session.shop, name, domain);
    return json<ActionResult>(result.ok ? { ok: true } : { ok: false, error: result.error || "failed" });
  }

  if (getFormString(form, "actionType") === "removeRobotsRules") {
    if (!themeWritesEnabled()) {
      return json<ActionResult>({ ok: false, error: "theme_writes_disabled" }, { status: 403 });
    }
    const paths = form.getAll("path").filter((p): p is string => typeof p === "string");
    const result = await applyRobotsRuleRemovals(admin, session.shop, paths);
    return json<ActionResult>(
      result.ok ? { ok: true } : { ok: false, error: result.error || "failed" },
    );
  }

  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

/** Impact buckets, most actionable first. */
const IMPACT_ORDER: RobotsRuleImpact[] = ["content", "unknown", "duplicate", "operational"];

const VERDICT_TONE = {
  blocked: "critical",
  restricted: "warning",
  standard: "success",
  allowed: "success",
} as const;

/**
 * One explained block per distinct rule set. Crawlers that share a rule set are
 * collapsed by `groupCrawlerStatuses`, so a stock store renders a single block
 * covering all 14 bots instead of repeating the same list fourteen times.
 */
function CrawlerGroupDetail({ group }: { group: RobotsCrawlerGroup }) {
  const { t } = useI18n();
  const a = t.seo.aeoPage;

  const byImpact = IMPACT_ORDER.map((impact) => ({
    impact,
    rules: group.rules.filter((r) => r.impact === impact),
  })).filter((b) => b.rules.length > 0);

  return (
    <Box
      padding="300"
      borderWidth="025"
      borderColor="border"
      borderRadius="200"
      background={group.verdict === "standard" || group.verdict === "allowed" ? "bg-surface" : "bg-surface-secondary"}
    >
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center" wrap>
          <Badge tone={VERDICT_TONE[group.verdict]}>{a.verdictLabel[group.verdict]}</Badge>
          <Text as="span" variant="bodySm" tone="subdued">
            {group.matchedBy === "explicit"
              ? a.robotsSourceExplicit
              : group.matchedBy === "wildcard"
                ? a.robotsSourceWildcard
                : a.robotsSourceNone}
          </Text>
        </InlineStack>

        <InlineStack gap="100" wrap>
          {group.crawlers.map((c) => (
            <Badge key={c}>{c}</Badge>
          ))}
        </InlineStack>

        {byImpact.length === 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {a.robotsNoRules}
          </Text>
        ) : (
          byImpact.map((bucket, i) => (
            <BlockStack key={bucket.impact} gap="150">
              {i > 0 && <Divider />}
              <Text as="h4" variant="headingSm">
                {a.impactTitle[bucket.impact]}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {a.impactHint[bucket.impact]}
              </Text>
              <List type="bullet">
                {bucket.rules.map((r, j) => (
                  <List.Item key={`${r.path}-${j}`}>
                    <Text as="span" variant="bodySm" fontWeight="medium">
                      {r.path}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {" "}
                      — {a.robotsReason[r.reason]}
                    </Text>
                  </List.Item>
                ))}
              </List>
            </BlockStack>
          ))
        )}
      </BlockStack>
    </Box>
  );
}

/**
 * The two AEO levers are sequential, not a pair: robots.txt decides *whether* a
 * crawler may read the store at all, llms.txt only helps it understand what it
 * read. Rendering both as equal cards (the old layout) hid that dependency and
 * put the optional one first. They're now two selectable steps, access first.
 */
type AeoStep = "robots" | "llms";

function StepTile({
  selected,
  onSelect,
  kicker,
  title,
  body,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  kicker: string;
  title: string;
  body: string;
  badge: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        display: "block",
        width: "100%",
        // The button is the grid item, so it carries the height for the two
        // tiles to line up when one has more text than the other.
        height: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        padding: 0,
        font: "inherit",
        cursor: "pointer",
      }}
    >
      <Box
        padding="400"
        borderWidth={selected ? "050" : "025"}
        borderColor={selected ? "border-emphasis" : "border"}
        borderRadius="200"
        background={selected ? "bg-surface-secondary" : "bg-surface"}
        minHeight="100%"
      >
        <BlockStack gap="200">
          <InlineStack gap="200" blockAlign="center" wrap>
            <Text as="span" variant="bodySm" tone="subdued" fontWeight="medium">
              {kicker}
            </Text>
            {badge}
          </InlineStack>
          <Text as="h3" variant="headingMd">
            {title}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {body}
          </Text>
        </BlockStack>
      </Box>
    </button>
  );
}

export default function SeoAeo() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const a = t.seo.aeoPage;
  const fetcher = useFetcher<ActionResult>();
  const robotsFetcher = useFetcher<ActionResult>();
  const [step, setStep] = useState<AeoStep>("robots");

  const robotsBadge = !data.robotsAuditAvailable ? (
    <Badge>{a.statusUnknown}</Badge>
  ) : data.blockedCrawlers.length > 0 ? (
    <Badge tone="critical">{a.verdictLabel.blocked}</Badge>
  ) : data.restrictedCrawlers.length > 0 ? (
    <Badge tone="warning">{a.verdictLabel.restricted}</Badge>
  ) : (
    <Badge tone="success">{a.robotsStatusOk}</Badge>
  );

  // Three states, not two: a file that exists but no longer matches the catalog
  // is the case the old present/absent badge could not express at all.
  const llmsStatusBadge = !data.llmsTxtExists ? (
    <Badge tone="attention">{a.llmsAbsent}</Badge>
  ) : data.llmsTxtUpToDate ? (
    <Badge tone="success">{a.llmsUpToDate}</Badge>
  ) : (
    <Badge tone="warning">{a.llmsStale}</Badge>
  );

  // Rules our own classifier couldn't settle — the only ones worth asking the
  // model about, and the only ones the removal flow will accept.
  const adviseablePaths = Array.from(
    new Set(
      data.crawlerGroups
        .flatMap((g) => g.rules)
        .filter((r) => (r.impact === "content" || r.impact === "unknown") && r.reason !== "sitewide")
        .map((r) => r.path),
    ),
  );

  const [advice, setAdvice] = useState<RobotsAdvice[]>([]);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [adviceError, setAdviceError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelected = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // Raw fetch rather than a shared useFetcher: /api/ai is a different route and
  // this must not contend with the removal submission below.
  const runAdvice = async () => {
    setAdviceLoading(true);
    setAdviceError(null);
    try {
      const fd = new FormData();
      fd.set("actionType", "seoRobotsAdvice");
      const res = await fetch("/api/ai", { method: "POST", body: fd });
      const j = await res.json();
      if (!j?.success) {
        setAdviceError(a.aiFixFailed);
        return;
      }
      const items: RobotsAdvice[] = j.advice || [];
      setAdvice(items);
      // Preselect what the model recommends removing — the merchant still has
      // to press the button, and can uncheck anything.
      setSelected(new Set(items.filter((i) => i.recommendation === "remove").map((i) => i.path)));
    } catch {
      setAdviceError(a.aiFixFailed);
    } finally {
      setAdviceLoading(false);
    }
  };

  const PREVIEW_LINES = 12;
  const allPreviewLines = data.llmsPreview.split("\n");
  const previewLines = allPreviewLines.slice(0, PREVIEW_LINES).join("\n");
  const previewTruncated = allPreviewLines.length > PREVIEW_LINES;

  const genMsg = (() => {
    if (fetcher.state !== "idle" || !fetcher.data) return null;
    if (fetcher.data.ok) return { tone: "success" as const, msg: a.llmsGenerated };
    const map: Record<string, string> = {
      no_theme: a.errorNoTheme,
      upsert_failed: a.errorGeneric,
      gated: a.errorGeneric,
      theme_writes_disabled: a.themeWritesDisabled,
      no_paths: a.errorGeneric,
      file_customized: a.robotsFileCustomized,
      verify_failed: a.robotsVerifyFailed,
      verify_failed_rolled_back: a.robotsVerifyRolledBack,
    };
    return { tone: "critical" as const, msg: map[fetcher.data.error] || a.errorGeneric };
  })();

  const robotsMsg = (() => {
    if (robotsFetcher.state !== "idle" || !robotsFetcher.data) return null;
    if (robotsFetcher.data.ok) return { tone: "success" as const, msg: a.robotsRulesRemoved };
    const map: Record<string, string> = {
      theme_writes_disabled: a.themeWritesDisabled,
      file_customized: a.robotsFileCustomized,
      verify_failed: a.robotsVerifyFailed,
      verify_failed_rolled_back: a.robotsVerifyRolledBack,
      no_theme: a.errorNoTheme,
    };
    return { tone: "critical" as const, msg: map[robotsFetcher.data.error] || a.errorGeneric };
  })();

  return (
    <SeoSectionLayout sectionId="aeo">
      {data.gated ? null : (
        <BlockStack gap="400">
          <Banner tone="info" title={a.helpTitle}>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">{a.helpBody1}</Text>
              <Text as="p" variant="bodyMd">{a.helpBody2}</Text>
            </BlockStack>
          </Banner>

          {genMsg && <Banner tone={genMsg.tone}>{genMsg.msg}</Banner>}
          {robotsMsg && <Banner tone={robotsMsg.tone}>{robotsMsg.msg}</Banner>}
          {adviceError && <Banner tone="critical">{adviceError}</Banner>}

          {/* Step selector — access (robots.txt) before orientation (llms.txt). */}
          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
            <StepTile
              selected={step === "robots"}
              onSelect={() => setStep("robots")}
              kicker={a.stepAccessKicker}
              title={a.stepAccessTitle}
              body={a.stepAccessBody}
              badge={robotsBadge}
            />
            <StepTile
              selected={step === "llms"}
              onSelect={() => setStep("llms")}
              kicker={a.stepGuideKicker}
              title={a.stepGuideTitle}
              body={a.stepGuideBody}
              badge={llmsStatusBadge}
            />
          </InlineGrid>

          {/* robots.txt AI-crawler audit */}
          {step === "robots" && (
          <Card>
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">
                {a.robotsTitle}
              </Text>
              {!data.robotsAuditAvailable ? (
                <Text as="p" tone="subdued">
                  {a.robotsUnavailable}
                </Text>
              ) : (
                <BlockStack gap="400">
                  {/* One verdict for the whole audit. A stock Shopify robots.txt
                      disallows ~30 paths (checkout, cart, faceted collections …)
                      — all correct — so "some path is disallowed" is not a
                      finding. Only a full block or a *content* path is. */}
                  {data.blockedCrawlers.length > 0 ? (
                    <Banner tone="critical" title={a.verdictBlockedTitle}>
                      {a.verdictBlockedBody}
                    </Banner>
                  ) : data.restrictedCrawlers.length > 0 ? (
                    <Banner tone="warning" title={a.verdictRestrictedTitle}>
                      {a.verdictRestrictedBody}
                    </Banner>
                  ) : data.partiallyBlockedCrawlers.length > 0 ? (
                    <Banner tone="success" title={a.verdictStandardTitle}>
                      {a.verdictStandardBody}
                    </Banner>
                  ) : (
                    <Banner tone="success">{a.robotsAllAllowed}</Banner>
                  )}

                  {data.crawlerGroups.map((group, i) => (
                    <CrawlerGroupDetail key={i} group={group} />
                  ))}

                  {/* AI-assisted pruning. Only offered when there is something
                      our own classifier couldn't settle — on a stock store this
                      whole block stays hidden. */}
                  {adviseablePaths.length > 0 && (
                    <BlockStack gap="300">
                      <Divider />
                      <Text as="h4" variant="headingSm">
                        {a.aiFixTitle}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {a.aiFixBody}
                      </Text>

                      {advice.length === 0 ? (
                        <InlineStack>
                          <Button loading={adviceLoading} onClick={runAdvice}>
                            {a.aiFixRun}
                          </Button>
                        </InlineStack>
                      ) : (
                        <BlockStack gap="200">
                          {advice.map((item) => (
                            <Box
                              key={item.path}
                              padding="300"
                              borderWidth="025"
                              borderColor="border"
                              borderRadius="200"
                            >
                              <BlockStack gap="100">
                                <Checkbox
                                  label={item.path}
                                  checked={selected.has(item.path)}
                                  onChange={() => toggleSelected(item.path)}
                                />
                                <InlineStack gap="200" blockAlign="center" wrap>
                                  <Badge tone={item.recommendation === "remove" ? "warning" : "success"}>
                                    {item.recommendation === "remove" ? a.aiFixRemove : a.aiFixKeep}
                                  </Badge>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {item.reason}
                                  </Text>
                                </InlineStack>
                              </BlockStack>
                            </Box>
                          ))}

                          {!data.themeWrites && <Banner tone="warning">{a.themeWritesDisabled}</Banner>}

                          <Text as="p" variant="bodySm" tone="subdued">
                            {a.aiFixApplyHint}
                          </Text>
                          <InlineStack gap="200">
                            <Button
                              variant="primary"
                              disabled={!data.themeWrites || selected.size === 0}
                              loading={robotsFetcher.state !== "idle"}
                              onClick={() => {
                                const fd = new FormData();
                                fd.set("actionType", "removeRobotsRules");
                                for (const p of selected) fd.append("path", p);
                                robotsFetcher.submit(fd, { method: "post" });
                              }}
                            >
                              {a.aiFixApply.replace("{count}", String(selected.size))}
                            </Button>
                            <Button loading={adviceLoading} onClick={runAdvice}>
                              {a.aiFixRerun}
                            </Button>
                          </InlineStack>
                        </BlockStack>
                      )}
                    </BlockStack>
                  )}

                  {(data.blockedCrawlers.length > 0 || data.restrictedCrawlers.length > 0) && (
                    <BlockStack gap="200">
                      <Divider />
                      <Text as="p" variant="bodySm" tone="subdued">
                        {a.robotsFixHint}
                      </Text>
                      <InlineStack>
                        <Button url={data.themesUrl} target="_top">
                          {a.robotsOpenThemes}
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  )}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
          )}

          {/* llms.txt */}
          {step === "llms" && (
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    {a.llmsTitle}
                  </Text>
                  {llmsStatusBadge}
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {a.llmsBody}
                </Text>

                {/* What the file would contain right now — the old card showed
                    only a present/absent badge, which gave no evidence that the
                    button had done anything. */}
                <Text as="p" variant="bodySm" tone="subdued">
                  {a.llmsContents
                    .replace("{products}", String(data.llmsProductCount))
                    .replace("{collections}", String(data.llmsCollectionCount))}
                </Text>

                {data.llmsTxtExists && !data.llmsTxtUpToDate && (
                  <Banner tone="warning">{a.llmsStaleHint}</Banner>
                )}

                {/* The background refresh has no settings of its own, but it is
                    invisible without this line — a merchant would reasonably
                    assume the file only ever changes when they press the
                    button. */}
                <Text as="p" variant="bodySm" tone="subdued">
                  {data.themeWrites
                    ? data.llmsTxtExists
                      ? a.llmsAutoOn
                      : a.llmsAutoAfterFirst
                    : a.llmsAutoOff}
                </Text>

                {data.llmsPreview && (
                  <Box
                    padding="300"
                    background="bg-surface-secondary"
                    borderWidth="025"
                    borderColor="border"
                    borderRadius="200"
                  >
                    <BlockStack gap="200">
                      <Text as="h4" variant="headingSm">
                        {a.llmsPreviewTitle}
                      </Text>
                      <Box overflowX="scroll">
                        <pre style={{ margin: 0, fontSize: "0.75rem", lineHeight: 1.5 }}>
                          {previewLines}
                        </pre>
                      </Box>
                      {previewTruncated && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {a.llmsPreviewTruncated}
                        </Text>
                      )}
                    </BlockStack>
                  </Box>
                )}

                {/* llms.txt is a 2024 community proposal, not a ratified
                    standard, and no major provider has confirmed its crawlers
                    read it. Saying so beats implying parity with robots.txt. */}
                <Banner tone="info">{a.llmsCaveat}</Banner>

                {!data.themeWrites && <Banner tone="warning">{a.themeWritesDisabled}</Banner>}

                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    disabled={!data.themeWrites}
                    loading={fetcher.state !== "idle"}
                    onClick={() => fetcher.submit({ actionType: "generateLlms" }, { method: "post" })}
                  >
                    {data.llmsTxtExists ? a.llmsUpdate : a.llmsGenerate}
                  </Button>
                  {data.llmsTxtExists && data.llmsUrl && (
                    <Button url={data.llmsUrl} target="_blank">
                      {a.llmsOpenLive}
                    </Button>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>
          )}
        </BlockStack>
      )}
    </SeoSectionLayout>
  );
}
