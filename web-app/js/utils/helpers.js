/**
 * Utility Helper Functions
 */

export function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

export const LANGUAGES = {
  de: 'Deutsch',
  en: 'English',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
};

export function getTranslationStatus(translations) {
  const requiredFields = ['title', 'description', 'seoTitle', 'metaDescription'];
  const missing = requiredFields.filter((field) => !translations[field]);

  if (missing.length === 0) return 'complete';
  if (missing.length === requiredFields.length) return 'missing';
  return 'partial';
}

export function calculateSEOScore(product) {
  const descriptionText = product.descriptionHtml.replace(/<[^>]*>/g, '').trim();
  let score = 0;
  const issues = [];

  if (product.title.length >= 30 && product.title.length <= 70) {
    score += 15;
  } else {
    issues.push('Titel-Länge optimieren (30-70 Zeichen)');
  }

  if (product.seo.title && product.seo.title.length <= 60) {
    score += 15;
  } else {
    issues.push('SEO-Titel setzen/optimieren (max. 60 Zeichen)');
  }

  if (descriptionText.length >= 150) {
    score += 20;
  } else {
    issues.push('Beschreibung erweitern (mind. 150 Zeichen)');
  }

  if (
    product.seo.description &&
    product.seo.description.length >= 120 &&
    product.seo.description.length <= 160
  ) {
    score += 20;
  } else {
    issues.push('Meta-Description optimieren (120-160 Zeichen)');
  }

  if (product.images && product.images.edges) {
    const imagesWithoutAlt = product.images.edges.filter((e) => !e.node.altText).length;
    if (imagesWithoutAlt === 0) {
      score += 30;
    } else {
      issues.push(`${imagesWithoutAlt} Bilder ohne Alt-Text`);
    }
  }

  return { score, issues };
}
