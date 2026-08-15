/**
 * IndexNow Probe — Settings → Translation Probe tab.
 *
 * Answers the one question about this feature that cannot be answered from the
 * code: does IndexNow ACCEPT our setup on a real shop?
 *
 * It already settled the first round. Serving the key from the app-proxy
 * sub-path delivered fine (200, no redirect, content matched, host matched) yet
 * every submission came back `422 … "not related to your site verified through
 * the keylocation parameter"` — a non-root key verifies only its own sub-path.
 * Hence the current design: `keyLocation` names the ROOT `/<key>.txt` and a
 * Shopify URL redirect maps it onto the app proxy.
 *
 * What is still worth measuring, and only a live shop can tell:
 *
 *  1. **The redirect hop.** Does the engine follow the 301 from the root path
 *     to the app proxy, or does it insist on a directly-served key file?
 *  2. **Host.** Key file and submitted URLs must share a host. The service uses
 *     the primary domain for both; this re-checks it end to end, INCLUDING
 *     whether the key fetch gets redirected onto a different host on the way.
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
import { keyFilePath } from "../services/seo/index-now-key-file.server";

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
  /** Storefront path the key is declared at — the root `/<key>.txt`. */
  keyPath: string;
  /** Whether the URL redirect that maps keyPath onto the app proxy is on record. */
  keyRedirectPresent: boolean;
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

  if (!report.keyRedirectPresent) {
    out.push(
      `⚠️ No key-file redirect is on record for this shop, so "${report.keyPath}" probably 404s. `
        + `Open the IndexNow section once — the loader creates it.`,
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
          + `The root key file at "${report.keyPath}" — served through the URL redirect onto `
          + `"${KEY_PROXY_PATH}" — is valid for the whole site. The setup works.`,
      );
      break;
    case "keyInvalid":
      out.push(
        `❌ IndexNow answered 403 (key not valid). The key file itself is being rejected: check that `
          + `"${report.keyPath}" really returns the bare key (the hop table above shows what it `
          + `returned) and that the redirect onto "${KEY_PROXY_PATH}" is still in place.`,
      );
      break;
    case "hostMismatch":
      out.push(
        !report.hostIsPrimaryDomain
          ? `❌ IndexNow answered 422: the submitted URL does not belong to the declared host `
            + `"${report.host}".`
          : report.keyPath.split("/").length > 2
            ? `❌ IndexNow answered 422 with a matching host — that is the KEY LOCATION SCOPE: a key `
              + `under "${report.keyPath}" verifies only that sub-path, so ${report.submitTest.url} `
              + `counts as unrelated. The key has to sit at the ROOT of the domain.`
            : `❌ IndexNow answered 422 even though the key is at the root ("${report.keyPath}") and `
              + `the host matches. That points at the redirect hop: the engine appears not to accept `
              + `a key file that is only reachable through a 301. Next lever is a key file served `
              + `directly at the root, which Shopify does not allow an app to place — escalate rather `
              + `than retrying this configuration.`,
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
        keyPath: config ? keyFilePath(config.key) : "",
        keyRedirectPresent: !!config?.keyRedirectId,
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
    keyPath: keyFilePath(config.key),
    keyRedirectPresent: !!config.keyRedirectId,
    keyFile,
    submitTest,
  };

  return json({ report: { ...base, verdict: buildVerdict(base) } satisfies IndexNowProbeReport });
};
