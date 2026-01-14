/**
 * ContentTypeNavigation - Horizontal navigation for all content types
 *
 * This component provides consistent navigation across all content management pages
 */

import { useNavigate, useLocation } from "@remix-run/react";
import { InlineStack, Text, Tooltip } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { type ContentType as PlanContentType } from "../config/plans";
import { getPlanDisplayName as getPlanDisplayNameUtil } from "../utils/planUtils";
import { useState, useEffect, useRef } from "react";

type ContentType = "collections" | "blogs" | "pages" | "policies" | "menus" | "templates" | "metaobjects" | "shopMetadata";

interface ContentTypeConfig {
  id: ContentType;
  label: string;
  icon: string;
  description: string;
  path: string;
  comingSoon?: boolean;
  planContentType: PlanContentType; // Maps to plan config
}

export function ContentTypeNavigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();
  const { canAccessContentType, getNextPlanUpgrade } = usePlan();
  const { mainNavHeight, setContentNavHeight } = useNavigationHeight();
  const navRef = useRef<HTMLDivElement>(null);
  const [navHeight, setNavHeight] = useState(85);

  const contentTypes: ContentTypeConfig[] = [
    { id: "collections", label: t.content.collections, icon: "📂", description: t.content.collectionsDescription, path: "/app/collections", planContentType: "collections" },
    { id: "blogs", label: t.content.blogs, icon: "📝", description: t.content.blogsDescription, path: "/app/blog", planContentType: "articles" },
    { id: "pages", label: t.content.pages, icon: "📄", description: t.content.pagesDescription, path: "/app/pages", planContentType: "pages" },
    { id: "policies", label: t.content.policies, icon: "📋", description: t.content.policiesDescription, path: "/app/policies", planContentType: "policies" },
    { id: "menus", label: t.content.menus, icon: "🍔", description: t.content.menusDescription, path: "/app/content?type=menus", planContentType: "menus" },
    { id: "templates", label: t.content.templates, icon: "🧪", description: "Theme translatable resources...", path: "/app/templates", planContentType: "themes" },
    { id: "metaobjects", label: t.content.metaobjects, icon: "🗂️", description: t.content.metaobjectsDescription, path: "/app/content?type=metaobjects", comingSoon: true, planContentType: "metaobjects" },
    { id: "shopMetadata", label: t.content.shopMetadata, icon: "🏷️", description: t.content.shopMetadataDescription, path: "/app/content?type=shopMetadata", comingSoon: true, planContentType: "metadata" },
  ];

  // Determine which tab is currently active based on the location
  const getActiveType = (): string | null => {
    if (location.pathname === "/app/collections") return "collections";
    if (location.pathname === "/app/blog") return "blogs";
    if (location.pathname === "/app/pages") return "pages";
    if (location.pathname === "/app/policies") return "policies";
    if (location.pathname === "/app/templates") return "templates";
    if (location.pathname === "/app/content") {
      const params = new URLSearchParams(location.search);
      return params.get("type") || "menus";
    }
    return null;
  };

  const activeType = getActiveType();

  // Dynamically measure content navigation height and update context
  useEffect(() => {
    const updateHeight = () => {
      if (navRef.current) {
        const height = navRef.current.offsetHeight;
        setNavHeight(height);
        setContentNavHeight(height); // Update context for other components
      }
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);

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
  }, [setContentNavHeight]);

  return (
    <>
      {/* Fixed Navigation */}
      <div ref={navRef} style={{ borderBottom: "1px solid #e1e3e5", background: "white", padding: "1rem 1rem 1rem 1rem", paddingTop: "1.5rem", position: "fixed", top: `${mainNavHeight}px`, left: 0, right: 0, zIndex: 999, overflowX: "auto" }}>
        <InlineStack gap="300">
          {contentTypes.map((type) => {
            const hasAccess = canAccessContentType(type.planContentType);
            const isDisabled = type.comingSoon || !hasAccess;
            const nextPlan = getNextPlanUpgrade();

            const button = (
              <button
                key={type.id}
                onClick={() => {
                  if (!isDisabled) {
                    navigate(type.path);
                  }
                }}
                disabled={isDisabled}
                style={{
                  padding: "0.75rem 1.5rem",
                  border: activeType === type.id ? "2px solid #008060" : "1px solid #c9cccf",
                  borderRadius: "8px",
                  background: activeType === type.id ? "#f1f8f5" : isDisabled ? "#f6f6f7" : "white",
                  cursor: isDisabled ? "not-allowed" : "pointer",
                  transition: "all 0.2s",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  opacity: isDisabled ? 0.5 : 1,
                }}
              >
                <span style={{ fontSize: "1.2rem" }}>{type.icon}</span>
                <Text
                  as="span"
                  variant="bodyMd"
                  fontWeight={activeType === type.id ? "semibold" : "regular"}
                >
                  {type.label}
                </Text>
                {!hasAccess && !type.comingSoon && (
                  <span style={{ marginLeft: "0.25rem" }}>🔒</span>
                )}
                {type.comingSoon && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    (Coming Soon)
                  </Text>
                )}
              </button>
            );

            // Wrap with tooltip if locked by plan
            if (!hasAccess && !type.comingSoon && nextPlan) {
              const nextPlanName = getPlanDisplayNameUtil(nextPlan);
              const tooltipText = t.content.upgradeToAccessFeature.replace('{plan}', nextPlanName);
              return (
                <Tooltip key={type.id} content={tooltipText}>
                  {button}
                </Tooltip>
              );
            }

            return button;
          })}
        </InlineStack>
      </div>

      {/* Dynamic spacer to prevent content from going under fixed navigations */}
      <div style={{ height: `${navHeight}px` }} />
    </>
  );
}
