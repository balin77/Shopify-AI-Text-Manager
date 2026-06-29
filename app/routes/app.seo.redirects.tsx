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
  const { redirects, hasNextPage, endCursor, q, hits } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const r = (t.seo as any).redirectsPage;

  const createFetcher = useFetcher<ActionResult>();
  const rowFetcher = useFetcher<ActionResult>();

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState(q);
  const [hitTargets, setHitTargets] = useState<Record<string, string>>({});

  // Clear the create form once a creation succeeds.
  useEffect(() => {
    if (createFetcher.state === "idle" && createFetcher.data?.ok && createFetcher.data.kind === "created") {
      setFrom("");
      setTo("");
    }
  }, [createFetcher.state, createFetcher.data]);

  const createError =
    createFetcher.data && !createFetcher.data.ok
      ? r.errors[createFetcher.data.error] || r.errors.createFailed
      : null;

  // Row actions (create-from-404 / dismiss) report failures through rowFetcher;
  // surface them too, otherwise a rejected create (e.g. empty target) is silent.
  const rowError =
    rowFetcher.data && !rowFetcher.data.ok
      ? r.errors[rowFetcher.data.error] || r.errors.createFailed
      : null;

  const submitSearch = () => {
    handleNavigate("/app/seo/redirects", { searchParams: new URLSearchParams(search ? { q: search } : {}) });
  };

  const loadMore = () => {
    const params: Record<string, string> = {};
    if (q) params.q = q;
    if (endCursor) params.after = endCursor;
    handleNavigate("/app/seo/redirects", { searchParams: new URLSearchParams(params) });
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
            {redirects.length === 0 ? (
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
                    {redirects.map((redirect) => (
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
                            onClick={() =>
                              rowFetcher.submit(
                                { actionType: "deleteRedirect", id: redirect.id },
                                { method: "post" },
                              )
                            }
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

            {hasNextPage && (
              <InlineStack align="center">
                <Button onClick={loadMore}>{r.loadMore}</Button>
              </InlineStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </SeoSectionLayout>
  );
}
