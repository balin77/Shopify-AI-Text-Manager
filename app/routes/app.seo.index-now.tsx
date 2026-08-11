/**
 * IndexNow section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 8 / Anhang D2) — Pro+.
 *
 * Enable IndexNow (provisions a public key served via the app proxy), submit the
 * whole catalog, or drain the incremental queue fed by product/collection
 * webhooks. Pro+ gated in both loader and action. Host is the shop's myshopify
 * domain so the submitted URLs and the keyLocation share a host (IndexNow
 * requires that).
 */

import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { Card, BlockStack, InlineStack, Text, Badge, Button, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import {
  getIndexNowConfig,
  provisionIndexNow,
  deprovisionIndexNow,
  submitAll,
  drainQueue,
  getQueueCount,
} from "../services/seo/index-now.service";
import type { DataResponse } from "~/types/data-response";

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "pro")) {
    return json({ gated: true, configured: false, keyLocation: "", lastSubmittedAt: null as string | null, queueCount: 0 });
  }

  const config = await getIndexNowConfig(db, session.shop);
  const queueCount = config ? await getQueueCount(db, session.shop) : 0;

  return json({
    gated: false,
    configured: !!config,
    keyLocation: config?.keyLocation ?? "",
    lastSubmittedAt: config?.lastSubmittedAt ? config.lastSubmittedAt.toISOString() : null,
    queueCount,
  });
};

type ActionResult =
  | { ok: true; kind: "provisioned" | "deprovisioned" }
  | { ok: true; kind: "submitted"; submitted: number; failed: number }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<DataResponse> => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "pro")) {
    return json<ActionResult>({ ok: false, error: "gated" }, { status: 403 });
  }

  const host = session.shop; // myshopify host — matches the keyLocation host
  const form = await request.formData();
  const actionType = getFormString(form, "actionType");

  if (actionType === "provision") {
    await provisionIndexNow(db, session.shop);
    return json<ActionResult>({ ok: true, kind: "provisioned" });
  }
  if (actionType === "deprovision") {
    await deprovisionIndexNow(db, session.shop);
    return json<ActionResult>({ ok: true, kind: "deprovisioned" });
  }
  if (actionType === "submitAll") {
    const r = await submitAll(db, session.shop, host);
    return json<ActionResult>({ ok: true, kind: "submitted", submitted: r.submitted, failed: r.failed });
  }
  if (actionType === "submitPending") {
    const r = await drainQueue(db, session.shop, host);
    return json<ActionResult>({ ok: true, kind: "submitted", submitted: r.submitted, failed: r.failed });
  }
  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

export default function SeoIndexNow() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const n = t.seo.indexNowPage;
  const fetcher = useFetcher<ActionResult>();

  const msg = (() => {
    if (fetcher.state !== "idle" || !fetcher.data) return null;
    if (!fetcher.data.ok) return { tone: "critical" as const, text: n.errorGeneric };
    if (fetcher.data.kind === "submitted") {
      const { submitted, failed } = fetcher.data;
      return failed > 0
        ? { tone: "warning" as const, text: n.submittedPartial.replace("{ok}", String(submitted)).replace("{failed}", String(failed)) }
        : { tone: "success" as const, text: n.submitted.replace("{count}", String(submitted)) };
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
                <Badge tone={data.configured ? "success" : undefined}>
                  {data.configured ? n.enabled : n.disabled}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                {n.body}
              </Text>

              {!data.configured ? (
                <InlineStack>
                  <Button
                    variant="primary"
                    loading={fetcher.state !== "idle"}
                    onClick={() => submit("provision")}
                  >
                    {n.enableButton}
                  </Button>
                </InlineStack>
              ) : (
                <BlockStack gap="300">
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
                      loading={fetcher.state !== "idle"}
                      onClick={() => submit("submitAll")}
                    >
                      {n.submitAll}
                    </Button>
                    <Button
                      disabled={data.queueCount === 0}
                      onClick={() => submit("submitPending")}
                    >
                      {n.submitPending.replace("{count}", String(data.queueCount))}
                    </Button>
                    <Button tone="critical" variant="plain" onClick={() => submit("deprovision")}>
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
