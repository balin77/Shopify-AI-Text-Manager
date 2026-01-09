import { Card, BlockStack, Text, InlineStack, Badge, Button, ProgressBar } from "@shopify/polaris";
import { useState, useEffect } from "react";
import { useI18n } from "../contexts/I18nContext";

interface SeoIssue {
  type: "error" | "warning" | "success";
  message: string;
  points: number;
}

interface SeoAnalysis {
  score: number;
  issues: SeoIssue[];
  recommendations: string[];
}

interface SeoSidebarProps {
  title: string;
  description: string;
  handle?: string;
  seoTitle: string;
  metaDescription: string;
  imagesWithAlt?: number;
  totalImages?: number;
}

export function SeoSidebar({
  title,
  description,
  handle,
  seoTitle,
  metaDescription,
  imagesWithAlt = 0,
  totalImages = 0,
}: SeoSidebarProps) {
  const { t } = useI18n();
  const [analysis, setAnalysis] = useState<SeoAnalysis>({ score: 0, issues: [], recommendations: [] });
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    const newAnalysis = analyzeSEO();
    setAnalysis(newAnalysis);
  }, [title, description, handle, seoTitle, metaDescription, imagesWithAlt, totalImages]);

  const analyzeSEO = (): SeoAnalysis => {
    const issues: SeoIssue[] = [];
    let score = 0;

    // 1. Title length (15 points max)
    const titleLength = title.length;
    if (titleLength >= 30 && titleLength <= 70) {
      score += 15;
      issues.push({
        type: "success",
        message: t.seo.issues.titleLengthGood,
        points: 15,
      });
    } else if (titleLength < 30) {
      issues.push({
        type: "warning",
        message: t.seo.issues.titleTooShort,
        points: 0,
      });
    } else {
      issues.push({
        type: "warning",
        message: t.seo.issues.titleTooLong,
        points: 0,
      });
    }

    // 2. SEO Title (15 points max)
    const seoTitleLength = seoTitle.length;
    if (seoTitleLength > 0 && seoTitleLength <= 60) {
      score += 15;
      issues.push({
        type: "success",
        message: t.seo.issues.seoTitleGood,
        points: 15,
      });
    } else if (seoTitleLength === 0) {
      issues.push({
        type: "error",
        message: t.seo.issues.seoTitleMissing,
        points: 0,
      });
    } else {
      issues.push({
        type: "warning",
        message: t.seo.issues.seoTitleTooLong,
        points: 0,
      });
    }

    // 3. Description length (20 points max)
    const descriptionText = description.replace(/<[^>]*>/g, "");
    const descriptionLength = descriptionText.length;
    if (descriptionLength >= 150) {
      score += 20;
      issues.push({
        type: "success",
        message: t.seo.issues.descriptionGood,
        points: 20,
      });
    } else if (descriptionLength === 0) {
      issues.push({
        type: "error",
        message: t.seo.issues.descriptionMissing,
        points: 0,
      });
    } else {
      issues.push({
        type: "warning",
        message: t.seo.issues.descriptionTooShort,
        points: 0,
      });
    }

    // 4. Meta Description (20 points max)
    const metaDescLength = metaDescription.length;
    if (metaDescLength >= 120 && metaDescLength <= 160) {
      score += 20;
      issues.push({
        type: "success",
        message: t.seo.issues.metaDescriptionGood,
        points: 20,
      });
    } else if (metaDescLength === 0) {
      issues.push({
        type: "error",
        message: t.seo.issues.metaDescriptionMissing,
        points: 0,
      });
    } else if (metaDescLength < 120) {
      issues.push({
        type: "warning",
        message: t.seo.issues.metaDescriptionTooShort,
        points: 0,
      });
    } else {
      issues.push({
        type: "warning",
        message: t.seo.issues.metaDescriptionTooLong,
        points: 0,
      });
    }

    // 5. Image Alt Texts (30 points max)
    if (totalImages > 0) {
      const imageScore = Math.round((imagesWithAlt / totalImages) * 30);
      score += imageScore;
      if (imagesWithAlt === totalImages) {
        issues.push({
          type: "success",
          message: t.seo.issues.allImagesHaveAlt,
          points: 30,
        });
      } else {
        issues.push({
          type: "warning",
          message: t.seo.issues.someImagesMissingAlt.replace("{count}", String(totalImages - imagesWithAlt)),
          points: imageScore,
        });
      }
    }

    // Generate recommendations
    const recommendations: string[] = [];
    if (titleLength < 30) recommendations.push(t.seo.recommendations.expandTitle);
    if (titleLength > 70) recommendations.push(t.seo.recommendations.shortenTitle);
    if (seoTitleLength === 0) recommendations.push(t.seo.recommendations.addSeoTitle);
    if (seoTitleLength > 60) recommendations.push(t.seo.recommendations.shortenSeoTitle);
    if (descriptionLength < 150) recommendations.push(t.seo.recommendations.expandDescription);
    if (metaDescLength === 0) recommendations.push(t.seo.recommendations.addMetaDescription);
    if (metaDescLength < 120) recommendations.push(t.seo.recommendations.expandMetaDescription);
    if (metaDescLength > 160) recommendations.push(t.seo.recommendations.shortenMetaDescription);
    if (totalImages > 0 && imagesWithAlt < totalImages) recommendations.push(t.seo.recommendations.addImageAlt);

    return {
      score: Math.round(score),
      issues,
      recommendations,
    };
  };

  const getScoreColor = (score: number): "success" | "warning" | "critical" => {
    if (score >= 70) return "success";
    if (score >= 40) return "warning";
    return "critical";
  };

  const getScoreLabel = (score: number): string => {
    if (score >= 70) return t.seo.scoreLabels.good;
    if (score >= 40) return t.seo.scoreLabels.medium;
    return t.seo.scoreLabels.poor;
  };

  return (
    <Card>
      <BlockStack gap="400">
        {/* SEO Score Header */}
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: "80px",
              height: "80px",
              borderRadius: "50%",
              background: score >= 70 ? "#e3f2e9" : score >= 40 ? "#fff4e5" : "#fbeae5",
              border: `3px solid ${score >= 70 ? "#008060" : score >= 40 ? "#f59e00" : "#d72c0d"}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto",
              cursor: "pointer",
            }}
            onClick={() => setShowDetails(!showDetails)}
          >
            <Text as="h1" variant="heading2xl" fontWeight="bold">
              {analysis.score}
            </Text>
          </div>
          <div style={{ marginTop: "0.5rem" }}>
            <Text as="p" variant="headingMd">
              {t.seo.title}
            </Text>
            <Badge tone={getScoreColor(analysis.score)}>{getScoreLabel(analysis.score)}</Badge>
          </div>
        </div>

        {/* Progress Bar */}
        <div>
          <ProgressBar progress={analysis.score} tone={getScoreColor(analysis.score)} size="small" />
        </div>

        {/* Issues Summary */}
        <BlockStack gap="200">
          <Text as="p" variant="headingSm" fontWeight="semibold">
            {t.seo.issuesTitle}
          </Text>
          {analysis.issues.map((issue, index) => (
            <InlineStack key={index} gap="200" align="start">
              <div style={{ marginTop: "2px" }}>
                {issue.type === "success" && "✅"}
                {issue.type === "warning" && "⚠️"}
                {issue.type === "error" && "❌"}
              </div>
              <div style={{ flex: 1 }}>
                <Text as="p" variant="bodySm">
                  {issue.message}
                </Text>
              </div>
            </InlineStack>
          ))}
        </BlockStack>

        {/* Recommendations */}
        {analysis.recommendations.length > 0 && (
          <BlockStack gap="200">
            <Text as="p" variant="headingSm" fontWeight="semibold">
              {t.seo.recommendationsTitle}
            </Text>
            {analysis.recommendations.map((recommendation, index) => (
              <InlineStack key={index} gap="200" align="start">
                <div style={{ marginTop: "2px" }}>💡</div>
                <div style={{ flex: 1 }}>
                  <Text as="p" variant="bodySm">
                    {recommendation}
                  </Text>
                </div>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        {/* Score Details (Expandable) */}
        {showDetails && (
          <div
            style={{
              padding: "1rem",
              background: "#f6f6f7",
              borderRadius: "8px",
              border: "1px solid #c9cccf",
            }}
          >
            <BlockStack gap="200">
              <Text as="p" variant="headingSm" fontWeight="semibold">
                {t.seo.scoreDetailsTitle}
              </Text>
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      15 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.titleLength}
                  </Text>
                </InlineStack>
              </div>
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      15 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.seoTitle}
                  </Text>
                </InlineStack>
              </div>
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      20 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.description}
                  </Text>
                </InlineStack>
              </div>
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      20 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.metaDescription}
                  </Text>
                </InlineStack>
              </div>
              <div>
                <InlineStack gap="200" blockAlign="center">
                  <div style={{ width: "50px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      30 {t.seo.points}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm">
                    {t.seo.criteria.imageAlt}
                  </Text>
                </InlineStack>
              </div>
            </BlockStack>
          </div>
        )}

        {/* Toggle Details Button */}
        <Button onClick={() => setShowDetails(!showDetails)} variant="plain" size="slim">
          {showDetails ? t.seo.hideDetails : t.seo.showDetails}
        </Button>
      </BlockStack>
    </Card>
  );
}
