import { useState, useMemo } from "react";
import { Card, Text, BlockStack, InlineStack, Spinner } from "@shopify/polaris";

export interface StorageData {
  label: string;
  value: number; // in bytes
  color: string;
}

interface StoragePieChartProps {
  data: StorageData[];
  title: string;
  loading?: boolean;
  t: any;
}

// Format bytes to human-readable string
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function StoragePieChart({ data, title, loading, t }: StoragePieChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const total = useMemo(() => data.reduce((sum, item) => sum + item.value, 0), [data]);

  // Calculate pie chart segments
  const segments = useMemo(() => {
    if (total === 0) return [];

    let currentAngle = -90; // Start from top
    return data.map((item, index) => {
      const percentage = (item.value / total) * 100;
      const angle = (item.value / total) * 360;
      const startAngle = currentAngle;
      const endAngle = currentAngle + angle;
      currentAngle = endAngle;

      // Calculate path for pie segment
      const startRad = (startAngle * Math.PI) / 180;
      const endRad = (endAngle * Math.PI) / 180;

      const x1 = 50 + 40 * Math.cos(startRad);
      const y1 = 50 + 40 * Math.sin(startRad);
      const x2 = 50 + 40 * Math.cos(endRad);
      const y2 = 50 + 40 * Math.sin(endRad);

      const largeArcFlag = angle > 180 ? 1 : 0;

      // For very small segments, use a line instead
      if (angle < 0.5) {
        return {
          ...item,
          path: "",
          percentage,
          index,
        };
      }

      // For full circle (single segment = 100%)
      if (angle >= 359.9) {
        return {
          ...item,
          path: `M 50 10 A 40 40 0 1 1 49.99 10 A 40 40 0 1 1 50 10`,
          percentage,
          index,
        };
      }

      const path = `M 50 50 L ${x1} ${y1} A 40 40 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;

      return {
        ...item,
        path,
        percentage,
        index,
      };
    });
  }, [data, total]);

  // Filter out segments with 0 value for legend
  const nonZeroSegments = segments.filter((s) => s.value > 0);

  if (loading) {
    return (
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            {title}
          </Text>
          <div style={{ display: "flex", justifyContent: "center", padding: "2rem" }}>
            <Spinner size="large" />
          </div>
        </BlockStack>
      </Card>
    );
  }

  if (total === 0) {
    return (
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            {title}
          </Text>
          <Text as="p" tone="subdued">
            {t.settings?.noStorageData || "Keine Speicherdaten verfugbar"}
          </Text>
        </BlockStack>
      </Card>
    );
  }

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">
            {title}
          </Text>
          <Text as="span" tone="subdued">
            {t.settings?.totalStorage || "Gesamt"}: {formatBytes(total)}
          </Text>
        </InlineStack>

        <div style={{ display: "flex", gap: "2rem", alignItems: "center", flexWrap: "wrap" }}>
          {/* Pie Chart SVG */}
          <div style={{ position: "relative", width: "200px", height: "200px", flexShrink: 0 }}>
            <svg viewBox="0 0 100 100" style={{ width: "100%", height: "100%" }}>
              {/* Background circle */}
              <circle cx="50" cy="50" r="40" fill="#f4f6f8" />

              {/* Pie segments */}
              {nonZeroSegments.map((segment) => (
                <path
                  key={segment.index}
                  d={segment.path}
                  fill={segment.color}
                  stroke="white"
                  strokeWidth="0.5"
                  style={{
                    transition: "transform 0.2s ease, opacity 0.2s ease",
                    transformOrigin: "50px 50px",
                    transform: hoveredIndex === segment.index ? "scale(1.05)" : "scale(1)",
                    opacity: hoveredIndex !== null && hoveredIndex !== segment.index ? 0.6 : 1,
                    cursor: "pointer",
                  }}
                  onMouseEnter={() => setHoveredIndex(segment.index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
              ))}

              {/* Center hole for donut effect */}
              <circle cx="50" cy="50" r="25" fill="white" />

              {/* Center text */}
              <text
                x="50"
                y="47"
                textAnchor="middle"
                fontSize="8"
                fontWeight="bold"
                fill="#202223"
              >
                {formatBytes(total).split(" ")[0]}
              </text>
              <text x="50" y="56" textAnchor="middle" fontSize="6" fill="#6d7175">
                {formatBytes(total).split(" ")[1]}
              </text>
            </svg>

            {/* Tooltip */}
            {hoveredIndex !== null && nonZeroSegments[hoveredIndex] && (
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  background: "rgba(0, 0, 0, 0.8)",
                  color: "white",
                  padding: "0.5rem 0.75rem",
                  borderRadius: "4px",
                  fontSize: "12px",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                  zIndex: 10,
                }}
              >
                <strong>
                  {segments.find((s) => s.index === hoveredIndex)?.label}
                </strong>
                <br />
                {formatBytes(segments.find((s) => s.index === hoveredIndex)?.value || 0)}
                <br />({segments.find((s) => s.index === hoveredIndex)?.percentage.toFixed(1)}%)
              </div>
            )}
          </div>

          {/* Legend */}
          <div style={{ flex: 1, minWidth: "200px" }}>
            <BlockStack gap="200">
              {data.map((item, index) => (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    padding: "0.25rem 0.5rem",
                    borderRadius: "4px",
                    background: hoveredIndex === index ? "#f4f6f8" : "transparent",
                    cursor: "pointer",
                    transition: "background 0.2s ease",
                  }}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                >
                  <div
                    style={{
                      width: "12px",
                      height: "12px",
                      borderRadius: "2px",
                      backgroundColor: item.color,
                      flexShrink: 0,
                    }}
                  />
                  <Text as="span" variant="bodySm">
                    {item.label}
                  </Text>
                  <div style={{ flex: 1 }} />
                  <Text as="span" variant="bodySm" tone="subdued">
                    {formatBytes(item.value)}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    ({total > 0 ? ((item.value / total) * 100).toFixed(1) : 0}%)
                  </Text>
                </div>
              ))}
            </BlockStack>
          </div>
        </div>
      </BlockStack>
    </Card>
  );
}
