/**
 * The activation gate of PLAN_MARKUP_ACTIVATION §1.2 — pure, client-safe, and
 * the ONE place that turns "what the last crawl measured" into "may this
 * switch be turned on".
 *
 * Why it exists at all: the section used to put the activation buttons ABOVE
 * the measurement, i.e. in the order in which a merchant makes the mistake
 * before they can see it. On 2026-08-18 that produced 12 invalid items in the
 * Rich Results Test on a live shop — the theme's product schema and ours share
 * Dawn's `@id` scheme deliberately (structured-data.liquid §2), so Google
 * MERGES the two nodes and every field both sides deliver ends up twice.
 * Turning both on is the one state the storefront block was never designed
 * for, and nothing stopped it.
 *
 * Two rules are load-bearing and are the reason this is a module rather than
 * three ternaries in the route:
 *
 *  1. **A missing measurement is not a green light.** No crawl, or a snapshot
 *     written before the column existed, yields `unknown` — never `free`. Same
 *     rule as `indexabilityKnown` / `attributesSyncedAt` / `translatableContent`
 *     everywhere else in this repo.
 *  2. **"Switch ours off" is only advice where one copy is actually ours.**
 *     Where the duplication is entirely between the theme and other apps, our
 *     switch cannot fix it and saying otherwise sends the merchant to the wrong
 *     screen. `appIsOneCopy` exists for exactly this and predates this module.
 *
 * It is deliberately generic over the stat shape so Phase 2's Open Graph
 * switch is gated by the same eight verdicts as the seven JSON-LD ones.
 */

/**
 * Per canonical @type (or per social property group), everything the gate
 * needs. Produced by `summarizeLiveJsonLd` (json-ld-audit.service.ts) and, from
 * Phase 2 on, by the social equivalent.
 */
export interface MarkupTypeStat {
  type: string;
  /**
   * The crawl `resourceType` these numbers are about ("product", "collection",
   * "article", "page", "policy", "unknown"). One bucket per (type, page kind),
   * because a shop-wide number cannot gate a page-scoped switch: our block
   * emits FAQPage only on PRODUCT pages, so a theme's FAQPage on /pages/faq
   * would otherwise read as "your theme already serves this, leave the switch
   * off" about two markups that never meet.
   *
   * Empty string for a stat that is already shop-wide (the social tags, which
   * ride on every page).
   */
  resourceType: string;
  /** Successfully served pages carrying it at least once. */
  pages: number;
  /** …of which carry a copy THIS app emitted (its `data-contentpilot` marker). */
  appPages: number;
  /** Pages carrying it MORE than once. Always 0 for a repeatable type. */
  duplicatePages: number;
  /** …of which one of the copies is ours — the only case our switch fixes. */
  appIsOneCopy: number;
  /**
   * True where several copies on ONE page are normal (VideoObject, ImageObject:
   * three product videos are three VideoObjects). The duplicate rule is off for
   * those, so a 0 in `duplicatePages` means "not checked", not "checked and
   * clean" — the gate must never dress that up as a verified result.
   */
  repeatable: boolean;
}

export type ActivationVerdict =
  /** No crawl at all, or the snapshot predates the column. Never green. */
  | "unknown"
  /** Measured: nothing serves it. Switching ours on is safe. */
  | "free"
  /** Measured: served, every copy is ours, no page carries it twice. */
  | "appOnly"
  /** Served by someone else only — switching ours on would duplicate it. */
  | "foreignOnly"
  /** Served on some pages by us and on others by someone else. */
  | "mixed"
  /**
   * Served, but nothing can say by whom. TWO causes produce this and the data
   * cannot tell them apart: the crawl predates the `data-contentpilot` marker,
   * OR our embed is switched off — with the embed off no page can carry the
   * marker, so `appEmbedDetected` is `null` forever and no amount of
   * re-crawling resolves it.
   *
   * The second cause is the NORMAL state of the merchant this whole section
   * was built for: embed off, theme serving the type, about to tick the box.
   * So the copy must name both causes and give the conclusion that holds under
   * either — do not switch it ON, and if it is already on, change nothing until
   * a crawl can tell. Claiming one cause as fact (which the first cut did) is
   * the inverse of the rule the rest of this module enforces.
   */
  | "originUnknown"
  /** Repeatable type we co-deliver: same-page duplication is unjudgeable. */
  | "repeatableUnjudged"
  /** Served twice on some page, one copy ours — our switch fixes it. */
  | "duplicateApp"
  /** Served twice, none of the copies ours — our switch cannot fix it. */
  | "duplicateForeign";

export interface ActivationGate {
  verdict: ActivationVerdict;
  /** Pages the verdict is about — 0 whenever `verdict === "unknown"`. */
  pages: number;
  appPages: number;
  duplicatePages: number;
  appIsOneCopy: number;
  /** Carried through so the UI can print the "several per page are normal" caveat. */
  repeatable: boolean;
}

/**
 * `measured` is the discriminator, and it is the caller's job to be strict
 * about it: pass `false` for "no crawl" AND for a snapshot whose column is
 * empty everywhere (`notMeasured`). `originKnown` is the second, weaker one —
 * true only when the crawl DID see this app's marker somewhere, which is what
 * makes `appPages === 0` mean "not ours" rather than "this crawl couldn't tell".
 */
export function activationGate(
  stat: MarkupTypeStat | undefined,
  opts: { measured: boolean; originKnown: boolean; scopeCovered?: boolean },
): ActivationGate {
  const empty = { pages: 0, appPages: 0, duplicatePages: 0, appIsOneCopy: 0, repeatable: false };
  if (!opts.measured) return { verdict: "unknown", ...empty };
  // A crawl that ran is not a crawl that looked HERE. With no page of this
  // switch's scope judged, `pages === 0` below would read as "nothing serves
  // it" and hand out the green "safe to switch on" — for a page kind we have
  // no measurement of, which is exactly the duplicate damage the gate exists
  // to prevent. Absent flag = covered, so callers that cannot answer the
  // question keep the previous behaviour rather than turning grey by accident.
  if (opts.scopeCovered === false) return { verdict: "unknown", ...empty };

  const s: MarkupTypeStat = stat ?? { type: "", resourceType: "", ...empty };
  const base = {
    pages: s.pages,
    appPages: s.appPages,
    duplicatePages: s.duplicatePages,
    appIsOneCopy: s.appIsOneCopy,
    repeatable: s.repeatable,
  };

  // Nothing serves it. The only state in which "you may switch this on" is a
  // measurement rather than a hope — and it holds for repeatable types too.
  if (s.pages === 0) return { verdict: "free", ...base };

  // A page carrying it twice outranks everything else: that is the damage the
  // whole plan is about, and it is actionable in exactly one of two ways.
  if (s.duplicatePages > 0) {
    if (s.appIsOneCopy > 0) return { verdict: "duplicateApp", ...base };
    // Without the marker we cannot claim the duplication is none of ours; with
    // it, "turn our switch off" would be the wrong advice, so say whose it is.
    return { verdict: opts.originKnown ? "duplicateForeign" : "originUnknown", ...base };

  }

  if (s.appPages === 0) {
    return { verdict: opts.originKnown ? "foreignOnly" : "originUnknown", ...base };
  }

  // From here on at least one copy is provably ours.
  //
  // For a repeatable type that is as far as the measurement goes: our block and
  // the theme can both emit three VideoObjects on the same page and the
  // duplicate rule — correctly — stays quiet, so `appPages === pages` proves
  // only that we are on every such page, never that we are the only source.
  if (s.repeatable) return { verdict: "repeatableUnjudged", ...base };

  if (s.appPages >= s.pages) return { verdict: "appOnly", ...base };
  return { verdict: "mixed", ...base };
}

/**
 * Severity order for rolling several switches into ONE tile badge. Worst wins,
 * and `unknown` is NOT the mildest state: an unmeasured shop must not inherit
 * the green badge of the switches that happened to come back clean.
 *
 * The caller decides how to render `unknown` — the structured-data section
 * short-circuits the whole tile to grey when nothing was measured at all,
 * which is the honest reading when the flag is global rather than per switch.
 */
const VERDICT_SEVERITY: Record<ActivationVerdict, number> = {
  duplicateApp: 5,
  duplicateForeign: 5,
  foreignOnly: 4,
  mixed: 4,
  // Not milder than `unknown`, and deliberately as loud as `foreignOnly`: the
  // type IS being served, we just cannot prove whose copy it is. That is a
  // reason to stop before touching the switch, not a footnote. See the note on
  // `originUnknown` in the type above for why this state is the NORMAL one for
  // a shop whose embed is off — i.e. exactly the shop about to switch it on.
  originUnknown: 4,
  unknown: 3,
  repeatableUnjudged: 2,
  appOnly: 1,
  free: 0,
};

/** The worst of several verdicts. `free` for an empty list — nothing to warn about. */
export function worstActivationVerdict(verdicts: ActivationVerdict[]): ActivationVerdict {
  let worst: ActivationVerdict = "free";
  for (const v of verdicts) {
    if (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst]) worst = v;
  }
  return worst;
}

/** Polaris tone for a verdict badge. `unknown` stays neutral on purpose. */
export function activationTone(
  verdict: ActivationVerdict,
): "success" | "critical" | "warning" | "info" | undefined {
  switch (verdict) {
    case "free":
    case "appOnly":
      return "success";
    case "duplicateApp":
    case "duplicateForeign":
      return "critical";
    case "foreignOnly":
    case "mixed":
      return "warning";
    case "originUnknown":
      // As loud as foreignOnly, for the reason given at VERDICT_SEVERITY.
      return "warning";
    case "repeatableUnjudged":
      return "info";
    case "unknown":
    default:
      return undefined;
  }
}

/**
 * The switches the JSON-LD app embed actually has, in the order the theme
 * editor lists them, each with the CANONICAL schema type it emits.
 *
 * `Article` rather than `BlogPosting` for the article switch: our block emits
 * BlogPosting, Dawn emits Article, and `canonicalJsonLdType` folds the two —
 * which is the whole reason that collision is detectable at all.
 */
export interface MarkupSwitch {
  /** The `block.settings.*` id in structured-data.liquid, shown verbatim. */
  settingId: string;
  /** i18n key under `structuredDataPage.activation.switches`. */
  labelKey: string;
  /** Canonical schema type, matched against the crawl's typeStats. */
  type: string;
  /**
   * The crawl `resourceType`s this switch actually emits on, or `null` for a
   * switch that emits everywhere. This is what keeps a page-scoped switch from
   * being judged against a page it never touches — see MarkupTypeStat.
   * Mirrors the `request.page_type` guards in structured-data.liquid; a change
   * there has to be reflected here or the gate judges the wrong pages.
   */
  scopes: string[] | null;
  /** What the block ships with — a merchant who never touched it has this. */
  defaultOn: boolean;
}

/**
 * What the merchant is supposed to DO about a verdict. Nine verdicts are the
 * right resolution for judging one switch and the wrong one for a summary — a
 * section headed "3 nicht einschalten, 1 ausschalten" is read in a second,
 * nine sentences are not read at all.
 *
 * `hold` folds the three states whose answer is the same ("the type is already
 * on the page, do not add ours"): the theme serves it, it is served unevenly,
 * or nobody can say who serves it. They differ in WHY, which the per-switch row
 * still says; they do not differ in what to do next.
 */
export type ActivationAction =
  | "enable" // nothing serves it — free to switch on
  | "running" // ours, exactly once — the intended end state
  | "hold" // already served by someone: do not switch ours on
  | "switchOff" // duplicated, one copy ours — our switch fixes it
  | "themeFix" // duplicated, none of it ours — fixable only in the theme
  | "noVerdict"; // not measured, or not judgeable (repeatable type)

export const ACTION_BY_VERDICT: Record<ActivationVerdict, ActivationAction> = {
  free: "enable",
  appOnly: "running",
  foreignOnly: "hold",
  mixed: "hold",
  originUnknown: "hold",
  duplicateApp: "switchOff",
  duplicateForeign: "themeFix",
  unknown: "noVerdict",
  repeatableUnjudged: "noVerdict",
};

/** Most urgent first — the order a summary line reads them in. */
export const ACTION_ORDER: ActivationAction[] = [
  "switchOff",
  "themeFix",
  "hold",
  "running",
  "enable",
  "noVerdict",
];

/**
 * Group one section's gates by what to do about them, keeping each bucket's
 * member labels so the summary can name them instead of only counting.
 */
export function groupGatesByAction<T>(
  gates: { label: string; verdict: ActivationVerdict; item?: T }[],
): { action: ActivationAction; labels: string[] }[] {
  const byAction = new Map<ActivationAction, string[]>();
  for (const g of gates) {
    const action = ACTION_BY_VERDICT[g.verdict];
    byAction.set(action, [...(byAction.get(action) ?? []), g.label]);
  }
  return ACTION_ORDER.filter((a) => byAction.has(a)).map((action) => ({
    action,
    labels: byAction.get(action) ?? [],
  }));
}

/** Polaris tone for the section's summary banner. */
export function actionTone(action: ActivationAction): "critical" | "warning" | "success" | "info" {
  switch (action) {
    case "switchOff":
    case "themeFix":
      return "critical";
    case "hold":
      return "warning";
    case "enable":
    case "running":
      return "success";
    default:
      return "info";
  }
}

/**
 * The tags `social-meta.liquid` emits, in the order it emits them — the social
 * counterpart of JSON_LD_SWITCHES. Each is gated separately in step 3: a theme
 * that sets `og:title` but no `twitter:*` is the common case, and one verdict
 * for the whole embed would hide it.
 *
 * Lower-case throughout — `extractSocialTags` normalizes, because themes mix
 * `og:image` and `OG:image` and a case-sensitive comparison would report a
 * served tag as missing.
 *
 * It lives HERE and not next to the audit that produces the stats, because the
 * activation section renders it in COMPONENT scope: importing it from
 * social-audit.service.ts drags that module — and through it
 * crawl-markup-rows.server.ts — into the client bundle, which the build
 * rightly refuses. Same reason SLOW_PAGE_WARN_MS sits in crawl.shared.ts.
 */
export const APP_SOCIAL_TAGS = [
  "og:title",
  "og:description",
  "og:url",
  "og:type",
  "og:image",
  "twitter:card",
  "twitter:title",
  "twitter:description",
  "twitter:image",
] as const;

export const JSON_LD_SWITCHES: MarkupSwitch[] = [
  // Organization carries no page-type guard in the block — it is emitted on
  // every page, so it is judged against every page.
  { settingId: "enable_organization", labelKey: "organization", type: "Organization", scopes: null, defaultOn: true },
  { settingId: "enable_product", labelKey: "product", type: "Product", scopes: ["product"], defaultOn: true },
  { settingId: "enable_collection", labelKey: "collection", type: "CollectionPage", scopes: ["collection"], defaultOn: true },
  { settingId: "enable_article", labelKey: "article", type: "Article", scopes: ["article"], defaultOn: true },
  { settingId: "enable_breadcrumb", labelKey: "breadcrumb", type: "BreadcrumbList", scopes: ["product", "collection", "article"], defaultOn: true },
  { settingId: "enable_video", labelKey: "video", type: "VideoObject", scopes: ["product"], defaultOn: true },
  { settingId: "enable_faq", labelKey: "faq", type: "FAQPage", scopes: ["product"], defaultOn: false },
];

/**
 * Fold the per-(type, page kind) buckets down to the ONE stat a switch is
 * judged on. A page has exactly one `resourceType`, so the buckets are disjoint
 * and summing them is exact rather than an approximation.
 *
 * Returns undefined when no bucket matches. That alone does NOT mean "nothing
 * serves it": no bucket is also what an uncrawled page kind looks like, which
 * is why the caller passes `scopeCovered` to `activationGate` separately —
 * this function cannot tell the two apart and must not pretend to.
 */
export function statForSwitch(
  stats: MarkupTypeStat[] | undefined,
  type: string,
  scopes: string[] | null,
): MarkupTypeStat | undefined {
  if (!stats) return undefined;
  const matching = stats.filter(
    (s) => s.type === type && (scopes === null || scopes.includes(s.resourceType)),
  );
  if (matching.length === 0) return undefined;
  return matching.reduce<MarkupTypeStat>(
    (acc, s) => ({
      type,
      resourceType: scopes === null ? "" : scopes.join(","),
      pages: acc.pages + s.pages,
      appPages: acc.appPages + s.appPages,
      duplicatePages: acc.duplicatePages + s.duplicatePages,
      appIsOneCopy: acc.appIsOneCopy + s.appIsOneCopy,
      repeatable: acc.repeatable || s.repeatable,
    }),
    { type, resourceType: "", pages: 0, appPages: 0, duplicatePages: 0, appIsOneCopy: 0, repeatable: false },
  );
}
