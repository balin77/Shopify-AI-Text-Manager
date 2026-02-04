/**
 * Loading Skeleton Component
 * Provides Polaris-compliant skeleton screens for better perceived performance
 * Following Shopify Design Guidelines for loading states
 */

import { Page, Card, SkeletonPage, SkeletonBodyText, SkeletonDisplayText, BlockStack, InlineStack } from "@shopify/polaris";

interface LoadingSkeletonProps {
  /** Type of skeleton to display */
  type?: "page" | "content-editor" | "list" | "form";
  /** Show title skeleton */
  showTitle?: boolean;
  /** Number of content lines */
  lines?: number;
}

/**
 * Generic Loading Skeleton
 * Use this for consistent loading states across the app
 */
export function LoadingSkeleton({ type = "page", showTitle = true, lines = 5 }: LoadingSkeletonProps) {
  if (type === "page") {
    return (
      <SkeletonPage primaryAction secondaryActions={2}>
        <BlockStack gap="400">
          <Card>
            <SkeletonBodyText lines={3} />
          </Card>
          <Card>
            <SkeletonBodyText lines={3} />
          </Card>
        </BlockStack>
      </SkeletonPage>
    );
  }

  if (type === "content-editor") {
    return (
      <Page>
        <BlockStack gap="400">
          {/* Item List Skeleton */}
          <Card>
            {showTitle && <SkeletonDisplayText size="small" />}
            <div style={{ marginTop: "1rem" }}>
              <SkeletonBodyText lines={8} />
            </div>
          </Card>

          {/* Editor Area Skeleton */}
          <Card>
            <BlockStack gap="400">
              {/* Language Bar */}
              <InlineStack gap="200">
                <div style={{ width: "80px", height: "32px", backgroundColor: "#f3f4f6", borderRadius: "4px" }} />
                <div style={{ width: "80px", height: "32px", backgroundColor: "#f3f4f6", borderRadius: "4px" }} />
                <div style={{ width: "80px", height: "32px", backgroundColor: "#f3f4f6", borderRadius: "4px" }} />
              </InlineStack>

              {/* Fields */}
              <SkeletonBodyText lines={lines || 5} />
            </BlockStack>
          </Card>
        </BlockStack>
      </Page>
    );
  }

  if (type === "list") {
    return (
      <Card>
        <BlockStack gap="400">
          {Array.from({ length: lines || 5 }).map((_, index) => (
            <div key={index} style={{ display: "flex", gap: "12px", alignItems: "center" }}>
              <div style={{ width: "40px", height: "40px", backgroundColor: "#f3f4f6", borderRadius: "4px" }} />
              <div style={{ flex: 1 }}>
                <SkeletonBodyText lines={2} />
              </div>
            </div>
          ))}
        </BlockStack>
      </Card>
    );
  }

  if (type === "form") {
    return (
      <Card>
        <BlockStack gap="400">
          {showTitle && <SkeletonDisplayText size="medium" />}
          {Array.from({ length: lines || 3 }).map((_, index) => (
            <div key={index}>
              <div style={{ width: "120px", height: "16px", backgroundColor: "#f3f4f6", borderRadius: "4px", marginBottom: "8px" }} />
              <div style={{ width: "100%", height: "40px", backgroundColor: "#f3f4f6", borderRadius: "8px" }} />
            </div>
          ))}
        </BlockStack>
      </Card>
    );
  }

  // Default fallback
  return (
    <Card>
      <SkeletonBodyText lines={lines} />
    </Card>
  );
}

/**
 * Content Editor Loading Skeleton
 * Specialized skeleton for the unified content editor
 */
export function ContentEditorLoadingSkeleton() {
  return (
    <Page>
      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr 280px", gap: "16px" }}>
        {/* Left: Item List */}
        <Card>
          <BlockStack gap="300">
            {/* Search bar */}
            <div style={{ width: "100%", height: "36px", backgroundColor: "#f3f4f6", borderRadius: "8px" }} />

            {/* Items */}
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} style={{ padding: "12px", borderRadius: "8px", backgroundColor: "#fafbfb" }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <div style={{ width: "40px", height: "40px", backgroundColor: "#e1e3e5", borderRadius: "4px" }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ width: "80%", height: "16px", backgroundColor: "#e1e3e5", borderRadius: "4px", marginBottom: "4px" }} />
                    <div style={{ width: "60%", height: "12px", backgroundColor: "#e1e3e5", borderRadius: "4px" }} />
                  </div>
                </div>
              </div>
            ))}

            {/* Pagination */}
            <InlineStack gap="200" align="center">
              <div style={{ width: "32px", height: "32px", backgroundColor: "#f3f4f6", borderRadius: "4px" }} />
              <div style={{ width: "60px", height: "16px", backgroundColor: "#f3f4f6", borderRadius: "4px" }} />
              <div style={{ width: "32px", height: "32px", backgroundColor: "#f3f4f6", borderRadius: "4px" }} />
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Middle: Content Editor */}
        <BlockStack gap="400">
          {/* Language Bar */}
          <Card>
            <InlineStack gap="200" wrap={false}>
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} style={{ width: "80px", height: "32px", backgroundColor: "#f3f4f6", borderRadius: "6px" }} />
              ))}
            </InlineStack>
          </Card>

          {/* Operation Buttons */}
          <Card>
            <InlineStack gap="200">
              <div style={{ width: "120px", height: "36px", backgroundColor: "#f3f4f6", borderRadius: "6px" }} />
              <div style={{ width: "100px", height: "36px", backgroundColor: "#f3f4f6", borderRadius: "6px" }} />
              <div style={{ width: "80px", height: "36px", backgroundColor: "#f3f4f6", borderRadius: "6px" }} />
            </InlineStack>
          </Card>

          {/* Fields */}
          <Card>
            <BlockStack gap="400">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index}>
                  <div style={{ width: "100px", height: "16px", backgroundColor: "#f3f4f6", borderRadius: "4px", marginBottom: "8px" }} />
                  <div style={{ width: "100%", height: "44px", backgroundColor: "#f3f4f6", borderRadius: "8px" }} />
                </div>
              ))}
            </BlockStack>
          </Card>
        </BlockStack>

        {/* Right: SEO Sidebar */}
        <Card>
          <BlockStack gap="400">
            <div style={{ width: "120px", height: "20px", backgroundColor: "#f3f4f6", borderRadius: "4px" }} />
            <div style={{ width: "100%", height: "100px", backgroundColor: "#f3f4f6", borderRadius: "8px" }} />
            <SkeletonBodyText lines={4} />
          </BlockStack>
        </Card>
      </div>
    </Page>
  );
}

/**
 * Inline Field Loading Skeleton
 * Use this for individual fields that are loading
 */
export function FieldLoadingSkeleton({ label }: { label?: string }) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      {label ? (
        <div style={{ marginBottom: "0.5rem", fontSize: "14px", fontWeight: 500, color: "#202223" }}>
          {label}
        </div>
      ) : (
        <div style={{ width: "100px", height: "16px", backgroundColor: "#f3f4f6", borderRadius: "4px", marginBottom: "8px" }} />
      )}
      <div style={{ width: "100%", height: "44px", backgroundColor: "#f3f4f6", borderRadius: "8px" }} />
    </div>
  );
}

/**
 * Loading Overlay
 * Use this for inline loading states that overlay content
 */
export function LoadingOverlay({ message = "Loading..." }: { message?: string }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(255, 255, 255, 0.8)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        zIndex: 100,
        borderRadius: "8px",
      }}
      role="status"
      aria-live="polite"
      aria-label={message}
    >
      <div className="spinner" style={{ width: "32px", height: "32px", border: "3px solid #e1e3e5", borderTop: "3px solid #0066CC", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <div style={{ fontSize: "14px", color: "#202223", fontWeight: 500 }}>
        {message}
      </div>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
