/**
 * Main Application Entry Point
 * Refactored modular architecture
 */

import { appState } from './modules/state.js';
import { apiService } from './services/api.service.js';
import { productList } from './components/product-list.component.js';
import { productDetail } from './components/product-detail.component.js';
import { seoSuggestion } from './components/seo-suggestion.component.js';
import { modal } from './components/modal.component.js';
import { checkForChanges, updateSaveButton } from './utils/change-tracker.js';

/**
 * Main Application Class
 */
class App {
  constructor() {
    this.init();
  }

  /**
   * Initialize application
   */
  async init() {
    console.log('🚀 Shopify SEO Optimizer - Refactored Edition');
    await this.loadProducts();

    // Setup reload button
    const reloadBtn = document.getElementById('reload-btn');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', () => this.loadProducts());
    }

    // Make app globally available for event handlers
    window.app = this;
    window.modal = modal;
    window.appState = appState;
  }

  /**
   * Load all products
   */
  async loadProducts() {
    productList.showLoading();

    try {
      const data = await apiService.getProducts();

      if (data.success) {
        appState.setProducts(data.products);
        console.log('✅ Loaded products:', data.products.length);
        productList.render(data.products, appState.selectedProduct?.id);
      } else {
        productList.showError(data.error);
      }
    } catch (error) {
      productList.showError(error.message);
    }
  }

  /**
   * Select a product with unsaved changes check
   */
  async selectProduct(productId) {
    // Check for unsaved changes
    const hasChanges = checkForChanges(appState.descriptionMode);

    if (hasChanges) {
      modal.showUnsavedChangesModal(() => this.selectProductInternal(productId));
      return;
    }

    await this.selectProductInternal(productId);
  }

  /**
   * Internal product selection
   */
  async selectProductInternal(productId) {
    const product = appState.products.find((p) => p.id === productId);
    appState.setSelectedProduct(product);
    appState.setCurrentSuggestion(null);
    appState.setCurrentLanguage('de');
    appState.setHasUnsavedChanges(false);

    // Re-render product list to show selection
    productList.render(appState.products, productId);

    // Show loading in detail
    const productDetailContainer = document.getElementById('productDetail');
    productDetailContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Lade Produktdetails...</p></div>';

    try {
      const data = await apiService.getProduct(productId);

      if (data.success) {
        appState.setProductTranslations(data.translations || {});
        productDetail.render(data.product);
      } else {
        productDetailContainer.innerHTML = `<div class="error-message">Fehler: ${data.error}</div>`;
      }
    } catch (error) {
      productDetailContainer.innerHTML = `<div class="error-message">Fehler: ${error.message}</div>`;
    }
  }

  /**
   * Save translation (called from productDetail or modal)
   */
  async saveTranslation() {
    await productDetail.saveTranslation();
  }

  /**
   * Suggest SEO with AI
   */
  async suggestSEO() {
    await seoSuggestion.suggestSEO();
  }

  /**
   * Translate current SEO data to all languages
   */
  async translateDirect() {
    await seoSuggestion.translateDirect();
  }
}

// Initialize app when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  new App();
});
