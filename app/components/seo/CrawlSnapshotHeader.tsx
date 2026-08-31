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
import { useHydrated } from "../../hooks/useHydrated";
import { formatDateTime } from "../../utils/format";
import { BLOCK_SOURCE_TEXT_KEY } from "../../utils/task-error-text";
import type { SnapshotHeaderView } from "../../services/seo/crawl.shared";

export function CrawlSnapshotHeader({
  snapshot,
  running,
  gated,
  children,
}: {
  snapshot: SnapshotHeaderView | null;
  /** A `seoCrawl` task is running server-side (from the shared loader). */
  running: boolean;
  gated: boolean;
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
  // The snapshot timestamp is rendered in the merchant's time zone, which the
  // server does not know — only render it localized after hydration.
  const hydrated = useHydrated();

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
  const blockSourceText = snapshot?.blockedBy ? c[BLOCK_SOURCE_TEXT_KEY[snapshot.blockedBy]] : null;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" variant="bodySm" tone="subdued">
            {snapshot
              ? c.lastScanned.replace("{time}", formatDateTime(snapshot.finishedAt || snapshot.startedAt, hydrated))
              : c.neverScanned}
          </Text>
          <Button
            variant="primary"
            onClick={handleScanNow}
            disabled={gated || scanInProgress || scanFetcher.state !== "idle"}
            loading={scanFetcher.state !== "idle"}
          >
            {c.scanNow}
          </Button>
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

        {snapshot?.status === "failed" && !scanInProgress && (
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
