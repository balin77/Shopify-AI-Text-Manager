-- PLAN_SEO_CRAWL_EXPANSION §1.4 — purely additive, every column with a default,
-- so no backfill and no downtime risk. Run explicitly via `npm run prisma:migrate`
-- (NEVER as a package.json postdeploy script — see CLAUDE.md).

-- §1.1 / §2.1-§2.2 — indexability, stored raw.
--
-- `metaRobots = ''` does NOT mean "indexable": it means "no tag was served" OR
-- "this row predates the column". `indexabilityKnown` is the only thing that
-- tells those apart — it is set only when the crawl actually parsed a body on
-- that URL. Every consumer must gate on it instead of reading '' as "fine".
ALTER TABLE "SeoCrawlPage"
  ADD COLUMN "metaRobots" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "xRobotsTag" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "indexabilityKnown" BOOLEAN NOT NULL DEFAULT false;

-- §1.1 / §2.3 — on-page. `imgMissingAlt` counts alt="" as missing (valid HTML
-- for decorative images), which is why the UI says "without alt text" and not
-- "error".
ALTER TABLE "SeoCrawlPage"
  ADD COLUMN "h1First" TEXT,
  ADD COLUMN "imgCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "imgMissingAlt" INTEGER NOT NULL DEFAULT 0;

-- §2.4 — observed redirect chain length (0 = no redirect).
ALTER TABLE "SeoCrawlPage"
  ADD COLUMN "redirectHops" INTEGER NOT NULL DEFAULT 0;

-- §1.2 / §6 — external links, one row per UNIQUE target URL (not per edge).
CREATE TABLE "SeoCrawlExternalLink" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "finalUrl" TEXT,
  "sourceCount" INTEGER NOT NULL DEFAULT 0,
  "sampleSources" TEXT NOT NULL DEFAULT '',
  "anchor" TEXT,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SeoCrawlExternalLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoCrawlExternalLink_snapshotId_url_key" ON "SeoCrawlExternalLink"("snapshotId", "url");
CREATE INDEX "SeoCrawlExternalLink_shop_snapshotId_idx" ON "SeoCrawlExternalLink"("shop", "snapshotId");
CREATE INDEX "SeoCrawlExternalLink_shop_snapshotId_statusCode_idx" ON "SeoCrawlExternalLink"("shop", "snapshotId", "statusCode");

ALTER TABLE "SeoCrawlExternalLink"
  ADD CONSTRAINT "SeoCrawlExternalLink_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "SeoCrawlSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
