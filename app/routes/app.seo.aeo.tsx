/**
 * AEO section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 7 / Anhang D1) — Basic+.
 *
 * - llms.txt: generate/update the native templates/llms.txt.liquid from the
 *   store (safe additive write).
 * - robots.txt: read-only audit of which AI crawlers are blocked, with guidance
 *   to the theme editor (we deliberately don't auto-rewrite robots.txt.liquid).
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Card, BlockStack, InlineStack, Text, Badge, Button, Banner, Box, Divider, List } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import {
  analyzeAeo,
  generateAndUpsertLlmsTxt,
  type RobotsCrawlerGroup,
  type RobotsRuleImpact,
} from "../services/seo/aeo.service";

const SHOP_INFO_QUERY = `#graphql
  query seoAeoShopInfo {
    shop {
      name
      primaryDomain { host url }
    }
  }
`;

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

async function getShopInfo(admin: any, fallbackShop: string): Promise<{ name: string; domain: string }> {
  try {
    const res = await admin.graphql(SHOP_INFO_QUERY);
    const j: any = await res.json();
    const shop = j?.data?.shop;
    return {
      name: shop?.name || fallbackShop.replace(/\.myshopify\.com$/, ""),
      domain: shop?.primaryDomain?.host || fallbackShop,
    };
  } catch {
    return { name: fallbackShop.replace(/\.myshopify\.com$/, ""), domain: fallbackShop };
  }
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
      themesUrl: "",
    });
  }

  const analysis = await analyzeAeo(admin, session.shop);
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
    const { name, domain } = await getShopInfo(admin, session.shop);
    const result = await generateAndUpsertLlmsTxt(admin, db, session.shop, name, domain);
    return json<ActionResult>(result.ok ? { ok: true } : { ok: false, error: result.error || "failed" });
  }
  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

/** Impact buckets, most actionable first. */
const IMPACT_ORDER: RobotsRuleImpact[] = ["content", "duplicate", "operational"];

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

export default function SeoAeo() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const a = t.seo.aeoPage;
  const fetcher = useFetcher<ActionResult>();

  const genMsg = (() => {
    if (fetcher.state !== "idle" || !fetcher.data) return null;
    if (fetcher.data.ok) return { tone: "success" as const, msg: a.llmsGenerated };
    const map: Record<string, string> = {
      no_theme: a.errorNoTheme,
      upsert_failed: a.errorGeneric,
      gated: a.errorGeneric,
    };
    return { tone: "critical" as const, msg: map[fetcher.data.error] || a.errorGeneric };
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

          {/* llms.txt */}
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h3" variant="headingMd">
                  {a.llmsTitle}
                </Text>
                <Badge tone={data.llmsTxtExists ? "success" : undefined}>
                  {data.llmsTxtExists ? a.llmsPresent : a.llmsAbsent}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                {a.llmsBody}
              </Text>
              <InlineStack gap="200">
                <Button
                  variant="primary"
                  loading={fetcher.state !== "idle"}
                  onClick={() => fetcher.submit({ actionType: "generateLlms" }, { method: "post" })}
                >
                  {data.llmsTxtExists ? a.llmsUpdate : a.llmsGenerate}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>

          {/* robots.txt AI-crawler audit */}
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

                  {(data.blockedCrawlers.length > 0 || data.restrictedCrawlers.length > 0) && (
                    <BlockStack gap="200">
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
        </BlockStack>
      )}
    </SeoSectionLayout>
  );
}
