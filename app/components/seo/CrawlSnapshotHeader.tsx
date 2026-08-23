/**
 * The crawl header both `/app/seo/crawl` and `/app/seo/onpage` render
 * (PLAN_SEO_CRAWL_EXPANSION §0.3).
 *
 * There is exactly ONE crawl. Two tabs reading the same snapshot must
 * therefore say the same thing about it — same timestamp, same progress
 * banner, same "scan now" button, same failure explanation. Duplicating this
 * per route is how the two tabs end up disagreeing about a run the merchant
 * started thirty seconds ago.
 *
 * Owns the whole scan lifecycle (fire the task, poll while it runs), so a
 * route only has to hand it the snapshot view and say whether it is gated.
 * Strings come from `t.seo.crawlPage` in both tabs on purpose: the header IS
 * the crawl, whichever tab it appears on.
 */

import { useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { Card, BlockStack, InlineStack, Text, Button, Banner } from "@shopify/polaris";
import { useI18n } from "../../contexts/I18nContext";
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { BLOCK_SOURCE_TEXT_KEY } from "../../utils/task-error-text";
import type { SnapshotHeaderView } from "../../services/seo/crawl.shared";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function CrawlSnapshotHeader({
  snapshot,
  running,
  gated,
  pendingSettings = false,
  pendingSettingsReason,
  children,
}: {
  snapshot: SnapshotHeaderView | null;
  /** A `seoCrawl` task is running server-side (from the shared loader). */
  running: boolean;
  gated: boolean;
  /**
   * A control in `children` holds an UNSAVED change that would change what this
   * crawl does — so the crawl waits for it.
   *
   * The server reads the STORED value when it starts a run, so a merchant who
   * ticks "check external links" and presses Scan immediately would get a run
   * without them while the box on screen says otherwise. Refusing the start is
   * the only answer that keeps the button honest; the reason is named on it.
   */
  pendingSettings?: boolean;
  pendingSettingsReason?: string;
  /**
   * Rendered inside the same card, below the banners — the controls that change
   * what the crawl DOES (the external-link opt-in) and the warnings about the
   * run itself. NOT the result tiles: those belong to whichever step is open
   * and live in their own card below the step badges, so the page reads
   * explanation → scan → step badges → results.
   */
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const c = (t.seo as any).crawlPage as Record<string, string>;

  const scanFetcher = useFetcher<{ success: boolean; error?: string; taskId?: string }>();
  const [scanStarted, setScanStarted] = useState(false);
  const [scanBanner, setScanBanner] = useState<{ tone: "critical"; message: string } | null>(null);
  const scanStartedAtRef = useRef(0);

  useEffect(() => {
    if (scanFetcher.state !== "idle" || !scanFetcher.data) return;
    if (scanFetcher.data.success) {
      scanStartedAtRef.current = Date.now();
      setScanStarted(true);
    } else {
      setScanBanner({ tone: "critical", message: scanFetcher.data.error || c.scanStartError });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanFetcher.state, scanFetcher.data]);

  const scanInProgress = running || scanStarted;

  const handleScanNow = () => {
    if (gated || scanInProgress || scanFetcher.state !== "idle") return;
    setScanBanner(null);
    const formData = new FormData();
    formData.append("action", "seoCrawl");
    formData.append("contentType", "products");
    scanFetcher.submit(formData, { method: "post", action: "/api/ai" });
  };

  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  useEffect(() => {
    if (!scanInProgress) return;
    const interval = setInterval(() => revalidatorRef.current.revalidate(), 3000);
    return () => clearInterval(interval);
  }, [scanInProgress]);
  useEffect(() => {
    if (!scanStarted || running) return;
    // The task row appears a moment after the POST returns; only give up on
    // the optimistic "started" state once that grace period has passed.
    if (Date.now() - scanStartedAtRef.current > 5000) setScanStarted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, scanStarted]);

  const isCapped = snapshot?.status === "capped";
  /**
   * A run the orphan recovery closed because the process that owned it is gone
   * (orphan-run-recovery.js) — a redeploy, an OOM kill. Stored as a `failed`
   * snapshot, because that is what it is (it has no pages: they are written in
   * one bulk insert at the very end), but shown as a WARNING and with its own
   * text: nothing is wrong with the merchant's storefront, and a red banner
   * telling them to "try again" over our own restart sends them looking for a
   * fault they do not have.
   */
  const isInterrupted = snapshot?.status === "failed" && snapshot.errorCode === "interrupted";
  const blockSourceText = snapshot?.blockedBy ? c[BLOCK_SOURCE_TEXT_KEY[snapshot.blockedBy]] : null;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" variant="bodySm" tone="subdued">
            {snapshot
              ? c.lastScanned.replace("{time}", formatDate(snapshot.finishedAt || snapshot.startedAt))
              : c.neverScanned}
          </Text>
          <DisabledActionTooltip hint={pendingSettings ? pendingSettingsReason : undefined}>
            <Button
              variant="primary"
              onClick={handleScanNow}
              disabled={gated || pendingSettings || scanInProgress || scanFetcher.state !== "idle"}
              loading={scanFetcher.state !== "idle"}
            >
              {c.scanNow}
            </Button>
          </DisabledActionTooltip>
        </InlineStack>

        {scanBanner && (
          <Banner tone={scanBanner.tone} onDismiss={() => setScanBanner(null)}>
            {scanBanner.message}
          </Banner>
        )}
        {!scanBanner && scanInProgress && (
          <Banner tone="info">
            {snapshot && snapshot.totalDiscovered > 0
              ? c.pagesProgress
                  .replace("{crawled}", String(snapshot.pagesCrawled))
                  .replace("{discovered}", String(snapshot.totalDiscovered))
              : c.scanning}
          </Banner>
        )}

        {isInterrupted && !scanInProgress && (
          <Banner tone="warning">{c.errorInterrupted}</Banner>
        )}
        {snapshot?.status === "failed" && !isInterrupted && !scanInProgress && (
          <Banner tone="critical">
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd">
                {snapshot.errorCode === "storefront_password"
                  ? c.errorStorefrontPassword
                  : snapshot.errorCode === "bot_blocked"
                    ? c.errorBotBlocked
                    : c.errorGeneric}
              </Text>
              {snapshot.errorCode === "bot_blocked" && blockSourceText && (
                <Text as="p" variant="bodyMd" fontWeight="semibold">{blockSourceText}</Text>
              )}
            </BlockStack>
          </Banner>
        )}
        {isCapped && !scanInProgress && snapshot && (
          <Banner tone="warning">
            {c.cappedBanner
              .replace("{cap}", String(snapshot.pagesCrawled))
              .replace("{discovered}", String(snapshot.totalDiscovered))}
          </Banner>
        )}

        {children}
      </BlockStack>
    </Card>
  );
}
