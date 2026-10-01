import { useLocation, useMatches, useNavigation } from "react-router";
import { InlineStack, Text, ButtonGroup, Button, Spinner, Popover, Scrollable } from "@shopify/polaris";
import { NotificationIcon, XIcon } from "@shopify/polaris-icons";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import { useTaskCount } from "../contexts/TaskCountContext";
import { useSidebarPanel } from "../contexts/SidebarPanelContext";
import { confirmNavigation } from "../hooks/useSaveBar";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useScrollLock } from "../hooks/useScrollLock";
import { MobileMenu, type MobileNavGroup } from "./MobileMenu";
import { UnifiedItemSelectorCompact } from "./unified/UnifiedItemSelectorCompact";
import { RunningTasksPreview } from "./RunningTasksPreview";
import { type Plan, PLAN_DISPLAY_NAMES } from "../config/plans";
import { CONTENT_RUBRICS, isContentPath } from "../config/content-rubrics";
import { isSeoPath, SEO_RUBRICS } from "../config/seo-sections";
import { meetsPlan } from "../utils/planUtils";
import { taskErrorText } from "../utils/task-error-text";
import { fieldTypeLabel, taskSubjectLabel, taskTypeLabel } from "../services/tasks/task-labels.shared";
import { SYNC_PHASE_ORDER, overallSyncPercent } from "../services/sync-phases.shared";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { InfoBoxTone } from "../contexts/InfoBoxContext";

/**
 * The message list inside the bell's popover. Held as a constant because two
 * places have to agree on it: the `Scrollable` that carries it, and the
 * scroll-lock allowance that looks it up while the panel is open.
 */
const MESSAGE_LIST_ID = "nav-message-list";

/**
 * Task types that run across the whole shop rather than on one item, and
 * therefore never write a `resourceTitle`. Each needs its own completion
 * sentence — the generic "Task completed for {title}" rendered them as
 * `Task completed for ""`. Keep in sync when a new site-wide task type is
 * added; the `!subject` fallback below catches anything missed.
 */
const SITE_WIDE_TASK_MESSAGE_KEY: Record<string, string> = {
  seoCrawl: "crawlCompleted",
  seoAudit: "auditCompleted",
  seoJsonLdAudit: "jsonLdAuditCompleted",
  seoInternalLinks: "internalLinksCompleted",
  seoRobotsAdvice: "robotsAdviceCompleted",
  aiDiscoveryIntro: "discoveryIntroCompleted",
  // The bulk editor's write task. Its type stays `seoBulkMeta` for historical
  // reasons (CLAUDE.md) — the message must not repeat that name at merchants.
  seoBulkMeta: "bulkEditorSaveCompleted",
  bulkEditorTranslate: "bulkEditorTranslateCompleted",
};

/** English fallbacks, mirroring the inline `||` defaults used elsewhere here. */
const SITE_WIDE_TASK_FALLBACK: Record<string, string> = {
  seoCrawl: "Website crawl finished",
  seoAudit: "SEO analysis finished",
  seoJsonLdAudit: "JSON-LD check finished",
  seoInternalLinks: "Internal link suggestions ready",
  seoRobotsAdvice: "robots.txt analysis finished",
  aiDiscoveryIntro: "AI suggestion for the opening text is ready",
  seoBulkMeta: "Bulk editor: changes saved",
  bulkEditorTranslate: "Bulk editor: translation finished",
};

/**
 * Translated name of an initial-sync phase. The `phase<Name>` keys live in the
 * settings section; an unlabelled phase falls back to a humanized key rather
 * than the raw camelCase one ("onlineStoreExtras" is what a merchant saw in a
 * German banner before the labels existed).
 */
function syncPhaseLabel(settings: Record<string, string>, phase: string): string {
  const key = `phase${phase.charAt(0).toUpperCase()}${phase.slice(1)}`;
  return (
    settings[key] ||
    phase.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())
  );
}

export function MainNavigation() {
  const location = useLocation();
  const navigation = useNavigation();
  const matches = useMatches();
  const { handleNavigate } = useAppNavigation();
  const { locale, t } = useI18n();
  const { infoBox, hideInfoBox, showInfoBox, isGlobalLoading, messageHistory, unreadCount, markAllRead, clearHistory, syncProgress } = useInfoBox();
  const [popoverActive, setPopoverActive] = useState(false);
  const { plan, getPlanDisplayName, getMaxProducts, canAccessContentType } = usePlan();
  const { setMainNavHeight } = useNavigationHeight();
  const { items, selectedItemId, onItemSelect, resourceName, t: itemSelectorT, onAddItem: onAddItemMobile, addDisabledReason, addLabel } = useItemSelector();
  const { runningTaskCount, recentlyCompletedTasks } = useTaskCount();
  // Narrow screens hide the editor's right-hand sidebar entirely; when one is
  // registered its toggle takes the plan button's slot (see below).
  const sidebarPanel = useSidebarPanel();
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const notifiedTaskIds = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);

  // Get product count from products route loader data
  const productsRouteData = matches.find((match) => match.id === "routes/app.products")?.data as any;
  const productCount = productsRouteData?.productCount;
  // Published shop locales from the app shell loader — drives the language gate
  // on SEO sections in the mobile drawer (0 = lookup failed / unknown).
  const shellLocaleCount =
    ((matches.find((match) => match.id === "routes/app")?.data as any)?.localeCount as number) ?? 0;
  const maxProducts = getMaxProducts();

  // Show notifications for newly finished tasks (from context) — completed,
  // completed_with_errors and failed. Tone is derived from status +
  // processed/total so partial failures and outright failures are surfaced as
  // warning/critical instead of silently appearing as success. Every name in
  // the message comes from task-labels.shared.ts, never from a rule spelled
  // out here: the Tasks page renders the same vocabulary, and two copies of
  // it have already drifted once.
  useEffect(() => {
    if (!recentlyCompletedTasks.length || !isMountedRef.current) return;

    for (const task of recentlyCompletedTasks) {
      if (notifiedTaskIds.current.has(task.id)) continue;

      notifiedTaskIds.current.add(task.id);

      const fieldName = fieldTypeLabel(task.fieldType, t);
      // The subject a merchant can read. Two decodings, both of which put a
      // machine string in front of one when they are skipped:
      //  - `seoBulkFix` stores "metaDescriptionMissing:fr" as its
      //    resourceTitle, so it goes through taskSubjectLabel (which answers
      //    "" for a `fixAllForItem:…` run it cannot name);
      //  - `formatting` and the text-translation handler store the FIELD KEY
      //    as the subject (`resourceTitle: fieldType`), which quoted read as
      //    `"body_html"` — where the two are the same string, the decoded
      //    field label is the same fact spelled for a person.
      const storedSubject = taskSubjectLabel(task, t) || "";
      const subject = storedSubject && storedSubject === task.fieldType && fieldName
        ? fieldName
        : storedSubject;

      // Every fallback sentence below LEADS with the task type. Without it the
      // generic message ("Task completed for \"Bag\"", or a bare "Task
      // completed" where nothing wrote a resourceTitle) identified nothing —
      // five WebP conversions produced five identical toasts, and the single
      // editor's translate, formatting, keyword insertion, speed test, blog
      // redirects and keyword distribution all shared one anonymous sentence.
      // The types that HAVE a sentence of their own keep it: naming the work
      // beats naming the machinery.
      const typeLabel = taskTypeLabel(task.type, t);
      // The field stands in for the subject only where there is no subject —
      // the same order the hover card uses (subject → field → type). With a
      // subject the field would just crowd the line.
      const head = [typeLabel, subject ? null : fieldName].filter(Boolean).join(" · ");
      const named = (sentence: string) => (head ? `${head} — ${sentence}` : sentence);
      // The same identification WITHOUT a verb, for the failure rung: every
      // sentence `baseMessage` can produce asserts that the task finished
      // ("Task completed for \"Bag\"", "Website crawl finished"), and the
      // failure rung used to append the error to one of them — in a red box
      // that carries no heading of any kind. So a failed run announced its own
      // completion and nothing contradicted it. Naming the task is still
      // right; claiming it succeeded is not.
      const identity = [typeLabel, subject ? `"${subject}"` : fieldName]
        .filter(Boolean)
        .join(" · ");

      const baseMessage = (() => {
        // `translation` (the single-locale editor translate, the alt-text and
        // sub-resource paths, direct translations, the stale-sync
        // re-translation) is the most common task in the app and used to fall
        // through to the anonymous sentence. It is the same family as
        // `bulkTranslation` and reads with the same two sentences — but only
        // where a subject exists: both templates quote it, and the titleless
        // rows (the editor's own translate task writes none) would render
        // `Translation completed for ""`.
        if ((task.type === "bulkTranslation" || task.type === "translation") && subject) {
          // `fieldName === subject` is the field-key-as-subject case above:
          // the two-part sentence would read "Translation for Title in
          // \"Title\" completed".
          if (task.fieldType === "all" || !fieldName || fieldName === subject) {
            return t.tasks?.translationCompleted?.replace("{title}", subject) || `Translation completed for "${subject}"`;
          }
          return t.tasks?.fieldTranslationCompleted?.replace("{field}", fieldName).replace("{title}", subject)
            || `Translation completed for ${fieldName} in "${subject}"`;
        }
        // Three spellings, one task type: the alt-text paths create
        // `bulkAIGeneration`, the i18n key is `bulkAiGeneration`, and this
        // test carried only two of them — so the third fell through to the
        // anonymous sentence. task-labels.shared.ts aliases them for the
        // LABEL; the branch has to know about them too.
        if (
          (task.type === "aiGeneration" || task.type === "bulkAIGeneration" || task.type === "bulkAiGeneration")
          && subject
        ) {
          const field = fieldName || "content";
          return t.tasks?.generationCompleted?.replace("{field}", field).replace("{title}", subject)
            || `AI generation completed for ${field} in "${subject}"`;
        }
        if (task.type === "altTextTemplateApply" && subject) {
          return t.tasks?.altTextTemplateApplied?.replace("{title}", subject) || `Alt-text templates applied to "${subject}"`;
        }
        // Site-wide tasks (every SEO scan, both bulk-editor tasks) have no
        // resourceTitle — there is no single item they belong to. The generic
        // message rendered them all as `Task completed for ""`.
        const siteWideKey = SITE_WIDE_TASK_MESSAGE_KEY[task.type];
        if (siteWideKey) {
          const message = (t.tasks as unknown as Record<string, string> | undefined)?.[siteWideKey];
          // `?? named(...)`: a key present in the message map but missing from
          // the fallback map would otherwise put the string "undefined" in
          // front of a merchant.
          return typeof message === "string"
            ? message
            : SITE_WIDE_TASK_FALLBACK[task.type] ?? named(t.tasks?.taskCompletedGeneric || "Task completed");
        }
        // seoBulkFix stores a machine string ("metaDescriptionMissing:fr",
        // "fixAllForItem:product:8123") as its resourceTitle — readable to the
        // bulk-fix runner, not to a merchant. Name the problem it fixed
        // instead, using the dashboard's own label for the code.
        if (task.type === "seoBulkFix") {
          // taskSubjectLabel answers null for a subject with no dashboard
          // label — every `fixAllForItem:…` run, and any problem code the
          // dashboard does not name. The bare sentence is then the whole
          // message: never a raw machine string, and never a dangling colon.
          const problemLabel = taskSubjectLabel(task, t);
          const done = t.tasks?.seoBulkFixCompleted || "SEO fix finished";
          return problemLabel ? `${done}: ${problemLabel}` : done;
        }
        // Safety net for any task type that reaches here without a subject —
        // never render the `for ""` form. Both forms are NAMED: the type is
        // the only thing that tells these tasks apart.
        if (!subject) {
          return named(t.tasks?.taskCompletedGeneric || "Task completed");
        }
        return named(t.tasks?.taskCompleted?.replace("{title}", subject) || `Task completed for "${subject}"`);
      })();

      // Task.error holds a machine code for the task types that write it
      // without a locale context; those must never reach the merchant raw.
      const errorText = taskErrorText(task.error, t);

      const total = typeof task.total === "number" ? task.total : null;
      const processed = typeof task.processed === "number" ? task.processed : null;
      const failed = total != null && processed != null ? Math.max(total - processed, 0) : 0;

      // Tone and message are the WHOLE signal: the banner renders
      // `infoBox.message` and nothing else, so a status word only reaches the
      // merchant by being in that sentence. The box used to carry a `title`
      // too ("✓ Completed", "⚠ Partially saved", "✗ Failed") which no
      // renderer has ever displayed — it is gone from `showInfoBox` entirely,
      // and every rung below therefore states its outcome in the body.
      let tone: InfoBoxTone = "success";
      let message = baseMessage;

      if (task.status === "failed") {
        tone = "critical";
        // With an error text the word "failed" still has to be IN the body:
        // `taskErrorText` passes an unrecognised message through verbatim
        // ("AI service error: 429" and the like), which describes a fault
        // without ever saying the task is over. The generic text says it by
        // itself, so it is not prefixed twice.
        const failedWord = t.tasks?.status?.failed || "Failed";
        const detail = errorText
          ? `${failedWord}: ${errorText}`
          : (t.tasks?.taskFailedGeneric || "Task failed — please retry.");
        message = identity ? `${identity} — ${detail}` : detail;
      } else if (total != null && processed != null && processed < total) {
        tone = "warning";
        const summary = (t.tasks?.partialSummary || "{processed} of {total} saved, {failed} failed")
          .replace("{processed}", String(processed))
          .replace("{total}", String(total))
          .replace("{failed}", String(failed));
        message = `${baseMessage} — ${summary}${errorText ? `: ${errorText}` : ""}`;
      } else if (errorText || task.status === "completed_with_errors") {
        // Completed, but not cleanly. Two independent signals land here and
        // the ladder's ORDER is what keeps them from shadowing each other:
        // `failed` first (the whole run is lost), then a counted partial
        // (processed < total), which owns the richer `partialSummary` and must
        // therefore win over the bare status — a `completed_with_errors` run
        // that also counted its failures deserves the numbers, not just the
        // adjective. Only then this branch: a soft error recorded on an
        // otherwise finished task, or the status the translation paths write
        // when some locales failed while nothing counts processed/total.
        tone = "warning";
        // With no error text the body used to be the plain completion
        // sentence — "Translation completed for \"Blue Vase\"", so a partly
        // failed run announced itself as a clean success in a yellow box (the
        // title that said otherwise was never rendered anywhere, which is why
        // it no longer exists). The hint says what happened and where
        // the detail is; naming the failed locales would mean selecting
        // `result` in an endpoint polled every ~2s per open admin tab, and
        // that blob belongs to the Tasks panel the hint points at.
        const partialHint = task.status === "completed_with_errors"
          ? (t.tasks?.partialLocalesHint
            || "Some languages could not be saved — see the Tasks tab for details.")
          : "";
        const detail = errorText || partialHint;
        message = detail ? `${baseMessage} — ${detail}` : baseMessage;
      }

      if (isMountedRef.current) {
        showInfoBox(message, tone);
      }
    }

    // Cleanup old task IDs after 5 minutes
    const cleanupTimeout = setTimeout(() => {
      for (const task of recentlyCompletedTasks) {
        notifiedTaskIds.current.delete(task.id);
      }
    }, 300000);

    return () => clearTimeout(cleanupTimeout);
  }, [recentlyCompletedTasks, showInfoBox, t]);

  // Track component mount status to prevent state updates after unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Show loading indicator only if loading takes longer than 1 second
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;

    if (navigation.state === "loading" || navigation.state === "submitting") {
      timer = setTimeout(() => {
        if (isMountedRef.current) {
          setShowLoadingIndicator(true);
        }
      }, 1000);
    } else {
      if (isMountedRef.current) {
        setShowLoadingIndicator(false);
      }
      if (timer) {
        clearTimeout(timer);
      }
    }

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [navigation.state]);

  // Dynamically measure navigation height and update spacer + context
  useEffect(() => {
    const updateHeight = () => {
      if (navRef.current && isMountedRef.current) {
        const height = navRef.current.offsetHeight;
        setMainNavHeight(height); // Publish for downstream sticky elements
      }
    };

    // Update height on mount and when window resizes
    updateHeight();
    window.addEventListener('resize', updateHeight);

    // Use ResizeObserver for more precise tracking (if available)
    if (navRef.current && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(navRef.current);

      return () => {
        observer.disconnect();
        window.removeEventListener('resize', updateHeight);
      };
    }

    return () => {
      window.removeEventListener('resize', updateHeight);
    };
  }, [infoBox, syncProgress, showLoadingIndicator, isGlobalLoading, setMainNavHeight]); // Re-measure when infoBox/progress or loading indicator changes

  const togglePopover = useCallback(() => setPopoverActive(prev => !prev), []);

  const closePopover = useCallback(() => setPopoverActive(false), []);

  /**
   * Anything visible in the open panel counts as read — including a message
   * that arrives WHILE it is open. `markAllRead` used to run inside the
   * `setPopoverActive` updater (a side effect in a state updater, and one that
   * only fired on the opening click), so a message that landed in front of the
   * merchant's eyes still raised the badge when they closed the panel.
   */
  useEffect(() => {
    if (popoverActive && unreadCount > 0) markAllRead();
  }, [popoverActive, unreadCount, markAllRead]);

  /**
   * Freeze the page behind the open panel (CLAUDE.md §Overlays). The pages of
   * this app do not scroll the DOCUMENT, so `PositionedOverlay` never learns
   * about the scroll and the panel would hang over whatever slid underneath.
   * The navigation itself is sticky and does not move, so the panel does not
   * come loose from the bell — what this stops is the wheel over the message
   * list chaining through to the page once the list reaches its end.
   *
   * The list is looked up per EVENT and by its own id: Polaris portals the
   * overlay out of this tree, so there is nothing local to attach a ref to,
   * and `useScrollLock` reads `.current` at event time, which is what makes a
   * getter work at all.
   *
   * By ID and not by class. Polaris wraps every popover's children in a
   * `Pane`, and a Pane is ITSELF a `.Polaris-Scrollable` wrapping the whole
   * panel — so the obvious `querySelector(".Polaris-Scrollable")` answers with
   * the panel INCLUDING its header, and a wheel over the header would chain
   * straight through to the page behind it. An id names the one element that
   * may really scroll, and it cannot drift when Polaris renames an internal.
   */
  const messageListRef = useMemo(
    () => ({
      get current() {
        return document.getElementById(MESSAGE_LIST_ID);
      },
    }),
    [],
  );
  useScrollLock(popoverActive, messageListRef);

  const toneColor = (tone: InfoBoxTone) =>
    tone === "success" ? "#4caf50" :
    tone === "critical" ? "#f44336" :
    tone === "warning" ? "#ff9800" :
    "#2196f3";

  const toneBg = (tone: InfoBoxTone) =>
    tone === "success" ? "#e8f5e9" :
    tone === "critical" ? "#ffebee" :
    tone === "warning" ? "#fff3e0" :
    "#e3f2fd";

  /**
   * The four tone sentences. Each bundle carries the whole phrase (German
   * "Erfolgsmeldung" is one word), so the tone picks a sentence rather than an
   * adjective to splice. Read by the live region and by the per-row label in
   * the message list — one wording for both.
   */
  const toneLabel = (tone: InfoBoxTone) =>
    tone === "success"
      ? t.tasks?.notificationSuccess || "Success notification"
      : tone === "critical"
        ? t.tasks?.notificationCritical || "Error notification"
        : tone === "warning"
          ? t.tasks?.notificationWarning || "Warning notification"
          : t.tasks?.notificationInfo || "Information notification";

  /**
   * Timestamps follow the merchant's language. The old formatter padded
   * `getHours()` by hand, i.e. hardcoded 24-hour clock in an app that ships
   * English. The full stamp rides in the row's `title`, because the list keeps
   * messages across a session and "08:15" alone cannot say which day.
   */
  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale],
  );
  const fullTimestampFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  /**
   * What the live regions below say, and which of the two says it. The slot
   * flips on every new toast so an identical repeat is still a CHANGE in its
   * own region; `infoBox.id` is the discriminator because the text alone
   * cannot tell a repeat from a re-render.
   */
  const [announcement, setAnnouncement] = useState<{ text: string; slot: number }>({ text: "", slot: 0 });
  const announcedId = useRef<string | null>(null);
  useEffect(() => {
    if (!infoBox) {
      announcedId.current = null;
      setAnnouncement(prev => (prev.text === "" ? prev : { text: "", slot: prev.slot }));
      return;
    }
    if (announcedId.current === infoBox.id) return;
    announcedId.current = infoBox.id;
    setAnnouncement(prev => ({
      text: `${toneLabel(infoBox.tone)}: ${infoBox.message}`,
      slot: prev.slot === 0 ? 1 : 0,
    }));
    // `toneLabel` closes over `t`, which is stable per locale; re-running on
    // it would re-announce the standing message on every language change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoBox]);

  /**
   * The bell's accessible name. `aria-label` REPLACES the button's content, so
   * the unread badge is invisible to a screen reader unless the name carries
   * it — the old label named only the total, which is the number the badge
   * does not show.
   */
  const bellLabel = (t.tasks?.notificationsBellLabel || "Messages ({unread} unread of {count})")
    .replace("{unread}", String(unreadCount))
    .replace("{count}", String(messageHistory.length));

  // Level 1 is slimmed to high-level sections (Plan §3.4): "Inhalte" subsumes the
  // old Products + Other-Content tabs; the rubric/content-type structure lives in
  // RubricNavigation (Level 2) + ContentTypeNavigation (Level 3). "Inhalte" lands
  // on Produkte (the first Katalog entry).
  const navContentLabel = (t.nav as unknown as Record<string, string>).content || t.nav.otherContent;
  const tabs = [
    { id: "content", label: navContentLabel, path: "/app/products" },
    { id: "bulk", label: t.nav.bulk, path: "/app/bulk" },
    { id: "seo", label: t.nav.seo, path: "/app/seo" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

  const handleClick = async (path: string, tabId: string) => {
    // Gate navigation on the native save bar: prompts for unsaved changes and
    // resolves only when it is safe to leave.
    await confirmNavigation();
    handleNavigate(path);
  };

  // Navigate from an InfoBox link. Must go through handleNavigate so Shopify
  // session params (host/shop/embedded) are preserved — a raw client-side
  // navigate() drops them and breaks the *next* navigation (blank page).
  const handleInfoBoxLink = (url: string) => {
    const [path, query] = url.split("?");
    const options = query ? { searchParams: new URLSearchParams(query) } : {};
    handleNavigate(path, options);
  };

  // Navigate to settings/plan page when any plan button is clicked
  const handlePlanNavigation = async () => {
    await confirmNavigation();
    const searchParams = new URLSearchParams();
    searchParams.set("tab", "plan");
    handleNavigate("/app/settings", { searchParams });
  };

  const plans: Plan[] = ["free", "basic", "pro", "max"];

  // Mobile drawer data (Plan §3.6: Level 2 + Level 3 collapse into the
  // hamburger menu). Built from the SAME rubric configs the desktop bars read,
  // and kept GROUPED — a flat list would drop the Level-2 rubric that gives the
  // Level-3 entries their context, which is exactly what the drawer needs in
  // order to show the two levels as two levels.
  const mobileContentLabels = t.content as unknown as Record<string, string>;
  const contentRubricLabels = (t as unknown as { rubrics?: Record<string, string> }).rubrics ?? {};

  // Conditional entries (e.g. Abo-Pläne) are dropped on the same terms as the
  // desktop Level-3 bar: hidden only when the plan is entitled AND the shop has
  // no such content — otherwise the upsell lock stays.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appRootData = matches.find((m) => m.id === "routes/app")?.data as any;
  const conditionalContent: Record<string, boolean> | undefined = appRootData?.conditionalContent;

  const contentGroups: MobileNavGroup[] = CONTENT_RUBRICS.map((r) => ({
    id: r.id,
    label: contentRubricLabels[r.id] || r.id,
    icon: r.icon,
    entries: r.entries
      .filter((e) => {
        if (!e.conditional) return true;
        const present = conditionalContent?.[e.id];
        return !(present === false && canAccessContentType(e.planContentType));
      })
      .map((e) => ({
        id: e.id,
        label: mobileContentLabels?.[e.labelKey] || e.id,
        icon: e.icon,
        path: e.path,
        locked: !canAccessContentType(e.planContentType),
        count: e.id === "products" ? productCount : undefined,
        countCritical:
          e.id === "products" &&
          productCount !== undefined &&
          maxProducts !== Infinity &&
          productCount >= maxProducts,
      })),
  })).filter((g) => g.entries.length > 0);

  // SEO rubrics + sections mirror the desktop SubNavBar pair so mobile users can
  // jump straight to a sub-section (Übersicht, Strukturierte Daten, …).
  const seoSectionStrings =
    (t.seo as { sections?: Record<string, { label?: string }> }).sections ?? {};
  const seoRubricStrings = (t.seo as { rubrics?: Record<string, string> }).rubrics ?? {};
  // Language gate, mirroring the desktop SubNavBar (app.seo.tsx): a section that
  // only says something with a second shop language is greyed out with a 🌐
  // marker — never 🔒, which would read as "upgrade your plan". `localeCount` 0
  // means the lookup failed → treat as multi-language and gate nothing.
  const singleLocale = shellLocaleCount > 0 && shellLocaleCount <= 1;
  const seoGroups: MobileNavGroup[] = SEO_RUBRICS.map((r) => ({
    id: r.id,
    label: seoRubricStrings[r.id] || r.id,
    icon: r.icon,
    entries: r.entries.map((section) => {
      const planLocked = section.planGate ? !meetsPlan(plan, section.planGate) : false;
      const languageLocked = !!section.requiresMultipleLocales && singleLocale;
      return {
        id: section.id,
        label: seoSectionStrings[section.id]?.label || section.id,
        icon: section.icon,
        path: section.path,
        locked: planLocked || languageLocked,
        // Plan gate wins the marker: an upgrade unlocks the section outright.
        lockIcon: !planLocked && languageLocked ? "🌐" : undefined,
      };
    }),
  }));

  return (
    <>
      {/* Sticky Navigation — takes real space in document flow, so no spacer
          is needed and the bar doesn't briefly overlap content during hydration
          like a position:fixed bar would. */}
      <nav
        ref={navRef}
        role="navigation"
        aria-label="Main navigation"
        style={{
          background: "white",
          borderBottom: "1px solid #e1e3e5",
          position: "sticky",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
        }}
      >
        {/* Einzeilige Leiste mit Navigation, InfoBox und Plan Selector */}
        <div className="main-navigation" style={{ display: "flex", alignItems: "center", padding: "0.5rem 1rem", gap: "2rem", flexWrap: "wrap" }}>
          {/* Mobile Menu (Hamburger) - nur auf Mobile sichtbar */}
          <div className="mobile-only">
            <MobileMenu
              activeTab={isContentPath(location.pathname) ? "content" : isSeoPath(location.pathname) ? "seo" : tabs.find(tab => location.pathname.startsWith(tab.path))?.id}
              contentGroups={contentGroups}
              seoGroups={seoGroups}
            />
          </div>

          {/* Compact Item Selector - nur auf Mobile sichtbar und nur wenn Items vorhanden */}
          {items.length > 0 && onItemSelect && (
            <div className="mobile-only" style={{ flex: 1, minWidth: 0 }}>
              <UnifiedItemSelectorCompact
                items={items}
                selectedItemId={selectedItemId}
                onItemSelect={onItemSelect}
                resourceName={resourceName}
                onAddItem={onAddItemMobile}
                addDisabledReason={addDisabledReason}
                addLabel={addLabel}
                t={itemSelectorT}
              />
            </div>
          )}

          {/* Navigation Tabs - versteckt auf Mobile */}
          <div className="desktop-only">
          <InlineStack gap="400" blockAlign="center">
            {tabs.map((tab) => {
              // "Inhalte" is active on ANY content page, not just /app/products.
              const isActive = tab.id === "content"
                ? isContentPath(location.pathname)
                : tab.id === "seo"
                ? isSeoPath(location.pathname)
                : location.pathname.startsWith(tab.path);
              const showTaskCount = tab.id === "tasks" && runningTaskCount > 0;

              const tabContent = (
                <button
                  key={tab.id}
                  onClick={() => handleClick(tab.path, tab.id)}
                  role="tab"
                  aria-selected={isActive}
                  aria-label={`Navigate to ${tab.label}${showTaskCount ? ` (${runningTaskCount} running tasks)` : ''}`}
                  aria-current={isActive ? "page" : undefined}
                  style={{
                    textDecoration: "none",
                    padding: "0.4rem 0.5rem",
                    transition: "border-color 0.2s",
                    background: "none",
                    border: "none",
                    borderBottom: isActive ? "3px solid #303030" : "3px solid transparent",
                    cursor: "pointer",
                  }}
                >
                  <InlineStack gap="200" blockAlign="center">
                    <Text
                      as="span"
                      variant="bodyMd"
                      fontWeight={isActive ? "bold" : "regular"}
                      tone="base"
                    >
                      {tab.label}
                    </Text>
                    {showTaskCount && (
                      <RunningTasksPreview count={runningTaskCount} />
                    )}
                  </InlineStack>
                </button>
              );

              return tabContent;
            })}
          </InlineStack>
          </div>

          {/* Message bell — ALWAYS rendered, and the popover's only activator.

              It used to be hidden on desktop whenever a banner was up, and
              removed outright while `syncProgress` ran or the history was
              empty. Each of those was a state in which it was needed most: a
              standing message queues everything behind it, and the initial
              sync runs for minutes while messages pile up unreachable. Its
              absence also let `popoverActive` outlive its own activator, so
              the panel sprang open by itself the next time the slot returned.

              It sits directly after the last navigation tab, where merchants
              look for it — and, just as importantly, BEFORE the message strip
              and the sync banner in this row. Anything that mounts after it
              cannot move it, so a message arriving while the panel is open no
              longer slides the bell out from under it: Polaris re-measures an
              open popover only on scroll, resize, or a mutation INSIDE the
              activator. Parked at the far right it was stable for the same
              reason but nobody could find it. */}
          <div style={{ flex: "0 0 auto" }}>
            <Popover
              active={popoverActive}
              onClose={closePopover}
              preferredPosition="below"
              // Left-aligned, not centred: the panel opens from the bell's
              // left edge and runs into the free space to its right. Centring
              // a 380px panel on a 32px button puts half of it over the
              // navigation tabs, and right-aligning it — correct while the
              // bell sat at the far right — now drags the whole panel across
              // them.
              preferredAlignment="left"
              zIndexOverride={1100}
              activator={
                <div style={{ position: "relative", display: "flex" }}>
                  <Button
                    onClick={togglePopover}
                    pressed={popoverActive}
                    icon={NotificationIcon}
                    accessibilityLabel={bellLabel}
                  />
                  {unreadCount > 0 && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        top: "-4px",
                        right: "-4px",
                        // Polaris' critical fill. The old #f44336 gave white
                        // 10px bold text a contrast of 3.7:1 — below WCAG AA,
                        // on the one number that says how much was missed.
                        backgroundColor: "var(--p-color-bg-fill-critical)",
                        color: "var(--p-color-text-critical-on-bg-fill)",
                        borderRadius: "10px",
                        padding: "0 5px",
                        fontSize: "10px",
                        fontWeight: "700",
                        minWidth: "16px",
                        height: "16px",
                        lineHeight: "16px",
                        textAlign: "center",
                        pointerEvents: "none",
                      }}
                    >
                      {unreadCount}
                    </span>
                  )}
                </div>
              }
            >
              <div style={{ width: "min(380px, calc(100vw - 32px))" }}>
                <div style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--app-surface-border-color)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                }}>
                  <Text as="h2" variant="headingSm">
                    {t.tasks?.notificationsTitle || "Messages"}
                  </Text>
                  {messageHistory.length > 0 && (
                    <Button
                      variant="plain"
                      size="slim"
                      onClick={() => { clearHistory(); closePopover(); }}
                    >
                      {t.tasks?.notificationsClearAll || "Clear all"}
                    </Button>
                  )}
                </div>
                <Scrollable
                  id={MESSAGE_LIST_ID}
                  // No horizontal scrolling: Polaris defaults it to on, and
                  // the rows wrap rather than run wide.
                  horizontal={false}
                  style={{
                    maxHeight: "min(300px, 60vh)",
                    // Reaching the end of the list must not chain the scroll
                    // through to the page behind the panel — the other half of
                    // the freeze `useScrollLock` provides.
                    overscrollBehavior: "contain",
                  }}
                >
                  {messageHistory.length === 0 ? (
                    <div style={{ padding: "24px 16px", textAlign: "center" }}>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t.tasks?.notificationsEmpty || "No messages"}
                      </Text>
                    </div>
                  ) : (
                    messageHistory.map((entry) => (
                      <div
                        key={entry.id}
                        style={{
                          padding: "10px 16px",
                          borderBottom: "1px solid var(--app-surface-border-color)",
                          display: "flex",
                          gap: "10px",
                          alignItems: "flex-start",
                        }}
                      >
                        {/* The dot is the only carrier of "error" vs "success"
                            in this list. At 8px that fails for colour-blind
                            readers and says nothing at all to a screen reader,
                            so the tone is spelled out beside it — using the
                            same four strings the announcement region uses. */}
                        <span
                          aria-hidden="true"
                          style={{
                            width: "8px",
                            height: "8px",
                            borderRadius: "50%",
                            backgroundColor: toneColor(entry.tone),
                            flexShrink: 0,
                            marginTop: "6px",
                          }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text as="span" visuallyHidden>{toneLabel(entry.tone)}</Text>
                          <Text as="p" variant="bodySm" breakWord>
                            {entry.message}
                          </Text>
                          {entry.link && (
                            <Button
                              variant="plain"
                              size="slim"
                              onClick={() => {
                                closePopover();
                                handleInfoBoxLink(entry.link!.url);
                              }}
                            >
                              {entry.link.label}
                            </Button>
                          )}
                        </div>
                        {/* Only the time is shown — the full stamp is in the
                            title and the machine-readable value in `dateTime`,
                            so an entry from yesterday is not just "08:15". */}
                        <time
                          dateTime={entry.timestamp.toISOString()}
                          title={fullTimestampFormat.format(entry.timestamp)}
                          style={{ flexShrink: 0 }}
                        >
                          <Text as="span" variant="bodySm" tone="subdued">
                            {timeFormat.format(entry.timestamp)}
                          </Text>
                        </time>
                      </div>
                    ))
                  )}
                </Scrollable>
              </div>
            </Popover>
          </div>

          {/* Loading Indicator - shows for navigation or global loading state */}
          {(showLoadingIndicator || isGlobalLoading) && (
            <div
              className="desktop-only"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Spinner size="small" />
              <Text as="span" variant="bodySm" tone="subdued">
                {t.common.loading}
              </Text>
            </div>
          )}

          {/* Initial-sync progress — occupies the infobox slot until done */}
          {syncProgress && (
            <div className="nav-infobox-wrapper" style={{ flex: 1, maxWidth: "600px" }}>
              <div
                className="info-box"
                role="status"
                aria-live="polite"
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "4px",
                  backgroundColor: toneBg(syncProgress.error ? "critical" : "info"),
                  border: `1px solid ${toneColor(syncProgress.error ? "critical" : "info")}`,
                  fontSize: "14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                }}
              >
                <span style={{ color: "#202223" }}>
                  {syncProgress.error
                    ? `${t.settings?.syncingContent || "Sync"}: ${syncProgress.error}`
                    : `${t.settings?.syncingContent || "Setting up your store"}${
                        syncProgress.phase
                          ? ` — ${syncPhaseLabel(
                              t.settings as unknown as Record<string, string>,
                              syncProgress.phase,
                            )}`
                          : ""
                      } (${syncProgress.percent}%)`}
                </span>
                {!syncProgress.error && (() => {
                  const overall = overallSyncPercent(syncProgress.phase, syncProgress.percent);
                  const Bar = ({ value }: { value: number }) => (
                    <div
                      style={{
                        height: "4px",
                        borderRadius: "2px",
                        backgroundColor: "rgba(0,0,0,0.1)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${value}%`,
                          backgroundColor: toneColor("info"),
                          transition: "width 0.4s ease",
                        }}
                      />
                    </div>
                  );
                  const phaseLabel = (p: string) =>
                    syncPhaseLabel(t.settings as unknown as Record<string, string>, p);
                  const synced = SYNC_PHASE_ORDER
                    .filter((p) => (syncProgress.stats?.[p] ?? 0) > 0)
                    .map((p) => `${phaseLabel(p)}: ${syncProgress.stats![p]}`);
                  return (
                    <>
                      <Bar value={syncProgress.percent} />
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.15rem" }}>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {t.settings?.syncTotalLabel || "Total"}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {overall}%
                        </Text>
                      </div>
                      <Bar value={overall} />
                      {synced.length > 0 && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {synced.join(" · ")}
                        </Text>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Active message — a status STRIP, not a control.

              It used to BE the popover's activator: a `div` with an onClick,
              carrying `role="status"`, wrapping both the close button and the
              bell. Three separate defects came out of that one shape. Polaris
              writes `aria-expanded`/`aria-controls` onto the first FOCUSABLE
              node of an activator (`setActivatorAttributes` in its Popover),
              which here was the deep link or the × — neither of which opens
              anything. A `div` with an onClick is not reachable by keyboard,
              and because the bell was hidden on desktop whenever a banner was
              up, keyboard and screen-reader users had no way into the history
              at all. And a live region that is also a button contradicts
              itself: `status` announces, it does not invite a click.

              So the strip only reports, the bell alone opens the list, and
              the announcement lives in its own always-mounted region below.
              The strip no longer carries a count badge either — the bell
              beside it has one, and the two showed different numbers (total
              vs unread) for the same situation. */}
          {!syncProgress && infoBox && (
            <div className="nav-infobox-wrapper desktop-only" style={{ flex: 1, maxWidth: "600px" }}>
              <div
                className="info-box"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  padding: "0.5rem 1rem",
                  borderRadius: "4px",
                  backgroundColor: toneBg(infoBox.tone),
                  border: `1px solid ${toneColor(infoBox.tone)}`,
                  fontSize: "14px",
                  gap: "0.5rem",
                }}
              >
                {/* The link is a SIBLING of the clamped text, not inside it:
                    the clamp cuts everything in its box, so a message longer
                    than two lines used to take the link with it — and the
                    link is the one part of a message that has to stay
                    reachable. The full text is recoverable from the title,
                    and in the bell. */}
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "0.15rem",
                  }}
                >
                  <span
                    title={infoBox.message}
                    style={{
                      color: "var(--p-color-text)",
                      // A message can carry a GID, a URL or a raw GraphQL
                      // error. Without a break rule one long token stretched
                      // the strip, wrapped the whole nav row and pushed the
                      // page down.
                      overflowWrap: "anywhere",
                      // Two lines, then ellipsis, so the navigation keeps its
                      // height whatever a call site passes in.
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 2,
                      overflow: "hidden",
                    }}
                  >
                    {infoBox.message}
                  </span>
                  {infoBox.link && (
                    <Button
                      variant="plain"
                      onClick={() => handleInfoBoxLink(infoBox.link!.url)}
                    >
                      {infoBox.link.label}
                    </Button>
                  )}
                </div>
                <Button
                  variant="plain"
                  icon={XIcon}
                  accessibilityLabel={t.common.close}
                  onClick={hideInfoBox}
                />
              </div>
            </div>
          )}

          {/* TWO always-mounted live regions, used alternately.

              The strip used to carry `role="status"` itself, and it enters the
              DOM together with its text — screen readers generally announce a
              live region only if it existed BEFORE the change, so most
              messages were never read out at all. These nodes are always
              present and only their text changes, which also covers mobile,
              where the strip is not rendered.

              Alternating rather than one node, because a region announces a
              CHANGE: a retry that fails with the very same sentence would
              write identical text and stay silent — and identical consecutive
              messages are exactly what this history is built to keep. Writing
              into the other region makes every message a change in its own
              node. */}
          {[0, 1].map((slot) => (
            <div
              key={slot}
              role="status"
              aria-live="polite"
              style={{
                position: "absolute",
                width: "1px",
                height: "1px",
                margin: "-1px",
                padding: 0,
                border: 0,
                overflow: "hidden",
                clip: "rect(0 0 0 0)",
                whiteSpace: "nowrap",
              }}
            >
              {announcement.slot === slot ? announcement.text : ""}
            </div>
          ))}

          {/* Plan Buttons - alle Pläne auf Desktop, nur aktiver Plan auf Mobile.
              Unter 1100px ist die rechte Editor-Sidebar ausgeblendet: dort
              übernimmt ihr Umschalter diesen Platz (der Plan bleibt über
              Einstellungen → Plan erreichbar). Rein per CSS-Media-Query, damit
              beim Drehen/Resizen kein Re-Render nötig ist. */}
          <div style={{ marginLeft: "auto" }}>
            {sidebarPanel.available && (
              <div className="sidebar-panel-toggle-slot">
                <Button
                  onClick={sidebarPanel.toggle}
                  pressed={sidebarPanel.open}
                  size="slim"
                  // The accessible name has to START with the visible label,
                  // otherwise voice control can't activate the button by what
                  // it says (WCAG 2.5.3).
                  accessibilityLabel={`${t.seo?.title || "SEO Score"} — ${
                    sidebarPanel.open
                      ? (t.seo?.hidePanel || "Back to content")
                      : (t.seo?.showPanel || "Show SEO score")
                  }`}
                >
                  {t.seo?.title || "SEO Score"}
                </Button>
              </div>
            )}
            {/* Desktop: alle Pläne als segmented ButtonGroup */}
            <div className={`desktop-only plan-buttons-slot${sidebarPanel.available ? " has-sidebar-toggle" : ""}`}>
              <ButtonGroup variant="segmented">
                {plans.map((p) => (
                  <Button
                    key={p}
                    onClick={handlePlanNavigation}
                    pressed={p === plan}
                    size="slim"
                    accessibilityLabel={`Plan: ${PLAN_DISPLAY_NAMES[p]}${p === plan ? " (active)" : ""}`}
                  >
                    {PLAN_DISPLAY_NAMES[p]}
                  </Button>
                ))}
              </ButtonGroup>
            </div>
            {/* Mobile: nur aktiver Plan */}
            <div className={`mobile-only plan-buttons-slot${sidebarPanel.available ? " has-sidebar-toggle" : ""}`}>
              <Button
                onClick={handlePlanNavigation}
                pressed
                accessibilityLabel={`Current plan: ${getPlanDisplayName()}`}
              >
                {getPlanDisplayName()}
              </Button>
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}
