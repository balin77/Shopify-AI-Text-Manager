/**
 * Global State Management
 */
export class AppState {
  constructor() {
    this.products = [];
    this.selectedProduct = null;
    this.currentSuggestion = null;
    this.currentLanguage = 'de';
    this.productTranslations = {};
    this.descriptionMode = 'rendered'; // 'rendered' or 'html'
    this.hasUnsavedChanges = false;
    this.originalData = {};
    this.pendingAction = null;
    this.listeners = new Map();
  }

  // Subscribe to state changes
  subscribe(key, callback) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key).push(callback);
  }

  // Notify listeners of state changes
  notify(key) {
    if (this.listeners.has(key)) {
      this.listeners.get(key).forEach((callback) => callback(this[key]));
    }
  }

  // Setters with notifications
  setProducts(products) {
    this.products = products;
    this.notify('products');
  }

  setSelectedProduct(product) {
    this.selectedProduct = product;
    this.notify('selectedProduct');
  }

  setCurrentLanguage(lang) {
    this.currentLanguage = lang;
    this.notify('currentLanguage');
  }

  setHasUnsavedChanges(value) {
    this.hasUnsavedChanges = value;
    this.notify('hasUnsavedChanges');
  }

  setOriginalData(data) {
    this.originalData = data;
  }

  setProductTranslations(translations) {
    this.productTranslations = translations;
    this.notify('productTranslations');
  }

  setDescriptionMode(mode) {
    this.descriptionMode = mode;
    this.notify('descriptionMode');
  }

  setCurrentSuggestion(suggestion) {
    this.currentSuggestion = suggestion;
    this.notify('currentSuggestion');
  }

  setPendingAction(action) {
    this.pendingAction = action;
  }

  getPendingAction() {
    return this.pendingAction;
  }

  clearPendingAction() {
    this.pendingAction = null;
  }

  reset() {
    this.hasUnsavedChanges = false;
    this.originalData = {};
    this.currentSuggestion = null;
    this.pendingAction = null;
  }
}

// Create singleton instance
export const appState = new AppState();
