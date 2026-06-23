/**
 * Cookie-Banner rubric (Plan §7.5) — part of "Online Store", entitled to all
 * tiers (same as onlineStoreExtras).
 *
 * COOKIE_BANNER lives only in Shopify's `unstable` TranslatableResourceType enum
 * today, so this rubric auto-degrades: the loader asks the availability cache and
 * renders either the editor (when reachable) or a "Coming Soon" placeholder. When
 * Shopify promotes the resource, the editor lights up with no deploy needed.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Banner,
  Select,
  TextField,
  Button,
  Badge,
  EmptyState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import { getFormString } from "../utils/form-data.utils";
import { safeJsonParse } from "../utils/validation";
import {
  getCookieBannerAvailability,
  getCookieBannerResources,
  writeCookieBannerTranslations,
  type CookieBannerResource,
} from "../utils/cookie-banner-availability.server";

interface LoaderData {
  available: boolean;
  primaryLocale: string;
  locales: Array<{ locale: string; name: string }>;
  resources: CookieBannerResource[];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const cbSession = { shop: session.shop, accessToken: session.accessToken };

  const availability = await getCookieBannerAvailability(cbSession);
  if (availability !== "available") {
    return json<LoaderData>({ available: false, primaryLocale: "", locales: [], resources: [] });
  }

  const [resources, shopLocales] = await Promise.all([
    getCookieBannerResources(cbSession),
    getCachedShopLocales(admin, session.shop),
  ]);

  // getCookieBannerResources flips availability to "unavailable" (returns null)
  // if the content fetch failed between the probe and now.
  if (resources === null) {
    return json<LoaderData>({ available: false, primaryLocale: "", locales: [], resources: [] });
  }

  const primary = shopLocales.find((l) => l.primary)?.locale ?? "";
  const locales = shopLocales
    .filter((l) => !l.primary)
    .map((l) => ({ locale: l.locale, name: l.name ?? l.locale }));

  return json<LoaderData>({ available: true, primaryLocale: primary, locales, resources });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const cbSession = { shop: session.shop, accessToken: session.accessToken };
  const formData = await request.formData();

  const resourceId = getFormString(formData, "resourceId");
  const locale = getFormString(formData, "locale");
  const fields = safeJsonParse<Record<string, string>>(getFormString(formData, "fields"), {});
  if (!resourceId || !locale) {
    return json({ ok: false, error: "Missing resourceId or locale" }, { status: 400 });
  }

  // Pre-flight: status may have flipped to unavailable since the loader ran.
  const availability = await getCookieBannerAvailability(cbSession);
  if (availability !== "available") {
    return json({ ok: false, unavailable: true }, { status: 200 });
  }

  // Re-fetch fresh digests (Shopify rejects translationsRegister with a stale digest).
  const resources = await getCookieBannerResources(cbSession);
  if (resources === null) {
    return json({ ok: false, unavailable: true }, { status: 200 });
  }
  const digestByKey = new Map<string, string>();
  for (const r of resources) {
    if (r.resourceId !== resourceId) continue;
    for (const c of r.translatableContent) if (c.digest) digestByKey.set(c.key, c.digest);
  }

  const translations = Object.entries(fields)
    .filter(([key, value]) => value.trim().length > 0 && digestByKey.has(key))
    .map(([key, value]) => ({
      key,
      value,
      locale,
      translatableContentDigest: digestByKey.get(key)!,
    }));

  const result = await writeCookieBannerTranslations(cbSession, resourceId, translations);
  return json(result, { status: 200 });
}

export default function CookieBannerPage() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const c = t.content as unknown as Record<string, string>;

  if (!data.available) {
    return (
      <Page title={c.cookieBanner || "Cookie banner"}>
        <Card>
          <EmptyState
            heading={c.cookieBannerComingSoon || "Cookie banner — coming soon"}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>{c.cookieBannerComingSoonDescription || ""}</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  return (
    <Page title={c.cookieBanner || "Cookie banner"} subtitle={c.cookieBannerDescription || ""}>
      <BlockStack gap="400">
        {data.resources.length === 0 ? (
          <Card>
            <Text as="p" tone="subdued">
              {c.cookieBannerNoContent || "No cookie-banner content found for this shop."}
            </Text>
          </Card>
        ) : (
          data.resources.map((resource) => (
            <CookieBannerResourceCard
              key={resource.resourceId}
              resource={resource}
              primaryLocale={data.primaryLocale}
              locales={data.locales}
              labels={c}
            />
          ))
        )}
      </BlockStack>
    </Page>
  );
}

function CookieBannerResourceCard({
  resource,
  primaryLocale,
  locales,
  labels,
}: {
  resource: CookieBannerResource;
  primaryLocale: string;
  locales: Array<{ locale: string; name: string }>;
  labels: Record<string, string>;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string; unavailable?: boolean }>();
  const [targetLocale, setTargetLocale] = useState(locales[0]?.locale ?? "");
  const [values, setValues] = useState<Record<string, string>>({});

  const editableKeys = resource.translatableContent.filter((c) => c.value && c.value.trim().length > 0);
  const saving = fetcher.state !== "idle";

  const save = () => {
    fetcher.submit(
      { resourceId: resource.resourceId, locale: targetLocale, fields: JSON.stringify(values) },
      { method: "post" }
    );
  };

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            🍪 {resource.resourceId.split("/").pop()}
          </Text>
          {locales.length > 0 && (
            <div style={{ minWidth: 200 }}>
              <Select
                label={labels.cookieBannerTargetLocale || "Translate into"}
                labelHidden
                options={locales.map((l) => ({ label: l.name, value: l.locale }))}
                value={targetLocale}
                onChange={setTargetLocale}
              />
            </div>
          )}
        </InlineStack>

        {locales.length === 0 ? (
          <Banner tone="info">{labels.cookieBannerNoLocales || "Add a second language to translate the cookie banner."}</Banner>
        ) : (
          <>
            {editableKeys.map((field) => (
              <TextField
                key={field.key}
                label={
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodySm" tone="subdued">{field.key}</Text>
                    <Badge tone="info">{primaryLocale || "source"}</Badge>
                  </InlineStack>
                }
                autoComplete="off"
                multiline
                helpText={field.value ?? undefined}
                value={values[field.key] ?? ""}
                onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
              />
            ))}

            {fetcher.data?.ok && (
              <Banner tone="success">{labels.cookieBannerSaved || "Saved."}</Banner>
            )}
            {fetcher.data && fetcher.data.ok === false && fetcher.data.unavailable && (
              <Banner tone="warning">{labels.cookieBannerComingSoonDescription || "Temporarily unavailable."}</Banner>
            )}
            {fetcher.data && fetcher.data.ok === false && !fetcher.data.unavailable && (
              <Banner tone="critical">{fetcher.data.error || "Error"}</Banner>
            )}

            <InlineStack align="end">
              <Button variant="primary" loading={saving} onClick={save} disabled={!targetLocale}>
                {labels.cookieBannerSave || "Save translation"}
              </Button>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}
