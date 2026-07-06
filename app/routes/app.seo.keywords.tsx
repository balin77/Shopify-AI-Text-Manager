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
import { useEffect, useMemo, useState } from "react";
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
  IndexTable,
  Autocomplete,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useConfirm } from "../contexts/ConfirmContext";
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
      // Product/Collection H1s come from the title (themes render it as the
      // page H1); Article/Page may also carry an explicit <h1> in the body.
      resourceType: row.resourceType as KeywordResourceType,
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

/** Editor list route per resource type — target of the row's "open in editor" deep-link. */
const KEYWORD_TYPE_PATH: Record<KeywordResourceType, string> = {
  Product: "/app/products",
  Collection: "/app/collections",
  Article: "/app/blog",
  Page: "/app/pages",
};

export default function SeoKeywords() {
  const { keywords, pickers } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const confirm = useConfirm();
  const k = (t.seo as any).keywordsPage;

  const saveFetcher = useFetcher<ActionResult>();
  const rowFetcher = useFetcher<ActionResult>();

  const [type, setType] = useState<KeywordResourceType>("Product");
  const [itemId, setItemId] = useState("");
  // Text typed into the item Autocomplete's TextField — separate from itemId
  // so the field can show a human-readable label while itemId stores the id.
  const [itemInputValue, setItemInputValue] = useState("");
  const [keyword, setKeywordInput] = useState("");
  // Which row's delete is in flight — the rowFetcher is shared across rows,
  // so this is what lets us spinner the right button and disable the rest.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.ok && saveFetcher.data.kind === "saved") {
      setKeywordInput("");
      setItemId("");
      setItemInputValue("");
    }
  }, [saveFetcher.state, saveFetcher.data]);

  useEffect(() => {
    if (rowFetcher.state === "idle") setPendingDeleteId(null);
  }, [rowFetcher.state]);

  const handleDeleteKeyword = async (row: { id: string; keyword: string }) => {
    const ok = await confirm({
      title: k.deleteConfirmTitle || "Stop tracking this keyword?",
      message:
        k.deleteConfirmBody ||
        `This will remove "${row.keyword}" from tracked keywords. This can't be undone.`,
      confirmLabel: k.delete,
      destructive: true,
    });
    if (!ok) return;
    setPendingDeleteId(row.id);
    rowFetcher.submit({ actionType: "deleteKeyword", id: row.id }, { method: "post" });
  };

  const items = pickers[type] ?? [];
  // Full option list for the current type (Autocomplete filters this client-side
  // as the merchant types — no "select an item" placeholder entry needed since
  // an empty text field naturally shows every loaded item).
  const itemOptions = useMemo(
    () => items.map((i) => ({ label: i.title || i.id, value: i.id })),
    [items],
  );
  const filteredItemOptions = useMemo(() => {
    const q = itemInputValue.trim().toLowerCase();
    if (!q) return itemOptions;
    return itemOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [itemOptions, itemInputValue]);
  const typeOptions = RESOURCE_TYPES.map((rt) => ({ label: k.types[rt], value: rt }));

  const canSave = !!itemId && !!keyword.trim();

  const openInEditor = (row: { resourceType: string; resourceId: string }) => {
    const path = KEYWORD_TYPE_PATH[row.resourceType as KeywordResourceType];
    if (!path) return;
    handleNavigate(path, { searchParams: new URLSearchParams({ select: row.resourceId }) });
  };

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
                    setItemInputValue("");
                  }}
                />
              </div>
              <div style={{ flex: "1 1 240px" }}>
                <Autocomplete
                  options={filteredItemOptions}
                  selected={itemId ? [itemId] : []}
                  onSelect={(selected) => {
                    const id = selected[0] ?? "";
                    setItemId(id);
                    const match = itemOptions.find((o) => o.value === id);
                    setItemInputValue(match ? match.label : "");
                  }}
                  textField={
                    <Autocomplete.TextField
                      label={k.itemLabel}
                      autoComplete="off"
                      placeholder={k.selectItem}
                      value={itemInputValue}
                      onChange={(value) => {
                        setItemInputValue(value);
                        // Typing invalidates the previously selected id until a
                        // new option is chosen from the (re-filtered) list.
                        if (itemId) setItemId("");
                      }}
                    />
                  }
                />
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
              <BlockStack gap="200">
                <IndexTable
                  itemCount={keywords.length}
                  selectable={false}
                  headings={[
                    { title: k.colItem },
                    { title: k.colKeyword },
                    { title: k.colScore },
                    { title: k.colDensity },
                    { title: k.colPresence },
                    { title: k.colGscPosition },
                    { title: "" },
                  ]}
                >
                  {keywords.map((row, index) => (
                    <IndexTable.Row id={row.id} key={row.id} position={index}>
                      <IndexTable.Cell>
                        <div style={{ maxWidth: "240px" }}>
                          <Text as="span" variant="bodyMd" truncate>
                            {row.itemMissing ? k.itemMissing : row.itemTitle || row.resourceId}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {" "}
                            {k.types[row.resourceType as KeywordResourceType] || row.resourceType}
                          </Text>
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">{row.keyword}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={scoreTone(row.score) as any}>{String(row.score)}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={DENSITY_TONE[row.densityBand as DensityBand]}>
                          {`${k.density[row.densityBand]} (${row.densityPct}%)`}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="100" wrap>
                          {(["title", "h1", "metaDescription", "seoTitle", "body"] as const).map((key) => (
                            <Badge key={key} tone={row.presence[key] ? "success" : undefined}>
                              {k.presence[key]}
                            </Badge>
                          ))}
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd" tone={row.gscPosition == null ? "subdued" : undefined}>
                          {row.gscPosition == null ? "–" : row.gscPosition.toFixed(1)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200" align="end" wrap={false}>
                          <Button
                            variant="plain"
                            onClick={() => openInEditor(row)}
                            disabled={row.itemMissing}
                          >
                            {k.openInEditor}
                          </Button>
                          <Button
                            variant="plain"
                            tone="critical"
                            loading={rowFetcher.state !== "idle" && pendingDeleteId === row.id}
                            disabled={rowFetcher.state !== "idle" && pendingDeleteId !== row.id}
                            onClick={() => handleDeleteKeyword(row)}
                          >
                            {k.delete}
                          </Button>
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
                <Text as="p" variant="bodySm" tone="subdued">
                  {k.gscHint}
                </Text>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </SeoSectionLayout>
  );
}
