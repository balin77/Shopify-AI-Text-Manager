/**
 * Redirect × Locale-Prefix Probe — PLAN_CONTENT_CREATION §Phase 3.3, open
 * question 3.
 *
 * ── The question, precisely ────────────────────────────────────────────────
 * Shopify's URL redirects are PATH-based: a row says `/products/old` →
 * `/products/new`. A translating shop serves the same product under a locale
 * prefix as well — `/es/products/old`. Does the redirect apply there too, or
 * is the prefixed path a different path as far as the redirect table is
 * concerned?
 *
 * Nothing in the docs or in this codebase answers it, and the answer decides
 * whether bulk-translate's foreign-handle column can create redirects at all.
 * Guessing would produce rows nobody can verify — which is why that path
 * currently creates none.
 *
 * ── How this measures it ───────────────────────────────────────────────────
 * A throwaway redirect from a path that cannot collide with anything real,
 * pointing at the shop's home page. Then two fetches against the shop's
 * PRIMARY domain (never the myshopify host — Shopify 301s that one first and
 * the extra hop would muddy every reading):
 *
 *   1. `https://<host><probePath>`             — the control. If this does not
 *                                                redirect, nothing below means
 *                                                anything and the probe says so.
 *   2. `https://<host>/<locale><probePath>`    — the actual question.
 *
 * TWO questions, not one: does a prefixed path match a redirect at all, and
 * does the TARGET keep the prefix. The second decides whether one unprefixed
 * row can serve every locale or whether each locale needs its own, so the
 * target is a distinctive path — with "/" the two answers are indistinguishable.
 *
 * Redirects are NOT followed: the interesting evidence is the first response's
 * status and `Location`, and following would hide a 404 behind a 200.
 *
 * The probe row is deleted in a `finally`, so a failed run does not leave a
 * redirect behind in the merchant's list.
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { db } from "~/db.server";
import { fetchPrimaryDomain } from "~/utils/shop-domain.server";
import { createRedirect, deleteRedirect } from "~/services/seo/redirects.service";
import { meetsPlan } from "~/utils/planUtils";

interface Hop {
  url: string;
  status: number | null;
  location: string | null;
  error?: string;
}

export interface RedirectLocaleProbeReport {
  generatedAt: string;
  shop: string;
  primaryDomain: string;
  locale: string | null;
  probePath: string;
  target: string;
  redirectCreated: boolean;
  control: Hop;
  prefixed: Hop | null;
  verdict: string[];
}

/** Non-redirecting fetch — the first response IS the evidence. */
async function probeOnce(url: string): Promise<Hop> {
  try {
    const response = await fetch(url, { redirect: "manual", headers: { "User-Agent": "ContentPilot-RedirectProbe" } });
    return { url, status: response.status, location: response.headers.get("location") };
  } catch (error) {
    return { url, status: null, location: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export const action = async (args: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);

  // Directly POST-reachable, so the gate lives here — same class as the
  // /api/ai handlers and the CSV exports.
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  if (!meetsPlan((settings?.subscriptionPlan || "free") as never, "pro")) {
    return json({ error: "gated" }, { status: 403 });
  }

  const primaryDomain = await fetchPrimaryDomain(admin as never, session.shop);

  // A published NON-primary locale. Without one there is no prefixed URL to
  // ask about, and the probe says that rather than inventing a locale.
  const localesResponse = await admin.graphql(
    `#graphql
      query redirectProbeLocales { shopLocales { locale primary published } }`,
  );
  const localesData = (await localesResponse.json()) as {
    data?: { shopLocales?: Array<{ locale: string; primary: boolean; published: boolean }> };
  };
  const locale =
    localesData.data?.shopLocales?.find((l) => !l.primary && l.published)?.locale ?? null;

  // Deliberately unguessable and deliberately not under /products/ — the point
  // is to test the redirect table, not to collide with a real resource whose
  // own 200 would mask the answer.
  const probePath = `/contentpilot-redirect-probe-${Math.random().toString(36).slice(2, 10)}`;
  // The target must be DISTINCTIVE, and "/" is the one value that cannot be.
  //
  // The first run used "/", and the prefixed hop came back `Location: /en/`.
  // That looks like "Shopify carried the prefix onto the target" — but it is
  // exactly what a plain locale-root normalisation would look like too, so the
  // run proved the redirect MATCHES under a prefix and left the target
  // question open. A path nothing else could produce settles it: the Location
  // is either `/<locale><target>` or `<target>`, and nothing else.
  const target = `/contentpilot-redirect-target-${Math.random().toString(36).slice(2, 10)}`;

  const report: RedirectLocaleProbeReport = {
    generatedAt: new Date().toISOString(),
    shop: session.shop,
    primaryDomain,
    locale,
    probePath,
    target,
    redirectCreated: false,
    control: { url: "", status: null, location: null },
    prefixed: null,
    verdict: [],
  };

  let redirectId: string | null = null;
  try {
    const created = await createRedirect(admin, { path: probePath, target });
    redirectId = created.redirect?.id ?? null;
    report.redirectCreated = !!redirectId;
    if (!redirectId) {
      report.verdict.push(
        `Shopify did not confirm the probe redirect (${created.userErrors?.map((e) => e.message).join("; ") || "no id returned"}). Nothing could be measured.`,
      );
      return json({ report });
    }

    // Shopify needs a moment before a fresh redirect is served by the CDN.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    report.control = await probeOnce(`https://${primaryDomain}${probePath}`);
    if (locale) {
      report.prefixed = await probeOnce(`https://${primaryDomain}/${locale}${probePath}`);
    }

    const redirects = (h: Hop) => h.status === 301 || h.status === 302;

    if (!redirects(report.control)) {
      report.verdict.push(
        `INCONCLUSIVE — the control URL did not redirect (status ${report.control.status ?? "no response"}). ` +
          `Either the redirect had not propagated yet, or this shop serves that path some other way. Re-run before reading anything into the prefixed result.`,
      );
    } else if (!locale) {
      report.verdict.push(
        "The redirect works, but this shop has no published second language — there is no prefixed URL to test. Run this on a translating shop.",
      );
    } else if (report.prefixed && redirects(report.prefixed)) {
      report.verdict.push(
        `ANSWER: YES — \`/${locale}${probePath}\` also redirects (status ${report.prefixed.status}, Location \`${report.prefixed.location ?? "none"}\`).`,
        "Shopify applies a path-based redirect underneath the locale prefix, so a translated handle CAN be redirected.",
      );

      // The second half, decided here rather than by eye. It is what picks the
      // design: if the prefix is CARRIED, one unprefixed row covers every
      // locale. If it is DROPPED, an unprefixed row would send a Spanish
      // visitor from /es/alt to the PRIMARY-locale /neu — kicking them out of
      // their own language — and each locale would need its own prefixed row.
      const location = report.prefixed.location ?? "";
      const prefixedTarget = `/${locale}${target}`;
      if (location === prefixedTarget) {
        report.verdict.push(
          `The prefix is CARRIED onto the target (\`${location}\`). Store the redirect UNPREFIXED — Shopify covers every locale from the one row.`,
        );
      } else if (location === target) {
        report.verdict.push(
          `The prefix is DROPPED (\`${location}\`, not \`${prefixedTarget}\`). An unprefixed row would send a visitor out of their language, so each locale needs its OWN prefixed row — and whether Shopify even matches a prefixed PATH is then the next thing to measure.`,
        );
      } else {
        report.verdict.push(
          `INCONCLUSIVE on the target: expected \`${prefixedTarget}\` or \`${target}\`, got \`${location || "no Location header"}\`. Do not design against this run.`,
        );
      }
    } else {
      report.verdict.push(
        `ANSWER: NO — the control redirects but \`/${locale}${probePath}\` returned ${report.prefixed?.status ?? "no response"}.`,
        "A locale-prefixed path is a different path to the redirect table, so a translated handle would need its own row per locale. That is the reason the bulk-translate path creates none today.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[RedirectLocaleProbe] failed", { context: "RedirectLocaleProbe", shop: session.shop, error: message });
    report.verdict.push(`The probe failed: ${message}`);
  } finally {
    // Always — a diagnostic must not leave a row in the merchant's redirect list.
    if (redirectId) await deleteRedirect(admin, redirectId).catch(() => undefined);
  }

  return json({ report });
};
