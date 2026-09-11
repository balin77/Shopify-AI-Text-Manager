/**
 * The install page: one field, and it hands the merchant to Shopify.
 *
 * `/auth/login?shop=<domain>` is this app's OAuth entrance — it redirects to
 * `/auth`, which is where `authenticate.admin` starts the install. It needs a
 * well-formed `<name>.myshopify.com` and fails opaquely on anything else, so
 * the form NORMALIZES first (see marketing-shop-domain.shared.ts) and says
 * what to type when it cannot.
 *
 * Server-side, in an `action`: it works with no JavaScript, and the refusal
 * messages come back from the one function that also decides the redirect, so
 * the two can never disagree about what counts as a valid store.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import { buildMarketingMeta } from "../utils/marketing-meta";
import { requireMarketingLocale } from "../utils/marketing-route.server";
import { normalizeShopDomain } from "../services/marketing-shop-domain.shared";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const locale = requireMarketingLocale(params.lang, "/install", url.search);
  return { locale, origin: url.origin, appStoreUrl: MARKETING_SITE.appStoreUrl };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const result = normalizeShopDomain(String(form.get("shop") ?? ""));

  if (!result.ok) {
    // The typed value travels back: WITHOUT JavaScript a refused submit is a
    // full page render, so a field with no defaultValue comes back empty and
    // the merchant retypes their address to read the message about it.
    return { reason: result.reason, value: String(form.get("shop") ?? "") };
  }

  // Leaves the marketing site for this app's OAuth entrance, which sends the
  // merchant on to Shopify's own permission screen.
  throw redirect(`/auth/login?shop=${encodeURIComponent(result.shop)}`);
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: "/install",
    title: `${t.install.title} — ${t.site.name}`,
    description: t.install.intro,
    siteName: t.site.name,
  });
};

export default function MarketingInstall() {
  const { locale, appStoreUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const t = getMarketingTranslation(locale);

  const errorMessage =
    actionData?.reason === "empty"
      ? t.install.errors.empty
      : actionData?.reason === "custom-domain"
        ? t.install.errors.customDomain
        : actionData?.reason === "invalid"
          ? t.install.errors.invalid
          : null;

  return (
    <section className="mk-section">
      <div className="mk-shell mk-install">
        <div className="mk-section__head">
          <h1>{t.install.title}</h1>
          <p className="mk-lead">{t.install.intro}</p>
        </div>

        <Form method="post" className="mk-form">
          <label className="mk-field" htmlFor="shop">
            <span className="mk-field__label">{t.install.label}</span>
            <input
              id="shop"
              name="shop"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              defaultValue={actionData?.value ?? ""}
              placeholder={t.install.placeholder}
              aria-describedby={errorMessage ? "shop-error" : "shop-help"}
              aria-invalid={errorMessage ? true : undefined}
            />
          </label>

          {errorMessage ? (
            <p className="mk-field__error" id="shop-error" role="alert">
              {errorMessage}
            </p>
          ) : (
            <p className="mk-note" id="shop-help">
              {t.install.help}
            </p>
          )}

          <button
            type="submit"
            className="mk-btn mk-btn--primary"
            /* `!== "idle"` and not `=== "submitting"`: react-router moves to
               "loading" while it follows the redirect, so the narrower test
               re-enabled the button mid-handoff and a second click would begin
               a SECOND OAuth whose state cookie clobbers the first. */
            disabled={navigation.state !== "idle"}
          >
            {t.install.submit}
          </button>
        </Form>

        {appStoreUrl ? (
          <p className="mk-note">
            {t.install.appStoreHint}{" "}
            <a href={appStoreUrl}>{t.install.appStoreLink}</a>
          </p>
        ) : null}
      </div>
    </section>
  );
}
