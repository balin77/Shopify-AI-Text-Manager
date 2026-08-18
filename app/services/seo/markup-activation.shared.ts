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
  /** Served, but this crawl cannot say by whom (it predates the marker). */
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
  opts: { measured: boolean; originKnown: boolean },
): ActivationGate {
  const empty = { pages: 0, appPages: 0, duplicatePages: 0, appIsOneCopy: 0, repeatable: false };
  if (!opts.measured) return { verdict: "unknown", ...empty };

  const s: MarkupTypeStat = stat ?? { type: "", ...empty };
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
  unknown: 3,
  originUnknown: 2,
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
  /** What the block ships with — a merchant who never touched it has this. */
  defaultOn: boolean;
}

export const JSON_LD_SWITCHES: MarkupSwitch[] = [
  { settingId: "enable_organization", labelKey: "organization", type: "Organization", defaultOn: true },
  { settingId: "enable_product", labelKey: "product", type: "Product", defaultOn: true },
  { settingId: "enable_collection", labelKey: "collection", type: "CollectionPage", defaultOn: true },
  { settingId: "enable_article", labelKey: "article", type: "Article", defaultOn: true },
  { settingId: "enable_breadcrumb", labelKey: "breadcrumb", type: "BreadcrumbList", defaultOn: true },
  { settingId: "enable_video", labelKey: "video", type: "VideoObject", defaultOn: true },
  { settingId: "enable_faq", labelKey: "faq", type: "FAQPage", defaultOn: false },
];
