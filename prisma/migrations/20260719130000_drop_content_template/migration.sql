-- Rollback of 20260518100000_add_content_template
--
-- The Content-Templates feature was retired one day after being merged:
-- design review concluded that {{variable}} substitution provided no
-- information the AI wasn't already receiving via the handler's
-- Context/Language/Current-value prompt lines, making the feature a
-- redundant second surface next to the existing per-field AISettings
-- custom instructions. See docs/reference/COMPETITIVE_ANALYSIS.md changelog.

-- DropIndex
DROP INDEX IF EXISTS "ContentTemplate_default_uniq";

-- DropIndex
DROP INDEX IF EXISTS "ContentTemplate_shop_contentType_fieldType_idx";

-- DropIndex
DROP INDEX IF EXISTS "ContentTemplate_shop_idx";

-- DropTable
DROP TABLE IF EXISTS "ContentTemplate";
