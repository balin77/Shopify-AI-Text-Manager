// Product Types
export interface Product {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  productType: string;
  tags: string[];
  seo: {
    title: string;
    description: string;
  };
  images?: {
    edges: Array<{
      node: {
        altText: string | null;
      };
    }>;
  };
}

export interface ProductWithScore extends Product {
  seoScore: number;
  seoIssues: string[];
}

export interface ProductTranslation {
  title: string;
  description: string;
  handle: string;
  seoTitle: string;
  metaDescription: string;
}

export interface TranslationStatus {
  locale: string;
  status: 'complete' | 'partial' | 'missing';
  missing: string[];
}

export interface SEOSuggestion {
  seoTitle: string;
  metaDescription: string;
  reasoning: string;
}

export interface SaveTranslationRequest {
  title: string;
  description: string;
  handle: string;
  seoTitle: string;
  metaDescription: string;
}

export type SupportedLocale = 'de' | 'en' | 'fr' | 'es' | 'it';

export const LANGUAGES: Record<SupportedLocale, string> = {
  de: 'Deutsch',
  en: 'English',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
};
