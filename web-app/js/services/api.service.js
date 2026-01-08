/**
 * API Service - Handles all API communication
 */
export class ApiService {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  async get(endpoint) {
    const response = await fetch(`${this.baseUrl}${endpoint}`);
    return await response.json();
  }

  async post(endpoint, data) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return await response.json();
  }

  // Product endpoints
  async getProducts() {
    return await this.get('/api/products');
  }

  async getProduct(productId) {
    return await this.get(`/api/products/${encodeURIComponent(productId)}`);
  }

  async suggestSEO(productId) {
    return await this.post(`/api/products/${encodeURIComponent(productId)}/suggest-seo`);
  }

  async applySEO(productId, data) {
    return await this.post(`/api/products/${encodeURIComponent(productId)}/apply-seo`, data);
  }

  async translateProduct(productId, data) {
    return await this.post(`/api/products/${encodeURIComponent(productId)}/translate`, data);
  }

  async saveTranslation(productId, locale, data) {
    return await this.post(
      `/api/products/${encodeURIComponent(productId)}/save-translation/${locale}`,
      data
    );
  }

  async generateAIContent(productId, fieldType, currentValue, locale) {
    return await this.post(
      `/api/products/${encodeURIComponent(productId)}/generate-ai-content`,
      {
        fieldType,
        currentValue,
        locale
      }
    );
  }
}

// Create singleton instance
export const apiService = new ApiService();
