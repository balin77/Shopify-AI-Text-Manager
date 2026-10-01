import { describe, expect, it } from "vitest";
import {
  COMPARE_ENGINES,
  COMPARE_PRICES,
  PRICE_APPS,
  formatComparePrice,
  supportAtLevel,
  COMPARE_GROUPS,
  COMPARE_ROWS,
  COMPETITORS,
  COMPARE_TOPICS,
  COMPARE_TOPIC_ORDER,
  LIVE_COMPETITORS,
  TRANSLATION_COMPETITORS,
  comparePath,
  isCompetitorId,
  topicBySlug,
  topicOfCompetitor,
  topicPath,
  visibleTopics,
} from "../../app/config/marketing-compare";
import { getCompareCopy } from "../../app/i18n/marketing/compare";
import { BILLING_PLANS } from "../../app/config/billing";
import { MARKETING_LOCALES, isMarketingPath, localizedPath } from "../../app/services/marketing-locale.shared";

describe("comparison pages", () => {
  it("has a page for every competitor in every locale that counts as public", () => {
    for (const locale of MARKETING_LOCALES) {
      expect(isMarketingPath(localizedPath(locale, "/compare"))).toBe(true);
      for (const id of COMPETITORS) {
        expect(isMarketingPath(localizedPath(locale, comparePath(id)))).toBe(true);
      }
    }
  });

  it("only accepts the listed competitors as slugs", () => {
    expect(isCompetitorId("weglot")).toBe(true);
    expect(isCompetitorId("not-an-app")).toBe(false);
    expect(isCompetitorId(undefined)).toBe(false);
  });

  it("puts every row into a group the table renders", () => {
    for (const row of COMPARE_ROWS) expect(COMPARE_GROUPS).toContain(row.group);
    for (const group of COMPARE_GROUPS) {
      expect(COMPARE_ROWS.some((row) => row.group === group)).toBe(true);
    }
    for (const topic of COMPARE_TOPIC_ORDER) {
      const { rows, groups } = COMPARE_TOPICS[topic];
      for (const row of rows) expect(groups, `${topic}/${row.id}`).toContain(row.group);
      for (const group of groups) expect(rows.some((row) => row.group === group), `${topic}/${group}`).toBe(true);
      // A row id appears once per topic: the copy and the notes are keyed by it.
      expect(new Set(rows.map((row) => row.id)).size, topic).toBe(rows.length);
    }
  });

  it("names our own gaps too — a table we win on every row reads as an advert", () => {
    for (const topic of COMPARE_TOPIC_ORDER) {
      expect(COMPARE_TOPICS[topic].rows.some((row) => row.ours === "no"), topic).toBe(true);
    }
  });

  it("answers each row only for the apps of its own topic", () => {
    for (const topic of COMPARE_TOPIC_ORDER) {
      const { rows, competitors } = COMPARE_TOPICS[topic];
      for (const row of rows) {
        for (const app of Object.keys(row.them)) {
          expect(competitors as readonly string[], `${topic}/${row.id}/${app}`).toContain(app);
        }
      }
    }
  });

  it("keeps topic slugs and competitor slugs apart, and every competitor in exactly one topic", () => {
    for (const topic of COMPARE_TOPIC_ORDER) {
      const slug = COMPARE_TOPICS[topic].slug;
      if (slug) expect(isCompetitorId(slug), slug).toBe(false);
      expect(topicBySlug(slug ?? undefined)).toBe(slug ? topic : null);
      expect(topicPath(topic)).toBe(slug ? `/compare/${slug}` : "/compare");
    }
    for (const id of COMPETITORS) {
      const homes = COMPARE_TOPIC_ORDER.filter((topic) => COMPARE_TOPICS[topic].competitors.includes(id));
      expect(homes, id).toEqual([topicOfCompetitor(id)]);
      const { initial, competitors } = COMPARE_TOPICS[topicOfCompetitor(id)];
      for (const start of initial) expect(competitors).toContain(start);
    }
  });

  it("publishes nothing unresearched: a live topic has real plans and page copy for every app", () => {
    for (const topic of visibleTopics(false)) {
      for (const id of COMPARE_TOPICS[topic].competitors) {
        expect(COMPARE_PRICES[id].pending, `${topic}/${id}`).toBeUndefined();
        for (const locale of MARKETING_LOCALES) {
          expect(getCompareCopy(locale).competitors[id], `${locale} ${id}`).toBeDefined();
        }
      }
    }
    expect(visibleTopics(false)).toContain("translation");
    expect(LIVE_COMPETITORS).toEqual(expect.arrayContaining([...TRANSLATION_COMPETITORS]));
  });

  it("gives every competitor the same number of strengths and edges in every language", () => {
    const en = getCompareCopy("en");
    for (const locale of MARKETING_LOCALES) {
      const copy = getCompareCopy(locale);
      for (const id of COMPETITORS) {
        const mine = copy.competitors[id];
        const reference = en.competitors[id];
        // The same apps have copy in every language — never one page in English only.
        expect(Boolean(mine), `${locale} ${id}`).toBe(Boolean(reference));
        if (!mine || !reference) continue;
        expect(mine.strengths.length).toBe(reference.strengths.length);
        expect(mine.ourEdge.length).toBe(reference.ourEdge.length);
        expect(Object.keys(mine.notes ?? {}).sort()).toEqual(Object.keys(reference.notes ?? {}).sort());
      }
      for (const topic of COMPARE_TOPIC_ORDER) {
        expect(copy.ourStrengthsByTopic[topic]?.length ?? 0).toBe(en.ourStrengthsByTopic[topic]?.length ?? 0);
      }
      expect(Object.keys(copy.ourNotes).sort()).toEqual(Object.keys(en.ourNotes).sort());
      expect(copy.vsTitle).toContain("{name}");
      expect(copy.disclaimer).toContain("{date}");
    }
  });

  it("advertises exactly the prices the app bills", () => {
    const ours = Object.fromEntries(COMPARE_PRICES.contentpilot.plans.map((p) => [p.id, p.monthly]));
    expect(ours).toEqual({
      free: 0,
      basic: BILLING_PLANS.basic.price,
      pro: BILLING_PLANS.pro.price,
      max: BILLING_PLANS.max.price,
    });
  });

  it("formats prices without Intl, the same on server and client", () => {
    expect(formatComparePrice(9.9, "EUR", "en")).toBe("€9.90");
    expect(formatComparePrice(9.9, "EUR", "de")).toBe("9,90 €");
    expect(formatComparePrice(17, "USD", "es")).toBe("17 US$");
    expect(formatComparePrice(14.9, "USD", "en")).toBe("$14.90");
  });

  it("lists a per-plan answer for every plan of the app it describes", () => {
    for (const row of COMPARE_TOPIC_ORDER.flatMap((topic) => COMPARE_TOPICS[topic].rows)) {
      for (const [app, answers] of Object.entries(row.byPlan ?? {})) {
        const plans = COMPARE_PRICES[app as keyof typeof COMPARE_PRICES].plans;
        expect(answers, `${row.id}/${app}`).toHaveLength(plans.length);
      }
    }
  });

  it("never says 'higher plan' on an app's top plan, and reads its top plan past its ladder", () => {
    for (const row of COMPARE_TOPIC_ORDER.flatMap((topic) => COMPARE_TOPICS[topic].rows)) {
      for (const app of PRICE_APPS) {
        const top = COMPARE_PRICES[app].plans.length - 1;
        expect(supportAtLevel(row, app, top), `${row.id}/${app}`).not.toBe("higherPlan");
        expect(supportAtLevel(row, app, 99)).toBe(supportAtLevel(row, app, top));
      }
    }
  });

  it("describes our own plan limits in the per-plan view too", () => {
    const row = COMPARE_ROWS.find((r) => r.id === "thirdPartyApps")!;
    expect(supportAtLevel(row, "contentpilot", 0)).toBe("higherPlan");
    expect(supportAtLevel(row, "contentpilot", 3)).toBe("yes");
  });

  it("names the engines of every plan of every app whose engines are compared", () => {
    const engineApps = new Set<string>(["contentpilot"]);
    for (const topic of COMPARE_TOPIC_ORDER) {
      const config = COMPARE_TOPICS[topic];
      if (config.showEngines) config.competitors.forEach((id) => engineApps.add(id));
    }
    for (const app of PRICE_APPS) {
      const engines = COMPARE_ENGINES[app];
      // A pending app (not researched yet) may miss its engines; it renders "being checked".
      if (!engines && COMPARE_PRICES[app].pending) continue;
      if (engineApps.has(app) && !COMPARE_PRICES[app].pending) expect(engines, app).toBeDefined();
      if (engines) expect(engines, app).toHaveLength(COMPARE_PRICES[app].plans.length);
    }
  });
});

describe("strengths row of the comparison table", () => {
  it("has a non-empty strengths list for every app in every language", () => {
    for (const locale of MARKETING_LOCALES) {
      const copy = getCompareCopy(locale);
      expect(copy.ourStrengths.length, locale).toBeGreaterThan(0);
      for (const id of LIVE_COMPETITORS) {
        expect(copy.competitors[id]?.strengths.length ?? 0, `${locale} ${id}`).toBeGreaterThan(0);
      }
      for (const topic of COMPARE_TOPIC_ORDER) {
        expect((copy.ourStrengthsByTopic[topic] ?? copy.ourStrengths).length, `${locale} ${topic}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("included-AI prices on the comparison table", () => {
  it("shows the '+ AI' price Shopify charges for each paid plan, and the taster on Free", async () => {
    const { MANAGED_BILLING_PLANS } = await import("../../app/config/billing");
    const { MANAGED_AI_TASTER_ACTIONS } = await import("../../app/config/managed-ai-budget");
    const { COMPARE_PRICES } = await import("../../app/config/marketing-compare");
    const [free, basic, pro, max] = COMPARE_PRICES.contentpilot.plans;
    expect(free.includedAi).toEqual({ kind: "taster", actions: MANAGED_AI_TASTER_ACTIONS });
    expect(basic.includedAi).toMatchObject({ kind: "plan", monthly: MANAGED_BILLING_PLANS.basic.price });
    expect(pro.includedAi).toMatchObject({ kind: "plan", monthly: MANAGED_BILLING_PLANS.pro.price });
    expect(max.includedAi).toMatchObject({ kind: "plan", monthly: MANAGED_BILLING_PLANS.max.price });
  });
});
