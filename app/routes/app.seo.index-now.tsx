/**
 * IndexNow section (SEO section `indexNow`) — Pro+.
 *
 * Enable IndexNow (provisions a public key served via the app proxy), submit
 * the whole catalog, or drain the incremental queue fed by product/collection
 * webhooks. Pro+ gated in both loader and action.
 *
 * Host: the shop's PRIMARY domain (resolved live here, persisted on the config
 * row) so the submitted URLs and the keyLocation share the host IndexNow
 * verifies — see the service header for why the myshopify domain is wrong.
 * The loader re-syncs it on every visit and the background sweep re-checks it
 * daily, so adding a custom domain later fixes itself without minting a new
 * key. Only a RESOLVED domain is ever persisted: writing the myshopify
 * fallback after a failed lookup would undo a correct host.
 *
 * The two live Admin queries in `submitAll` (blog handles, page publish state)
 * run per explicit merchant action, are paginated to the same cap the URL
 * collector uses, and each degrades to "don't filter / skip those articles" on
 * error — never to a wrong URL list.
 */

import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { Card, BlockStack, InlineStack, Text, Badge, Button, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import { resolvePrimaryDomain } from "../utils/shop-domain.server";
import { logger } from "../utils/logger.server";
import type { Plan } from "../config/plans";
import {
  getIndexNowConfig,
  provisionIndexNow,
  setIndexNowEnabled,
  syncIndexNowHost,
  submitAll,
  drainQueue,
  getQueueCount,
  firstFailureKind,
  canSubmitAll,
  URL_COLLECT_CAP,
  type SubmitStatusKind,
} from "../services/seo/index-now.service";
import type { DataResponse } from "~/types/data-response";

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

const BLOG_HANDLES_QUERY = `#graphql
  query indexNowBlogHandles($cursor: String) {
    blogs(first: 250, after: $cursor) {
      edges { cursor node { id handle } }
      pageInfo { hasNextPage }
    }
  }
`;

const PAGE_PUBLISH_QUERY = `#graphql
  query indexNowPagePublishState($cursor: String) {
    pages(first: 250, after: $cursor) {
      edges { cursor node { id isPublished } }
      pageInfo { hasNextPage }
    }
  }
`;

/**
 * Both lookups feed `collectStoreUrls`, which reads up to URL_COLLECT_CAP rows
 * per type — so a single un-paginated page of 250 would silently stop applying
 * past that point (unpublished pages submitted as 404s, articles of later blogs
 * dropped). Bounded by the same cap the collector uses.
 */
const GRAPHQL_PAGE_SIZE = 250;
const MAX_QUERY_ROUNDS = Math.ceil(URL_COLLECT_CAP / GRAPHQL_PAGE_SIZE);

/** Walk a `first`/`after` connection to the end (or to the collector's cap). */
async function paginate(
  admin: any,
  query: string,
  connection: "blogs" | "pages",
  onNode: (node: any) => void,
): Promise<void> {
  let cursor: string | null = null;
  for (let round = 0; round < MAX_QUERY_ROUNDS; round++) {
    const res = await admin.graphql(query, { variables: { cursor } });
    const body: any = await res.json();
    if (body?.errors?.length) throw new Error(body.errors[0]?.message || "GraphQL error");
    const conn = body?.data?.[connection];
    const edges = conn?.edges ?? [];
    for (const edge of edges) if (edge?.node) onNode(edge.node);
    if (!conn?.pageInfo?.hasNextPage || edges.length === 0) return;
    cursor = edges[edges.length - 1]?.cursor ?? null;
    if (!cursor) return;
  }
  logger.warn(`[IndexNow] Stopped paginating ${connection} at the collect cap`);
}

/**
 * Blog GID → handle. Blogs have no DB cache and an article URL needs the real
 * blog handle; on failure we keep whatever was collected so far and
 * `collectStoreUrls` skips the remaining articles rather than submitting a
 * guessed (possibly 404) URL.
 */
async function fetchBlogHandles(admin: any): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    await paginate(admin, BLOG_HANDLES_QUERY, "blogs", (node) => {
      if (node.id && node.handle) map.set(node.id, node.handle);
    });
  } catch (err) {
    logger.warn("[IndexNow] Could not resolve all blog handles - skipping those articles", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return map;
}

/**
 * Page GIDs that are NOT published to the online store (their URL is a 404).
 * The page cache carries no publish flag, so this is the one place that can
 * know. A partial result is safe: it only ever DROPS pages we positively know
 * are unpublished, so a failure degrades to the previous "submit everything"
 * behaviour, never to a wrongly dropped page.
 */
async function fetchUnpublishedPageIds(admin: any): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    await paginate(admin, PAGE_PUBLISH_QUERY, "pages", (node) => {
      if (node.id && node.isPublished === false) ids.add(node.id);
    });
  } catch (err) {
    logger.warn("[IndexNow] Could not resolve page publish state - submitting those pages", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return ids;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "pro")) {
    return json({
      gated: true,
      configured: false,
      enabled: false,
      host: "",
      keyLocation: "",
      lastSubmittedAt: null as string | null,
      queueCount: 0,
    });
  }

  let config = await getIndexNowConfig(db, session.shop);
  if (config) {
    // Picks up a primary domain the merchant connected after enabling. Only
    // written when the lookup actually SUCCEEDED — persisting the myshopify
    // fallback on a transient API error would undo a correct host.
    const primaryDomain = await resolvePrimaryDomain(admin);
    if (primaryDomain) config = await syncIndexNowHost(db, session.shop, primaryDomain);
  }
  const queueCount = config ? await getQueueCount(db, session.shop) : 0;

  return json({
    gated: false,
    configured: !!config,
    enabled: !!config?.enabled,
    host: config?.host ?? "",
    keyLocation: config?.keyLocation ?? "",
    lastSubmittedAt: config?.lastSubmittedAt ? config.lastSubmittedAt.toISOString() : null,
    queueCount,
  });
};

type ActionResult =
  | { ok: true; kind: "provisioned" | "deprovisioned" }
  | { ok: true; kind: "submitted"; submitted: number; failed: number; failureKind: SubmitStatusKind | null }
  | { ok: true; kind: "empty" }
  | { ok: true; kind: "cooldown"; retryAfterMinutes: number }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<DataResponse> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "pro")) {
    return json<ActionResult>({ ok: false, error: "gated" }, { status: 403 });
  }

  const form = await request.formData();
  const actionType = getFormString(form, "actionType");

  if (actionType === "provision") {
    // A failed lookup still lets the merchant enable the feature: the row is
    // seeded with the myshopify host but left UNVERIFIED, so the sweep (and the
    // next section visit) replaces it with the real primary domain.
    const primaryDomain = await resolvePrimaryDomain(admin);
    await provisionIndexNow(db, session.shop, primaryDomain ?? session.shop, primaryDomain !== null);
    return json<ActionResult>({ ok: true, kind: "provisioned" });
  }
  if (actionType === "deprovision") {
    // Keeps key + host, drops the pending queue — see setIndexNowEnabled.
    await setIndexNowEnabled(db, session.shop, false);
    return json<ActionResult>({ ok: true, kind: "deprovisioned" });
  }
  if (actionType === "submitAll") {
    // Guard BEFORE the paginated lookups below — they are the expensive part
    // and a cooldown-blocked click would discard all of it.
    const allowed = await canSubmitAll(db, session.shop);
    if (allowed.status === "disabled") {
      return json<ActionResult>({ ok: false, error: "disabled" }, { status: 409 });
    }
    if (allowed.status === "cooldown") {
      return json<ActionResult>({
        ok: true,
        kind: "cooldown",
        retryAfterMinutes: Math.max(1, Math.ceil(allowed.retryAfterMs / 60000)),
      });
    }
    const [blogHandles, unpublishedPageIds] = await Promise.all([
      fetchBlogHandles(admin),
      fetchUnpublishedPageIds(admin),
    ]);
    const outcome = await submitAll(db, session.shop, { blogHandles, unpublishedPageIds });
    if (outcome.status === "disabled") return json<ActionResult>({ ok: false, error: "disabled" }, { status: 409 });
    if (outcome.status === "cooldown") {
      return json<ActionResult>({
        ok: true,
        kind: "cooldown",
        retryAfterMinutes: Math.max(1, Math.ceil(outcome.retryAfterMs / 60000)),
      });
    }
    return json<ActionResult>({
      ok: true,
      kind: "submitted",
      submitted: outcome.result.submitted,
      failed: outcome.result.failed,
      failureKind: firstFailureKind(outcome.result),
    });
  }
  if (actionType === "submitPending") {
    const outcome = await drainQueue(db, session.shop);
    if (outcome.status === "disabled") return json<ActionResult>({ ok: false, error: "disabled" }, { status: 409 });
    if (outcome.status === "empty") return json<ActionResult>({ ok: true, kind: "empty" });
    return json<ActionResult>({
      ok: true,
      kind: "submitted",
      submitted: outcome.result.submitted,
      failed: outcome.result.failed,
      failureKind: firstFailureKind(outcome.result),
    });
  }
  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

export default function SeoIndexNow() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const n = t.seo.indexNowPage;
  const fetcher = useFetcher<ActionResult>();
  const busy = fetcher.state !== "idle";
  const pendingAction = (fetcher.formData?.get("actionType") as string | null) ?? null;

  /** IndexNow's whole diagnosis is the status code — name the reason, don't just count. */
  const failureText = (kind: SubmitStatusKind | null): string => {
    switch (kind) {
      case "keyInvalid":
        return n.errorKeyInvalid;
      case "hostMismatch":
        return n.errorHostMismatch;
      case "rateLimited":
        return n.errorRateLimited;
      case "networkError":
        return n.errorNetwork;
      case "badRequest":
      case "serverError":
      case "unknown":
      default:
        return n.errorGeneric;
    }
  };

  const msg = (() => {
    if (busy || !fetcher.data) return null;
    if (!fetcher.data.ok) return { tone: "critical" as const, text: n.errorGeneric };
    if (fetcher.data.kind === "submitted") {
      const { submitted, failed, failureKind } = fetcher.data;
      if (failed > 0) {
        return {
          tone: (submitted > 0 ? "warning" : "critical") as "warning" | "critical",
          text:
            n.submittedPartial.replace("{ok}", String(submitted)).replace("{failed}", String(failed))
            + " "
            + failureText(failureKind),
        };
      }
      return { tone: "success" as const, text: n.submitted.replace("{count}", String(submitted)) };
    }
    if (fetcher.data.kind === "empty") return { tone: "info" as const, text: n.nothingToSubmit };
    if (fetcher.data.kind === "cooldown") {
      return {
        tone: "info" as const,
        text: n.cooldown.replace("{minutes}", String(fetcher.data.retryAfterMinutes)),
      };
    }
    if (fetcher.data.kind === "provisioned") return { tone: "success" as const, text: n.provisioned };
    if (fetcher.data.kind === "deprovisioned") return { tone: "info" as const, text: n.deprovisioned };
    return null;
  })();

  const submit = (actionType: string) => fetcher.submit({ actionType }, { method: "post" });

  return (
    <SeoSectionLayout sectionId="indexNow">
      {data.gated ? null : (
        <BlockStack gap="400">
          <Banner tone="info" title={n.helpTitle}>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">{n.helpBody1}</Text>
              <Text as="p" variant="bodyMd">{n.helpBody2}</Text>
            </BlockStack>
          </Banner>

          {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h3" variant="headingMd">
                  {n.title}
                </Text>
                <Badge tone={data.enabled ? "success" : undefined}>
                  {data.enabled ? n.enabled : n.disabled}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                {n.body}
              </Text>

              {!data.enabled ? (
                <BlockStack gap="200">
                  {data.configured && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {n.disabledKeyKept}
                    </Text>
                  )}
                  <InlineStack>
                    <Button
                      variant="primary"
                      loading={busy && pendingAction === "provision"}
                      disabled={busy}
                      onClick={() => submit("provision")}
                    >
                      {n.enableButton}
                    </Button>
                  </InlineStack>
                </BlockStack>
              ) : (
                <BlockStack gap="300">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {n.host}: {data.host}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {n.keyLocation}:{" "}
                    <a href={data.keyLocation} target="_blank" rel="noreferrer">
                      {data.keyLocation}
                    </a>
                  </Text>
                  {data.lastSubmittedAt && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {n.lastSubmitted}: {new Date(data.lastSubmittedAt).toLocaleString()}
                    </Text>
                  )}

                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Button
                      variant="primary"
                      loading={busy && pendingAction === "submitAll"}
                      disabled={busy}
                      onClick={() => submit("submitAll")}
                    >
                      {n.submitAll}
                    </Button>
                    <Button
                      loading={busy && pendingAction === "submitPending"}
                      disabled={busy || data.queueCount === 0}
                      onClick={() => submit("submitPending")}
                    >
                      {n.submitPending.replace("{count}", String(data.queueCount))}
                    </Button>
                    <Button
                      tone="critical"
                      variant="plain"
                      loading={busy && pendingAction === "deprovision"}
                      disabled={busy}
                      onClick={() => submit("deprovision")}
                    >
                      {n.disable}
                    </Button>
                  </InlineStack>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </BlockStack>
      )}
    </SeoSectionLayout>
  );
}
