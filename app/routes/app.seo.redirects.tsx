/**
 * Redirects & 404 section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 3 / A4).
 *
 * - Native URL redirect management via the Admin API (list/create/delete),
 *   paginated + searchable.
 * - A "frequent 404s" panel fed by the self-hosted Seo404Hit collector, with a
 *   one-click "create redirect" that prefills the missing path and marks the
 *   hit redirected.
 *
 * All writes go through the route action; the page uses fetchers so it stays put.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  TextField,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useConfirm } from "../contexts/ConfirmContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import {
  listRedirects,
  createRedirect,
  deleteRedirect,
  list404Hits,
  set404Status,
  validateRedirect,
} from "../services/seo/redirects.service";
import { getFormString } from "../utils/form-data.utils";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const after = url.searchParams.get("after") || null;

  const [redirectsResult, hits] = await Promise.all([
    listRedirects(admin, { first: 50, after, query: q }),
    list404Hits(db, session.shop, { status: "new", limit: 100 }),
  ]);

  return json({
    redirects: redirectsResult.redirects,
    hasNextPage: redirectsResult.hasNextPage,
    endCursor: redirectsResult.endCursor,
    q,
    hits,
  });
};

type ActionResult =
  | { ok: true; kind: "created" | "deleted" | "dismissed" }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const form = await request.formData();
  const actionType = getFormString(form, "actionType");

  if (actionType === "createRedirect" || actionType === "createFromHit") {
    const path = getFormString(form, "path");
    const target = getFormString(form, "target");
    const err = validateRedirect({ path, target });
    if (err) return json<ActionResult>({ ok: false, error: err }, { status: 400 });

    const res = await createRedirect(admin, { path, target });
    if (res.userErrors.length > 0 || !res.redirect) {
      return json<ActionResult>({ ok: false, error: "createFailed" }, { status: 400 });
    }
    if (actionType === "createFromHit") {
      const hitId = getFormString(form, "hitId");
      if (hitId) await set404Status(db, session.shop, hitId, "redirected");
    }
    return json<ActionResult>({ ok: true, kind: "created" });
  }

  if (actionType === "deleteRedirect") {
    const id = getFormString(form, "id");
    if (id) await deleteRedirect(admin, id);
    return json<ActionResult>({ ok: true, kind: "deleted" });
  }

  if (actionType === "dismiss404") {
    const hitId = getFormString(form, "hitId");
    if (hitId) await set404Status(db, session.shop, hitId, "dismissed");
    return json<ActionResult>({ ok: true, kind: "dismissed" });
  }

  return json<ActionResult>({ ok: false, error: "createFailed" }, { status: 400 });
};

export default function SeoRedirects() {
  const {
    redirects: loaderRedirects,
    hasNextPage: loaderHasNextPage,
    endCursor: loaderEndCursor,
    q,
    hits,
  } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const confirm = useConfirm();
  const r = (t.seo as any).redirectsPage;

  const createFetcher = useFetcher<ActionResult>();
  const rowFetcher = useFetcher<ActionResult>();
  // Dedicated fetcher for "Load more" — GET requests to the same loader, kept
  // separate from rowFetcher (used for 404-hit row actions/deletes) so paging
  // never cancels/gets cancelled by an unrelated row action.
  const loadMoreFetcher = useFetcher<typeof loader>();

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState(q);
  const [hitTargets, setHitTargets] = useState<Record<string, string>>({});

  // Client-side accumulated redirect list so "Load more" appends a page
  // instead of the navigation replacing it. Re-synced to the server's first
  // page whenever the loader re-runs (new search, or a mutation revalidated
  // this route) — otherwise stale/deleted rows could linger in the list.
  const [items, setItems] = useState(loaderRedirects);
  const [cursor, setCursor] = useState(loaderEndCursor);
  const [hasMore, setHasMore] = useState(loaderHasNextPage);
  // Which row's delete is in flight — lets the shared rowFetcher show a
  // spinner on the correct button instead of every row reacting the same way.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    setItems(loaderRedirects);
    setCursor(loaderEndCursor);
    setHasMore(loaderHasNextPage);
  }, [loaderRedirects, loaderEndCursor, loaderHasNextPage]);

  // Append the next page once the load-more fetcher resolves.
  useEffect(() => {
    if (loadMoreFetcher.state === "idle" && loadMoreFetcher.data) {
      const data = loadMoreFetcher.data;
      setItems((prev) => [...prev, ...data.redirects]);
      setCursor(data.endCursor);
      setHasMore(data.hasNextPage);
    }
  }, [loadMoreFetcher.state, loadMoreFetcher.data]);

  // Clear the create form once a creation succeeds.
  useEffect(() => {
    if (createFetcher.state === "idle" && createFetcher.data?.ok && createFetcher.data.kind === "created") {
      setFrom("");
      setTo("");
    }
  }, [createFetcher.state, createFetcher.data]);

  // rowFetcher going idle means whatever row action was in flight finished.
  useEffect(() => {
    if (rowFetcher.state === "idle") setPendingDeleteId(null);
  }, [rowFetcher.state]);

  const createError =
    createFetcher.data && !createFetcher.data.ok
      ? r.errors[createFetcher.data.error] || r.errors.createFailed
      : null;

  // Row actions (create-from-404 / dismiss / delete) report failures through
  // rowFetcher; surface them too, otherwise a rejected action is silent.
  const rowError =
    rowFetcher.data && !rowFetcher.data.ok
      ? r.errors[rowFetcher.data.error] || r.errors.createFailed
      : null;

  const submitSearch = () => {
    const params = new URLSearchParams();
    // Always set q explicitly (even empty) so clearing the field actually
    // clears a previously-searched term instead of handleNavigate carrying
    // the stale one over from the current URL. Always drop "after" too, so a
    // new search never starts from a stale pagination cursor.
    params.set("q", search);
    params.set("after", "");
    handleNavigate("/app/seo/redirects", { searchParams: params });
  };

  const loadMore = () => {
    if (!cursor) return;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("after", cursor);
    loadMoreFetcher.load(`/app/seo/redirects?${params.toString()}`);
  };

  const handleDeleteRedirect = async (redirect: { id: string; path: string }) => {
    const ok = await confirm({
      title: r.deleteConfirmTitle || "Delete this redirect?",
      message:
        r.deleteConfirmBody ||
        `This will permanently delete the redirect from "${redirect.path}". This can't be undone.`,
      confirmLabel: r.deleteButton,
      destructive: true,
    });
    if (!ok) return;
    setPendingDeleteId(redirect.id);
    rowFetcher.submit({ actionType: "deleteRedirect", id: redirect.id }, { method: "post" });
  };

  return (
    <SeoSectionLayout sectionId="redirects">
      <BlockStack gap="400">
        {/* Frequent 404s */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {r.fourOhFourTitle}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {r.fourOhFourIntro}
            </Text>
            {rowError && <Banner tone="critical">{rowError}</Banner>}

            {hits.length === 0 ? (
              <Text as="p" tone="subdued">
                {r.no404s}
              </Text>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{r.hitPathColumn}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{r.hitCountColumn}</Text>
                      </th>
                      <th style={{ padding: "6px 8px", minWidth: "260px" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {hits.map((hit) => (
                      <tr key={hit.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                        <td style={{ padding: "6px 8px", maxWidth: "300px" }}>
                          <Text as="span" variant="bodyMd" truncate>
                            {hit.path}
                          </Text>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Text as="span" variant="bodySm">{hit.count}</Text>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <InlineStack gap="200" blockAlign="center" wrap={false}>
                            <div style={{ flex: 1, minWidth: "140px" }}>
                              <TextField
                                label=""
                                labelHidden
                                autoComplete="off"
                                placeholder={r.targetForHitPlaceholder}
                                value={hitTargets[hit.id] ?? ""}
                                onChange={(v) => setHitTargets((m) => ({ ...m, [hit.id]: v }))}
                              />
                            </div>
                            <Button
                              variant="primary"
                              size="slim"
                              disabled={!(hitTargets[hit.id] ?? "").trim()}
                              onClick={() =>
                                rowFetcher.submit(
                                  {
                                    actionType: "createFromHit",
                                    path: hit.path,
                                    target: hitTargets[hit.id] ?? "",
                                    hitId: hit.id,
                                  },
                                  { method: "post" },
                                )
                              }
                            >
                              {r.createRedirectFromHit}
                            </Button>
                            <Button
                              size="slim"
                              onClick={() =>
                                rowFetcher.submit(
                                  { actionType: "dismiss404", hitId: hit.id },
                                  { method: "post" },
                                )
                              }
                            >
                              {r.dismiss}
                            </Button>
                          </InlineStack>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </BlockStack>
        </Card>

        {/* Create redirect */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {r.redirectsTitle}
            </Text>
            {createError && <Banner tone="critical">{createError}</Banner>}
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ flex: "1 1 200px" }}>
                <TextField
                  label={r.fromLabel}
                  autoComplete="off"
                  placeholder={r.fromPlaceholder}
                  value={from}
                  onChange={setFrom}
                />
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <TextField
                  label={r.toLabel}
                  autoComplete="off"
                  placeholder={r.toPlaceholder}
                  value={to}
                  onChange={setTo}
                />
              </div>
              <Button
                variant="primary"
                loading={createFetcher.state !== "idle"}
                onClick={() =>
                  createFetcher.submit(
                    { actionType: "createRedirect", path: from, target: to },
                    { method: "post" },
                  )
                }
              >
                {r.createButton}
              </Button>
            </InlineStack>

            {/* Search */}
            <InlineStack gap="200" blockAlign="end">
              <div style={{ flex: 1 }}>
                <TextField
                  label=""
                  labelHidden
                  autoComplete="off"
                  placeholder={r.searchPlaceholder}
                  value={search}
                  onChange={setSearch}
                />
              </div>
              <Button onClick={submitSearch}>{r.searchButton}</Button>
            </InlineStack>

            {/* Redirect list */}
            {items.length === 0 ? (
              <Text as="p" tone="subdued">
                {r.noRedirects}
              </Text>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{r.pathColumn}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{r.targetColumn}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((redirect) => (
                      <tr key={redirect.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                        <td style={{ padding: "6px 8px", maxWidth: "280px" }}>
                          <Text as="span" variant="bodyMd" truncate>{redirect.path}</Text>
                        </td>
                        <td style={{ padding: "6px 8px", maxWidth: "280px" }}>
                          <Text as="span" variant="bodyMd" truncate>{redirect.target}</Text>
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          <Button
                            variant="plain"
                            tone="critical"
                            loading={rowFetcher.state !== "idle" && pendingDeleteId === redirect.id}
                            disabled={rowFetcher.state !== "idle" && pendingDeleteId !== redirect.id}
                            onClick={() => handleDeleteRedirect(redirect)}
                          >
                            {r.deleteButton}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {hasMore && (
              <InlineStack align="center">
                <Button onClick={loadMore} loading={loadMoreFetcher.state !== "idle"}>
                  {r.loadMore}
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </SeoSectionLayout>
  );
}
