/**
 * Keyword tracking section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 5 / A6).
 *
 * Store one target keyword per item and see a local on-page analysis (presence
 * in title/H1/meta/SEO-title/body + density + position). Read-only scoring is
 * computed server-side from the DB content cache via analyzeOnPage. GSC ranking
 * data (Phase 6) plugs into the same rows later.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  TextField,
  Select,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { scoreTone } from "../utils/seo-score";
import {
  analyzeOnPage,
  listKeywords,
  setKeyword,
  deleteKeyword,
  type KeywordResourceType,
  type DensityBand,
} from "../services/seo/keywords.service";
import { getFormString } from "../utils/form-data.utils";

/** Items shown per type in the add-keyword picker. */
const PICKER_CAP = 250;

const RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

interface PickerItem {
  id: string;
  title: string;
}
interface ItemContent {
  title: string;
  seoTitle: string;
  metaDescription: string;
  bodyHtml: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const rows = await listKeywords(db, shop);

  // Resolve item content for the tracked keywords, batched per type.
  const idsByType: Record<string, string[]> = {};
  for (const row of rows) {
    (idsByType[row.resourceType] ||= []).push(row.resourceId);
  }
  const content = new Map<string, ItemContent>();
  const put = (
    id: string,
    c: { title: string; seoTitle?: string | null; seoDescription?: string | null; body?: string | null },
  ) =>
    content.set(id, {
      title: c.title,
      seoTitle: c.seoTitle ?? "",
      metaDescription: c.seoDescription ?? "",
      bodyHtml: c.body ?? "",
    });

  await Promise.all([
    idsByType.Product?.length
      ? db.product
          .findMany({
            where: { shop, id: { in: idsByType.Product } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, descriptionHtml: true },
          })
          .then((items) => items.forEach((i) => put(i.id, { ...i, body: i.descriptionHtml })))
      : null,
    idsByType.Collection?.length
      ? db.collection
          .findMany({
            where: { shop, id: { in: idsByType.Collection } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, descriptionHtml: true },
          })
          .then((items) => items.forEach((i) => put(i.id, { ...i, body: i.descriptionHtml })))
      : null,
    idsByType.Article?.length
      ? db.article
          .findMany({
            where: { shop, id: { in: idsByType.Article } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, body: true },
          })
          .then((items) => items.forEach((i) => put(i.id, i)))
      : null,
    idsByType.Page?.length
      ? db.page
          .findMany({
            where: { shop, id: { in: idsByType.Page } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, body: true },
          })
          .then((items) => items.forEach((i) => put(i.id, i)))
      : null,
  ]);

  const keywords = rows.map((row) => {
    const c = content.get(row.resourceId);
    const analysis = analyzeOnPage({
      keyword: row.keyword,
      title: c?.title ?? "",
      seoTitle: c?.seoTitle ?? "",
      metaDescription: c?.metaDescription ?? "",
      bodyHtml: c?.bodyHtml ?? "",
    });
    return {
      id: row.id,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      keyword: row.keyword,
      itemTitle: c?.title ?? "",
      itemMissing: !c,
      score: analysis.score,
      densityPct: analysis.densityPct,
      densityBand: analysis.densityBand,
      presence: analysis.presence,
      gscPosition: row.gscPosition,
    };
  });

  // Lightweight per-type pickers for the add form (capped).
  const [products, collections, articles, pages] = await Promise.all([
    db.product.findMany({ where: { shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: PICKER_CAP }),
    db.collection.findMany({ where: { shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: PICKER_CAP }),
    db.article.findMany({ where: { shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: PICKER_CAP }),
    db.page.findMany({ where: { shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: PICKER_CAP }),
  ]);

  const pickers: Record<KeywordResourceType, PickerItem[]> = {
    Product: products,
    Collection: collections,
    Article: articles,
    Page: pages,
  };

  return json({ keywords, pickers });
};

type ActionResult = { ok: true; kind: "saved" | "deleted" } | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const form = await request.formData();
  const actionType = getFormString(form, "actionType");

  if (actionType === "setKeyword") {
    const resourceType = getFormString(form, "resourceType") as KeywordResourceType;
    const resourceId = getFormString(form, "resourceId");
    const keyword = getFormString(form, "keyword");
    if (!RESOURCE_TYPES.includes(resourceType) || !resourceId || !keyword.trim()) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    await setKeyword(db, session.shop, { resourceType, resourceId, keyword });
    return json<ActionResult>({ ok: true, kind: "saved" });
  }

  if (actionType === "deleteKeyword") {
    const id = getFormString(form, "id");
    if (id) await deleteKeyword(db, session.shop, id);
    return json<ActionResult>({ ok: true, kind: "deleted" });
  }

  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

const DENSITY_TONE: Record<DensityBand, "success" | "warning" | "critical" | undefined> = {
  ok: "success",
  low: "warning",
  high: "critical",
  none: undefined,
};

export default function SeoKeywords() {
  const { keywords, pickers } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const k = (t.seo as any).keywordsPage;

  const saveFetcher = useFetcher<ActionResult>();
  const rowFetcher = useFetcher<ActionResult>();

  const [type, setType] = useState<KeywordResourceType>("Product");
  const [itemId, setItemId] = useState("");
  const [keyword, setKeywordInput] = useState("");

  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.ok && saveFetcher.data.kind === "saved") {
      setKeywordInput("");
      setItemId("");
    }
  }, [saveFetcher.state, saveFetcher.data]);

  const items = pickers[type] ?? [];
  const itemOptions = [
    { label: k.selectItem, value: "" },
    ...items.map((i) => ({ label: i.title || i.id, value: i.id })),
  ];
  const typeOptions = RESOURCE_TYPES.map((rt) => ({ label: k.types[rt], value: rt }));

  const canSave = !!itemId && !!keyword.trim();

  return (
    <SeoSectionLayout sectionId="keywords">
      <BlockStack gap="400">
        {/* Add keyword */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {k.addTitle}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {k.intro}
            </Text>
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ minWidth: "140px" }}>
                <Select
                  label={k.typeLabel}
                  options={typeOptions}
                  value={type}
                  onChange={(v) => {
                    setType(v as KeywordResourceType);
                    setItemId("");
                  }}
                />
              </div>
              <div style={{ flex: "1 1 240px" }}>
                <Select label={k.itemLabel} options={itemOptions} value={itemId} onChange={setItemId} />
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <TextField
                  label={k.keywordLabel}
                  autoComplete="off"
                  placeholder={k.keywordPlaceholder}
                  value={keyword}
                  onChange={setKeywordInput}
                />
              </div>
              <Button
                variant="primary"
                disabled={!canSave}
                loading={saveFetcher.state !== "idle"}
                onClick={() =>
                  saveFetcher.submit(
                    { actionType: "setKeyword", resourceType: type, resourceId: itemId, keyword },
                    { method: "post" },
                  )
                }
              >
                {k.addButton}
              </Button>
            </InlineStack>
            {items.length >= PICKER_CAP && (
              <Text as="p" variant="bodySm" tone="subdued">
                {k.pickerCapped.replace("{cap}", String(PICKER_CAP))}
              </Text>
            )}
          </BlockStack>
        </Card>

        {/* Tracked keywords */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {k.listTitle}
            </Text>
            {rowFetcher.data && !rowFetcher.data.ok && <Banner tone="critical">{k.errorGeneric}</Banner>}

            {keywords.length === 0 ? (
              <Text as="p" tone="subdued">
                {k.noKeywords}
              </Text>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{k.colItem}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{k.colKeyword}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{k.colScore}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{k.colDensity}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{k.colPresence}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.map((row) => (
                      <tr key={row.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                        <td style={{ padding: "6px 8px", maxWidth: "240px" }}>
                          <Text as="span" variant="bodyMd" truncate>
                            {row.itemMissing ? k.itemMissing : row.itemTitle || row.resourceId}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {" "}
                            {k.types[row.resourceType as KeywordResourceType] || row.resourceType}
                          </Text>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Text as="span" variant="bodyMd">{row.keyword}</Text>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Badge tone={scoreTone(row.score) as any}>{String(row.score)}</Badge>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Badge tone={DENSITY_TONE[row.densityBand as DensityBand]}>
                            {`${k.density[row.densityBand]} (${row.densityPct}%)`}
                          </Badge>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <InlineStack gap="100" wrap>
                            {(["title", "h1", "metaDescription", "seoTitle", "body"] as const).map((key) => (
                              <Badge key={key} tone={row.presence[key] ? "success" : undefined}>
                                {k.presence[key]}
                              </Badge>
                            ))}
                          </InlineStack>
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          <Button
                            variant="plain"
                            tone="critical"
                            onClick={() =>
                              rowFetcher.submit(
                                { actionType: "deleteKeyword", id: row.id },
                                { method: "post" },
                              )
                            }
                          >
                            {k.delete}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </SeoSectionLayout>
  );
}
