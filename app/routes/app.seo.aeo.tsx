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
import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
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
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { SeoHelpBanner } from "../components/seo/SeoHelpBanner";
import { StepTile } from "../components/seo/StepTile";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { useAppNavigation } from "../hooks/useAppNavigation";
import {
  analyzeCatalogReadiness,
  type CatalogReadinessCode,
  type CatalogReadinessReport,
} from "../services/seo/catalog-readiness.service";
import {
  loadAiReferralSummary,
  type AiReferralSummary,
} from "../services/seo/ai-referral.service";
import {
  AI_DISCOVERY_INTRO_MAX_CHARS,
  normalizeDiscoveryIntro,
} from "../services/seo/ai-discovery-intro.shared";
import {
  analyzeAeo,
  applyRobotsRuleRemovals,
  generateAndUpsertAiDiscovery,
  getShopIdentity,
  removeAiDiscoveryOverride,
  themeWritesEnabled,
  type AiDiscoveryFile,
  type AiDiscoveryStatus,
  type RobotsAdvice,
  type RobotsCrawlerGroup,
  type RobotsRuleImpact,
} from "../services/seo/aeo.service";
import type { DataResponse } from "~/types/data-response";

/** Placeholder status for the plan-gated loader branch — see the shape note below. */
const GATED_DISCOVERY_STATUS: AiDiscoveryStatus = {
  overridden: false,
  upToDate: false,
  liveAvailable: false,
  liveServedByUs: false,
  liveExcerpt: "",
  url: "",
};

/** Same purpose as GATED_DISCOVERY_STATUS: keep both loader branches one shape. */
const GATED_REFERRALS: AiReferralSummary = {
  days: 30,
  totalVisits: 0,
  bySource: [],
  topPages: [],
};

/** Same purpose as GATED_DISCOVERY_STATUS: keep both loader branches one shape. */
const GATED_CATALOG_REPORT: CatalogReadinessReport = {
  scanned: 0,
  available: 0,
  capped: false,
  attributeDataKnown: false,
  ready: 0,
  buckets: [],
};

async function loadSettings(db: any, shop: string): Promise<{ plan: Plan; autoUpdate: boolean }> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true, llmsTxtAutoUpdate: true },
  });
  return {
    plan: (settings?.subscriptionPlan || "free") as Plan,
    // A shop with no settings row yet inherits the column default.
    autoUpdate: settings?.llmsTxtAutoUpdate ?? true,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const { plan, autoUpdate } = await loadSettings(db, session.shop);
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
      llmsUrl: "",
      aiDiscovery: {
        llms: GATED_DISCOVERY_STATUS,
        agents: GATED_DISCOVERY_STATUS,
      } as Record<AiDiscoveryFile, AiDiscoveryStatus>,
      agentsPolicyCount: 0,
      intros: { llms: "", agents: "" } as Record<AiDiscoveryFile, string>,
      defaultIntros: { llms: "", agents: "" } as Record<AiDiscoveryFile, string>,
      catalog: GATED_CATALOG_REPORT,
      referrals: GATED_REFERRALS,
      themeWrites: false,
      llmsAutoUpdate: true,
      shopDescriptionMissing: false,
      themesUrl: "",
      shopPrefsUrl: "",
    });
  }

  const { name, domain, description } = await getShopIdentity(admin, session.shop);
  const [analysis, catalog, referrals] = await Promise.all([
    analyzeAeo(admin, session.shop, {
      db,
      shopName: name,
      domain,
      description,
      autoUpdate,
    }),
    // DB-only and independent of the two Shopify-facing halves above, so they
    // cost wall-clock time only if they are the slowest of the four.
    //
    // Both degrade to their empty shape instead of throwing: `analyzeAeo`
    // swallows its own failures, so without these catches a hiccup in one of
    // the two youngest queries would 500 the WHOLE section — including the
    // robots.txt audit, which has nothing to do with either.
    analyzeCatalogReadiness(db, session.shop).catch(() => GATED_CATALOG_REPORT),
    loadAiReferralSummary(db, session.shop).catch(() => GATED_REFERRALS),
  ]);
  return json({
    gated: false,
    ...analysis,
    catalog,
    referrals,
    themesUrl: `https://${session.shop}/admin/themes`,
    shopPrefsUrl: `https://${session.shop}/admin/online_store/preferences`,
  });
};

type ActionResult = { ok: true } | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<DataResponse> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const { plan } = await loadSettings(db, session.shop);
  if (!meetsPlan(plan, "basic")) {
    return json<ActionResult>({ ok: false, error: "gated" }, { status: 403 });
  }

  const form = await request.formData();

  // Storing the preference is not a theme write, so it deliberately does NOT
  // sit behind AEO_THEME_WRITES — a merchant can set it up before the approval
  // lands, and the background pass checks both.
  if (getFormString(form, "actionType") === "setLlmsAutoUpdate") {
    const enabled = getFormString(form, "enabled") === "true";
    await db.aISettings.upsert({
      where: { shop: session.shop },
      update: { llmsTxtAutoUpdate: enabled },
      create: { shop: session.shop, llmsTxtAutoUpdate: enabled },
    });
    return json<ActionResult>({ ok: true });
  }
  // Storing the merchant's intro is a DB write, not a theme write, so it is
  // deliberately reachable without AEO_THEME_WRITES: the text can be prepared
  // (and improved with AI) long before the file may be published.
  if (getFormString(form, "actionType") === "setAiDiscoveryIntro") {
    const file = getFormString(form, "file");
    if (file !== "llms" && file !== "agents") {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const value = normalizeDiscoveryIntro(getFormString(form, "intro"));
    const column = file === "agents" ? "aiDiscoveryIntroAgents" : "aiDiscoveryIntroLlms";
    // Cleared box ⇒ NULL, not "": the generator treats both the same, but a
    // stored empty string would make "the merchant wrote nothing" and "the
    // merchant deleted their text" indistinguishable in the database.
    await db.aISettings.upsert({
      where: { shop: session.shop },
      update: { [column]: value || null },
      create: { shop: session.shop, [column]: value || null },
    });
    return json<ActionResult>({ ok: true });
  }

  if (getFormString(form, "actionType") === "generateLlms") {
    // Server-side gate. Hiding the button is not enough — this action is
    // POST-reachable directly, and without the Shopify approval every
    // themeFilesUpsert must be refused here.
    if (!themeWritesEnabled()) {
      return json<ActionResult>({ ok: false, error: "theme_writes_disabled" }, { status: 403 });
    }
    const { name, domain, description } = await getShopIdentity(admin, session.shop);
    const result = await generateAndUpsertAiDiscovery(
      admin,
      db,
      session.shop,
      name,
      domain,
      description,
    );
    return json<ActionResult>(result.ok ? { ok: true } : { ok: false, error: result.error || "failed" });
  }

  if (getFormString(form, "actionType") === "removeAiDiscoveryOverride") {
    if (!themeWritesEnabled()) {
      return json<ActionResult>({ ok: false, error: "theme_writes_disabled" }, { status: 403 });
    }
    // Only the two known filenames may be deleted — the value arrives from the
    // client and `deleteThemeFile` would happily remove any theme file.
    const file = getFormString(form, "file");
    if (file !== "llms" && file !== "agents") {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const result = await removeAiDiscoveryOverride(admin, file);
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
 * The tile itself is shared with the structured-data section — see StepTile.
 */
type AeoStep = "robots" | "llms" | "catalog";

/** Items listed per catalog bucket before it collapses into a count. */
const CATALOG_ITEMS_SHOWN = 8;

/**
 * Buckets whose field the bulk grid can actually edit today (`vendor` is a bulk
 * column, the taxonomy category is not) and whose fix is a mass edit rather
 * than per-product work.
 */
const BULK_FIXABLE_CODES: CatalogReadinessCode[] = ["brandMissing", "descriptionMissing"];

/** Rendered order: the canonical path first, its mirror second. */
const DISCOVERY_FILES: Array<{ file: AiDiscoveryFile; path: string }> = [
  { file: "agents", path: "/agents.md" },
  { file: "llms", path: "/llms.txt" },
];

/**
 * The one editable part of an AI-discovery file: its opening paragraph.
 *
 * Everything else in those documents is a catalog projection and stays
 * generated — a hand-edited product list is stale at the next price change and
 * the auto-refresh would overwrite it anyway. The intro is what no query can
 * know, so it is the merchant's, with an AI pass that suggests INTO the box and
 * never past it: nothing reaches a published file without an explicit save and
 * a subsequent generate.
 */
function DiscoveryIntroEditor({
  file,
  stored,
  fallback,
}: {
  file: AiDiscoveryFile;
  stored: string;
  /** What the generator would write with nothing stored ("" for llms.txt). */
  fallback: string;
}) {
  const { t } = useI18n();
  const a = t.seo.aeoPage;
  const saveFetcher = useFetcher<ActionResult>();

  const baseline = stored || fallback;
  const [text, setText] = useState(baseline);
  const [instruction, setInstruction] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const dirty = normalizeDiscoveryIntro(text) !== normalizeDiscoveryIntro(baseline);
  const saving = saveFetcher.state !== "idle";

  const runAi = async () => {
    if (!instruction.trim()) {
      setAiError(a.introAiMissingInstruction);
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const fd = new FormData();
      // /api/ai reads the action from `action` and rejects anything without a
      // contentType in VALID_CONTENT_TYPES — same shape as the robots advice.
      fd.set("action", "aiDiscoveryIntro");
      fd.set("contentType", "products");
      fd.set("file", file);
      fd.set("instruction", instruction);
      fd.set("current", text);
      const res = await fetch("/api/ai", { method: "POST", body: fd });
      const j = await res.json();
      if (!j?.success || typeof j.text !== "string" || !j.text) {
        setAiError(a.introAiFailed);
        return;
      }
      setText(j.text);
    } catch {
      setAiError(a.introAiFailed);
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <BlockStack gap="200">
      <Text as="h5" variant="headingSm">
        {a.introTitle}
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        {a.introHint}
      </Text>
      <TextField
        label={a.introTitle}
        labelHidden
        value={text}
        onChange={setText}
        multiline={4}
        autoComplete="off"
        maxLength={AI_DISCOVERY_INTRO_MAX_CHARS}
        placeholder={a.introPlaceholder}
        helpText={a.introChars
          .replace("{count}", String(text.length))
          .replace("{max}", String(AI_DISCOVERY_INTRO_MAX_CHARS))}
      />

      {saveFetcher.state === "idle" && saveFetcher.data && (
        <Banner tone={saveFetcher.data.ok ? "success" : "critical"}>
          {saveFetcher.data.ok ? a.introSaved : a.introSaveFailed}
        </Banner>
      )}
      {aiError && <Banner tone="critical">{aiError}</Banner>}

      <InlineStack gap="200" wrap>
        <Button
          disabled={!dirty}
          loading={saving}
          onClick={() =>
            saveFetcher.submit(
              { actionType: "setAiDiscoveryIntro", file, intro: text },
              { method: "post" },
            )
          }
        >
          {a.introSave}
        </Button>
        <Button variant="plain" onClick={() => setAiOpen((v) => !v)}>
          {a.introAiToggle}
        </Button>
        {normalizeDiscoveryIntro(text) !== normalizeDiscoveryIntro(fallback) && (
          <Button variant="plain" onClick={() => setText(fallback)}>
            {a.introReset}
          </Button>
        )}
      </InlineStack>

      {aiOpen && (
        <BlockStack gap="200">
          <TextField
            label={a.introAiLabel}
            value={instruction}
            onChange={setInstruction}
            autoComplete="off"
            multiline={2}
            placeholder={a.introAiPlaceholder}
          />
          <Text as="p" variant="bodySm" tone="subdued">
            {a.introAiHint}
          </Text>
          <InlineStack>
            <Button loading={aiLoading} onClick={runAi}>
              {a.introAiRun}
            </Button>
          </InlineStack>
        </BlockStack>
      )}
    </BlockStack>
  );
}

export default function SeoAeo() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const a = t.seo.aeoPage;
  // Deep links go through the app navigation hook so the embedded session
  // params survive — a bare <a> drops them and lands on a re-auth.
  const { handleNavigate } = useAppNavigation();
  const fetcher = useFetcher<ActionResult>();
  const robotsFetcher = useFetcher<ActionResult>();
  const autoFetcher = useFetcher<ActionResult>();
  const removeFetcher = useFetcher<ActionResult>();
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

  // Five states, not two. "Exists" and "is served" are different questions —
  // agents.md is a path Shopify fills by itself, so a missing override is a
  // normal state (the platform default is live), and a present override that
  // the URL does not return is the failure worth a warning.
  const discoveryStatus = (s: AiDiscoveryStatus) => {
    if (!s.overridden) return s.liveAvailable ? "platformDefault" : "unknown";
    if (!s.upToDate) return "stale";
    return s.liveServedByUs ? "live" : s.liveAvailable ? "notServed" : "unknown";
  };
  const DISCOVERY_BADGE = {
    live: { tone: "success" as const, key: "discoveryLive" as const },
    stale: { tone: "warning" as const, key: "discoveryStale" as const },
    notServed: { tone: "warning" as const, key: "discoveryNotServed" as const },
    platformDefault: { tone: "info" as const, key: "discoveryPlatformDefault" as const },
    unknown: { tone: undefined, key: "discoveryUnknown" as const },
  };
  const discoveryBadge = (s: AiDiscoveryStatus) => {
    const b = DISCOVERY_BADGE[discoveryStatus(s)];
    return <Badge tone={b.tone}>{a[b.key]}</Badge>;
  };

  // The step tile carries the worse of the two files: agents.md is the one
  // agents read, so a healthy llms.txt must not make the step look done.
  const STEP_BADGE_RANK = ["notServed", "stale", "unknown", "platformDefault", "live"] as const;
  const worstDiscovery = ([data.aiDiscovery.agents, data.aiDiscovery.llms] as AiDiscoveryStatus[])
    .map(discoveryStatus)
    .sort((x, y) => STEP_BADGE_RANK.indexOf(x as never) - STEP_BADGE_RANK.indexOf(y as never))[0];
  const llmsStatusBadge = (() => {
    const b = DISCOVERY_BADGE[worstDiscovery as keyof typeof DISCOVERY_BADGE];
    return <Badge tone={b.tone}>{a[b.key]}</Badge>;
  })();

  // "Nothing scanned" is not "all good": a shop whose products were never
  // synced would otherwise get a green badge for an empty catalog.
  const catalogBadge =
    data.catalog.scanned === 0 ? (
      <Badge>{a.statusUnknown}</Badge>
    ) : data.catalog.buckets.length === 0 ? (
      // "No findings" is only "complete" when everything was actually checked.
      // With the attribute block unsynced, brand and category were skipped —
      // claiming completeness for them would be a green badge over an unknown.
      data.catalog.attributeDataKnown ? (
        <Badge tone="success">{a.catalogBadgeComplete}</Badge>
      ) : (
        <Badge tone="attention">{a.catalogBadgePartial}</Badge>
      )
    ) : (
      <Badge tone="warning">
        {a.catalogBadgeGaps.replace("{count}", String(data.catalog.scanned - data.catalog.ready))}
      </Badge>
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
      // /api/ai reads the action from `action` (NOT `actionType`, which is this
      // route's own convention) and rejects anything without a contentType in
      // VALID_CONTENT_TYPES before it reaches the switch. Mirrors seoCrawl.
      fd.set("action", "seoRobotsAdvice");
      fd.set("contentType", "products");
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

  const genMsg = (() => {
    if (fetcher.state !== "idle" || !fetcher.data) return null;
    if (fetcher.data.ok) return { tone: "success" as const, msg: a.llmsGenerated };
    const map: Record<string, string> = {
      no_theme: a.errorNoTheme,
      upsert_failed: a.errorGeneric,
      gated: a.errorGeneric,
      theme_writes_disabled: a.themeWritesDisabled,
      no_paths: a.errorGeneric,
      not_removable: a.robotsNotRemovable,
      file_customized: a.robotsFileCustomized,
      verify_failed: a.robotsVerifyFailed,
      verify_failed_rolled_back: a.robotsVerifyRolledBack,
    };
    return { tone: "critical" as const, msg: map[fetcher.data.error] || a.errorGeneric };
  })();

  const removeMsg = (() => {
    if (removeFetcher.state !== "idle" || !removeFetcher.data) return null;
    if (removeFetcher.data.ok) return { tone: "success" as const, msg: a.discoveryOverrideRemoved };
    const map: Record<string, string> = {
      theme_writes_disabled: a.themeWritesDisabled,
      no_theme: a.errorNoTheme,
      delete_failed: a.discoveryRemoveFailed,
    };
    return { tone: "critical" as const, msg: map[removeFetcher.data.error] || a.errorGeneric };
  })();

  const robotsMsg = (() => {
    if (robotsFetcher.state !== "idle" || !robotsFetcher.data) return null;
    if (robotsFetcher.data.ok) return { tone: "success" as const, msg: a.robotsRulesRemoved };
    const map: Record<string, string> = {
      theme_writes_disabled: a.themeWritesDisabled,
      not_removable: a.robotsNotRemovable,
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
          <SeoHelpBanner title={a.helpTitle}>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">{a.helpBody1}</Text>
              <Text as="p" variant="bodyMd">{a.helpBody2}</Text>
            </BlockStack>
          </SeoHelpBanner>

          {genMsg && <Banner tone={genMsg.tone}>{genMsg.msg}</Banner>}
          {removeMsg && <Banner tone={removeMsg.tone}>{removeMsg.msg}</Banner>}
          {robotsMsg && <Banner tone={robotsMsg.tone}>{robotsMsg.msg}</Banner>}
          {adviceError && <Banner tone="critical">{adviceError}</Banner>}

          {/* Step selector — access (robots.txt), then orientation (discovery
              files), then the product data an answer engine compares on. The
              order is a dependency chain: a bot that may not read the shop
              never sees the files, and complete product data is worth nothing
              if neither of the first two holds. */}
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
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
            <StepTile
              selected={step === "catalog"}
              onSelect={() => setStep("catalog")}
              kicker={a.stepCatalogKicker}
              title={a.stepCatalogTitle}
              body={a.stepCatalogBody}
              badge={catalogBadge}
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

          {/* AI-discovery files: agents.md (canonical) + llms.txt */}
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

                {/* One block per path. agents.md first: it is the file agents
                    read, and llms.txt mirrors it unless overridden. */}
                <BlockStack gap="300">
                  {DISCOVERY_FILES.map(({ file, path }) => {
                    const s = data.aiDiscovery[file];
                    const status = discoveryStatus(s);
                    return (
                      <Box
                        key={file}
                        padding="300"
                        borderWidth="025"
                        borderColor="border"
                        borderRadius="200"
                      >
                        <BlockStack gap="200">
                          <InlineStack gap="200" blockAlign="center" wrap>
                            <Text as="h4" variant="headingSm">
                              {path}
                            </Text>
                            {discoveryBadge(s)}
                            {file === "agents" && <Badge tone="attention">{a.discoveryCanonical}</Badge>}
                          </InlineStack>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {a.discoveryExplain[file]}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {a.discoveryStatusLine[status]}
                          </Text>

                          {/* What the URL returns today — for EVERY status, not
                              just the platform default. It is the only evidence
                              on the page that does not come from us, and with
                              the preview panel gone it is also where a merchant
                              reads their own file back. */}
                          {s.liveExcerpt && (
                            <BlockStack gap="100">
                              <Text as="h5" variant="headingSm">
                                {a.liveExcerptTitle}
                              </Text>
                              <Box overflowX="scroll" background="bg-surface-secondary" padding="200" borderRadius="100">
                                <pre style={{ margin: 0, fontSize: "0.7rem", lineHeight: 1.5 }}>
                                  {s.liveExcerpt}
                                </pre>
                              </Box>
                            </BlockStack>
                          )}

                          <InlineStack gap="200">
                            {s.url && (
                              <Button variant="plain" url={s.url} target="_blank">
                                {a.llmsOpenLive}
                              </Button>
                            )}
                            {s.overridden && (
                              <Button
                                variant="plain"
                                tone="critical"
                                disabled={!data.themeWrites}
                                loading={removeFetcher.state !== "idle"}
                                onClick={() =>
                                  removeFetcher.submit(
                                    { actionType: "removeAiDiscoveryOverride", file },
                                    { method: "post" },
                                  )
                                }
                              >
                                {a.discoveryRemoveOverride}
                              </Button>
                            )}
                          </InlineStack>

                          <Divider />

                          <DiscoveryIntroEditor
                            file={file}
                            stored={data.intros[file]}
                            fallback={data.defaultIntros[file]}
                          />
                        </BlockStack>
                      </Box>
                    );
                  })}
                </BlockStack>

                {/* What the files would contain right now — the old card showed
                    only a present/absent badge, which gave no evidence that the
                    button had done anything. */}
                <Text as="p" variant="bodySm" tone="subdued">
                  {a.llmsContents
                    .replace("{products}", String(data.llmsProductCount))
                    .replace("{collections}", String(data.llmsCollectionCount))
                    .replace("{policies}", String(data.agentsPolicyCount))}
                </Text>

                {(data.aiDiscovery.agents.overridden && !data.aiDiscovery.agents.upToDate) ||
                (data.aiDiscovery.llms.overridden && !data.aiDiscovery.llms.upToDate) ? (
                  <Banner tone="warning">{a.llmsStaleHint}</Banner>
                ) : null}

                {/* Without shop.description the file has no `> summary` line —
                    the one sentence that tells an LLM what this store even is.
                    We ask the merchant for it rather than inventing one. */}
                {data.shopDescriptionMissing && (
                  <Banner tone="warning" title={a.shopDescriptionMissingTitle}>
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">{a.shopDescriptionMissingBody}</Text>
                      <InlineStack>
                        <Button url={data.shopPrefsUrl} target="_top">
                          {a.shopDescriptionOpenSettings}
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                )}

                {/* Lives here rather than in Settings: it only makes sense next
                    to the up-to-date/stale badge that motivates it, and it
                    matches how IndexNow is switched on in its own section. */}
                <Box
                  padding="300"
                  background="bg-surface-secondary"
                  borderWidth="025"
                  borderColor="border"
                  borderRadius="200"
                >
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <ToggleSwitch
                      id="llms-auto-update"
                      checked={data.llmsAutoUpdate}
                      disabled={autoFetcher.state !== "idle"}
                      onChange={(next) =>
                        autoFetcher.submit(
                          { actionType: "setLlmsAutoUpdate", enabled: String(next) },
                          { method: "post" },
                        )
                      }
                    />
                    <BlockStack gap="050">
                      <label htmlFor="llms-auto-update">
                        <Text as="span" variant="bodyMd" fontWeight="medium">
                          {a.llmsAutoLabel}
                        </Text>
                      </label>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {!data.llmsAutoUpdate
                          ? a.llmsAutoDisabled
                          : !data.themeWrites
                            ? a.llmsAutoOff
                            : data.llmsTxtExists
                              ? a.llmsAutoOn
                              : a.llmsAutoAfterFirst}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                </Box>

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
                    {data.aiDiscovery.agents.overridden || data.aiDiscovery.llms.overridden
                      ? a.llmsUpdate
                      : a.llmsGenerate}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          )}

          {/* Catalog readiness for AI channels */}
          {step === "catalog" && (
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    {a.catalogTitle}
                  </Text>
                  {catalogBadge}
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {a.catalogBody}
                </Text>

                {data.catalog.scanned === 0 ? (
                  <Text as="p" tone="subdued">
                    {a.catalogNoProducts}
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {(data.catalog.attributeDataKnown
                        ? a.catalogSummary
                        : a.catalogSummaryPartial
                      )
                        .replace("{ready}", String(data.catalog.ready))
                        .replace("{scanned}", String(data.catalog.scanned))}
                      {data.catalog.capped
                        ? " " +
                          a.catalogCapped
                            .replace("{scanned}", String(data.catalog.scanned))
                            .replace("{available}", String(data.catalog.available))
                        : ""}
                    </Text>

                    {/* The attribute block was never synced for at least one
                        scanned product, so brand and category are UNKNOWN for
                        the catalog — reporting them as missing would turn a
                        stale cache into a red finding. */}
                    {!data.catalog.attributeDataKnown && (
                      <Banner tone="info" title={a.catalogAttributesUnknownTitle}>
                        <BlockStack gap="200">
                          <Text as="p" variant="bodyMd">{a.catalogAttributesUnknownBody}</Text>
                          <InlineStack>
                            <Button onClick={() => handleNavigate("/app/products")}>
                              {a.catalogOpenProducts}
                            </Button>
                          </InlineStack>
                        </BlockStack>
                      </Banner>
                    )}

                    {data.catalog.buckets.length === 0 ? (
                      <Banner tone={data.catalog.attributeDataKnown ? "success" : "info"}>
                        {data.catalog.attributeDataKnown
                          ? a.catalogAllReady
                          : a.catalogAllReadyPartial}
                      </Banner>
                    ) : (
                      data.catalog.buckets.map((bucket) => (
                        <Box
                          key={bucket.code}
                          padding="300"
                          borderWidth="025"
                          borderColor="border"
                          borderRadius="200"
                        >
                          <BlockStack gap="200">
                            <InlineStack gap="200" blockAlign="center" wrap>
                              <Text as="h4" variant="headingSm">
                                {a.catalogCode[bucket.code].label}
                              </Text>
                              <Badge tone="warning">
                                {a.catalogAffected.replace("{count}", String(bucket.count))}
                              </Badge>
                            </InlineStack>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {a.catalogCode[bucket.code].hint}
                            </Text>
                            <BlockStack gap="100">
                              {bucket.items.slice(0, CATALOG_ITEMS_SHOWN).map((item) => (
                                <InlineStack key={item.id} gap="200" blockAlign="center" wrap>
                                  <Button
                                    variant="plain"
                                    onClick={() =>
                                      handleNavigate("/app/products", {
                                        searchParams: new URLSearchParams({ select: item.id }),
                                      })
                                    }
                                  >
                                    {item.title || item.handle}
                                  </Button>
                                </InlineStack>
                              ))}
                              {bucket.count > CATALOG_ITEMS_SHOWN && (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {a.catalogMore.replace(
                                    "{count}",
                                    String(bucket.count - CATALOG_ITEMS_SHOWN),
                                  )}
                                </Text>
                              )}
                            </BlockStack>
                            {/* Only where the grid really has the column —
                                offering "fix in bulk" for a field it cannot
                                edit would send the merchant on a hunt. */}
                            {BULK_FIXABLE_CODES.includes(bucket.code) && (
                              <InlineStack>
                                <Button onClick={() => handleNavigate("/app/bulk")}>
                                  {a.catalogFixInBulk}
                                </Button>
                              </InlineStack>
                            )}
                          </BlockStack>
                        </Box>
                      ))
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          )}

          {/* Arrivals from AI assistants. Below the steps, not one of them: the
              three steps are things to set up, this is what came of it. */}
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center" wrap>
                <Text as="h3" variant="headingMd">
                  {a.referralTitle}
                </Text>
                <Badge tone={data.referrals.totalVisits > 0 ? "success" : undefined}>
                  {a.referralWindow.replace("{days}", String(data.referrals.days))}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                {a.referralBody}
              </Text>

              {data.referrals.totalVisits === 0 ? (
                /* "Nothing yet" and "the beacon never ran" look identical from
                   here, and the second is the likelier one right after install.
                   Naming the app embed beats letting a merchant conclude the
                   feature is broken. */
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">
                      {a.referralNoneInWindow.replace("{days}", String(data.referrals.days))}
                    </Text>
                    <Text as="p" variant="bodySm">
                      {a.referralNoneHint}
                    </Text>
                  </BlockStack>
                </Banner>
              ) : (
                <BlockStack gap="300">
                  <Text as="p" variant="headingLg">
                    {a.referralTotal
                      .replace("{count}", String(data.referrals.totalVisits))
                      .replace("{days}", String(data.referrals.days))}
                  </Text>

                  <BlockStack gap="100">
                    {data.referrals.bySource.map((row) => (
                      <InlineStack key={row.source} gap="200" align="space-between" blockAlign="center">
                        <Text as="span" variant="bodyMd">
                          {(a.referralSourceName as Record<string, string>)[row.source] || row.source}
                        </Text>
                        <Text as="span" variant="bodyMd" fontWeight="medium">
                          {String(row.visits)}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>

                  {data.referrals.topPages.length > 0 && (
                    <BlockStack gap="100">
                      <Text as="h4" variant="headingSm">
                        {a.referralTopPages}
                      </Text>
                      {data.referrals.topPages.map((page) => (
                        <InlineStack key={page.path} gap="200" align="space-between" blockAlign="center">
                          <Text as="span" variant="bodySm" tone="subdued">
                            {page.path}
                          </Text>
                          <Text as="span" variant="bodySm">
                            {String(page.visits)}
                          </Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              )}

              {/* Stated, not hidden: what this number cannot see. */}
              <Text as="p" variant="bodySm" tone="subdued">
                {a.referralCaveat}
              </Text>
            </BlockStack>
          </Card>
        </BlockStack>
      )}
    </SeoSectionLayout>
  );
}
