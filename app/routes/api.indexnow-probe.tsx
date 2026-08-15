/**
 * IndexNow Probe — Settings → Translation Probe tab.
 *
 * Answers the one question about this feature that cannot be answered from the
 * code: does IndexNow ACCEPT our setup on a real shop?
 *
 * Two things are uncertain by construction and only a live shop can settle them:
 *
 *  1. **Key file outside the root.** Shopify does not let an app place a file at
 *     the storefront root, so the key is served from the app proxy
 *     (`/apps/contentpilot/indexnow-key`) and declared via `keyLocation`.
 *     IndexNow permits that — but some readings of the protocol restrict
 *     submissions to the key file's own directory, which would reject every
 *     `/products/...` URL with 403.
 *  2. **Host.** The key file and the submitted URLs must live on the same host.
 *     The service now uses the primary domain for both; this probe re-checks it
 *     end-to-end, INCLUDING whether the key fetch gets redirected to a
 *     different host on the way.
 *
 * The probe therefore does exactly what a search engine does: fetch the key
 * file (following redirects by hand so every hop is visible), then POST one
 * single URL to the real IndexNow endpoint and report the raw status code. The
 * submitted URL is the shop's homepage — the least surprising URL to ask an
 * engine to re-crawl, and one that exists on every shop.
 *
 * Pro+ like the section itself. Read-mostly: the only side effect is one
 * homepage submission.
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { meetsPlan } from "../utils/planUtils";
import { fetchPrimaryDomain } from "../utils/shop-domain.server";
import type { Plan } from "../config/plans";
import {
  getIndexNowConfig,
  homepageUrl,
  buildSubmitBody,
  describeSubmitStatus,
  KEY_PROXY_PATH,
} from "../services/seo/index-now.service";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const PROBE_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 3;
const MAX_BODY_CHARS = 300;

interface KeyFetchHop {
  url: string;
  status: number;
  location: string | null;
  /** True once a hop leaves the host we declared to IndexNow. */
  crossHost: boolean;
}

export interface IndexNowProbeReport {
  generatedAt: string;
  shop: string;
  configured: boolean;
  enabled: boolean;
  /** Host declared to IndexNow (should be the primary domain). */
  host: string;
  primaryDomain: string;
  hostIsPrimaryDomain: boolean;
  keyLocation: string;
  keyPath: string;
  keyFile: {
    reachable: boolean;
    finalStatus: number | null;
    hops: KeyFetchHop[];
    bodyMatchesKey: boolean | null;
    body: string | null;
    error?: string;
  };
  submitTest: {
    url: string;
    status: number | null;
    kind: ReturnType<typeof describeSubmitStatus>;
    responseBody: string | null;
    error?: string;
  };
  verdict: string[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Fetch the key file the way a search engine would, recording every redirect hop. */
async function probeKeyFile(keyLocation: string, expectedKey: string, declaredHost: string) {
  const hops: KeyFetchHop[] = [];
  let current = keyLocation;

  for (let i = 0; i <= MAX_REDIRECT_HOPS; i++) {
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      return {
        reachable: false,
        finalStatus: null,
        hops,
        bodyMatchesKey: null,
        body: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const location = res.headers.get("location");
    hops.push({
      url: current,
      status: res.status,
      location,
      crossHost: hostOf(current) !== declaredHost,
    });

    if (res.status >= 300 && res.status < 400 && location) {
      try {
        current = new URL(location, current).toString();
      } catch {
        // A malformed Location header must produce a REPORT, not a 500 — the
        // whole point of this route is to explain what went wrong.
        return {
          reachable: false,
          finalStatus: res.status,
          hops,
          bodyMatchesKey: null,
          body: null,
          error: `Unparseable redirect target: ${location}`,
        };
      }
      continue;
    }

    const raw = await res.text().catch(() => "");
    const body = raw.trim();
    return {
      reachable: res.ok,
      finalStatus: res.status,
      hops,
      bodyMatchesKey: res.ok ? body === expectedKey : null,
      body: body.slice(0, MAX_BODY_CHARS),
    };
  }

  return {
    reachable: false,
    finalStatus: null,
    hops,
    bodyMatchesKey: null,
    body: null,
    error: `More than ${MAX_REDIRECT_HOPS} redirects`,
  };
}

/** One real submission against the real endpoint — the only way to see the status code. */
async function probeSubmit(host: string, key: string, keyLocation: string, url: string) {
  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(buildSubmitBody(host, key, keyLocation, [url])),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => "");
    return {
      url,
      status: res.status,
      kind: describeSubmitStatus(res.status),
      responseBody: body.trim().slice(0, MAX_BODY_CHARS) || null,
    };
  } catch (err) {
    return {
      url,
      status: null,
      kind: describeSubmitStatus(null),
      responseBody: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildVerdict(report: Omit<IndexNowProbeReport, "verdict">): string[] {
  const out: string[] = [];

  if (!report.hostIsPrimaryDomain) {
    out.push(
      `⚠️ Submitting for "${report.host}" while the shop's primary domain is `
        + `"${report.primaryDomain}". Open the IndexNow section once — the loader re-syncs the host.`,
    );
  }

  const crossHostHop = report.keyFile.hops.find((h) => h.crossHost);
  if (crossHostHop) {
    out.push(
      `❌ The key file fetch left the declared host (${crossHostHop.url}). IndexNow verifies `
        + `ownership on the declared host, so this is very likely the cause of a 403.`,
    );
  }
  if (report.keyFile.hops.length > 1 && !crossHostHop) {
    out.push(`ℹ️ The key file is served after ${report.keyFile.hops.length - 1} same-host redirect(s).`);
  }

  if (!report.keyFile.reachable) {
    out.push(
      `❌ Key file NOT reachable (status ${report.keyFile.finalStatus ?? "none"}`
        + `${report.keyFile.error ? `, ${report.keyFile.error}` : ""}). A search engine that cannot `
        + `fetch it rejects every submission. Check that the app proxy is configured with prefix `
        + `"apps" / subpath "contentpilot" and that the storefront is not password-protected.`,
    );
  } else if (report.keyFile.bodyMatchesKey === false) {
    out.push("❌ The key file is reachable but its content does not match the stored key.");
  } else {
    out.push("✅ Key file reachable on the declared host and its content matches the key.");
  }

  switch (report.submitTest.kind) {
    case "ok":
      out.push(
        `✅ IndexNow ACCEPTED a submission for ${report.submitTest.url} (HTTP ${report.submitTest.status}). `
          + `The key at "${report.keyPath}" is valid for URLs outside its own directory — the open `
          + `question about the non-root key location is settled: our setup works.`,
      );
      break;
    case "keyInvalid":
      out.push(
        `❌ IndexNow answered 403 (key not valid). Either the key file is not accepted at all, or the `
          + `non-root key location "${report.keyPath}" restricts submissions to that directory — in `
          + `which case the app-proxy approach cannot work and the key must be served via a Shopify `
          + `URL redirect from the storefront root instead.`,
      );
      break;
    case "hostMismatch":
      out.push(
        report.hostIsPrimaryDomain
          ? `❌ IndexNow answered 422 — and since the host matches, this is the KEY LOCATION SCOPE: a `
            + `key file at "${report.keyPath}" verifies only that sub-path, so a URL like `
            + `${report.submitTest.url} counts as unrelated to it. Measured on a live shop; the key `
            + `has to be reachable at the ROOT of the domain.`
          : `❌ IndexNow answered 422: the submitted URL does not belong to the declared host `
            + `"${report.host}".`,
      );
      break;
    case "rateLimited":
      out.push("⚠️ IndexNow answered 429 (too many requests). Inconclusive — retry later.");
      break;
    case "networkError":
      out.push(
        `⚠️ IndexNow could not be reached${report.submitTest.error ? `: ${report.submitTest.error}` : ""}. `
          + `Inconclusive — check outbound network access.`,
      );
      break;
    default:
      out.push(
        `⚠️ Unexpected response HTTP ${report.submitTest.status}`
          + `${report.submitTest.responseBody ? `: ${report.submitTest.responseBody}` : ""}.`,
      );
  }

  return out;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  if (!meetsPlan((settings?.subscriptionPlan || "free") as Plan, "pro")) {
    return json({ error: "gated" }, { status: 403 });
  }

  const config = await getIndexNowConfig(db, session.shop);
  const primaryDomain = await fetchPrimaryDomain(admin, session.shop);

  // Not configured, or configured but switched off: the key-file proxy 404s
  // for a disabled config, so probing anyway would report "key file not
  // reachable, check your app proxy" — pointing at a problem that isn't there —
  // and would still fire a live submission for a feature the merchant turned
  // off. Report the actual state instead.
  if (!config || !config.enabled) {
    return json({
      report: {
        generatedAt: new Date().toISOString(),
        shop: session.shop,
        configured: !!config,
        enabled: false,
        host: config?.host ?? "",
        primaryDomain,
        hostIsPrimaryDomain: config ? config.host === primaryDomain : false,
        keyLocation: config?.keyLocation ?? "",
        keyPath: KEY_PROXY_PATH,
        keyFile: { reachable: false, finalStatus: null, hops: [], bodyMatchesKey: null, body: null },
        submitTest: { url: "", status: null, kind: "networkError" as const, responseBody: null },
        verdict: [
          config
            ? "ℹ️ IndexNow is switched off for this shop — the key file is not served while disabled. Enable it in SEO → IndexNow, then run this probe."
            : "ℹ️ IndexNow is not enabled yet — enable it in SEO → IndexNow, then run this probe.",
        ],
      } satisfies IndexNowProbeReport,
    });
  }

  const keyFile = await probeKeyFile(config.keyLocation, config.key, config.host);
  const testUrl = homepageUrl(config.host);
  const submitTest = await probeSubmit(config.host, config.key, config.keyLocation, testUrl);

  const base = {
    generatedAt: new Date().toISOString(),
    shop: session.shop,
    configured: true,
    enabled: config.enabled,
    host: config.host,
    primaryDomain,
    hostIsPrimaryDomain: config.host === primaryDomain,
    keyLocation: config.keyLocation,
    keyPath: KEY_PROXY_PATH,
    keyFile,
    submitTest,
  };

  return json({ report: { ...base, verdict: buildVerdict(base) } satisfies IndexNowProbeReport });
};
