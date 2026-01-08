import { appState } from '../modules/state.js';
import { LANGUAGES, DESCRIPTION_MODES } from '../modules/constants.js';
import { escapeHtml, setupCharacterCounters } from '../utils/dom.utils.js';
import { checkForChanges, updateSaveButton, storeOriginalData, updateTranslateButton, highlightChangedFields, getChangedFields, clearFieldHighlights } from '../utils/change-tracker.js';
import { languageSelector } from './language-selector.component.js';
import { richEditor } from './rich-editor.component.js';
import { apiService } from '../services/api.service.js';

/**
 * Product Detail Component
 */
class ProductDetailComponent {
  /**
   * Get current translation based on selected language
   */
  getCurrentTranslation(product) {
    if (appState.currentLanguage === 'de') {
      return {
        title: product.title,
        description: product.descriptionHtml,
        descriptionPlain: product.descriptionHtml.replace(/<[^>]*>/g, ''),
        handle: product.handle,
        seoTitle: product.seo.title || '',
        metaDescription: product.seo.description || '',
      };
    }

    const trans = appState.productTranslations[appState.currentLanguage] || {
      title: '',
      description: '',
      handle: '',
      seoTitle: '',
      metaDescription: '',
    };

    return {
      ...trans,
      descriptionPlain: trans.description.replace(/<[^>]*>/g, ''),
    };
  }

  /**
   * Render product detail view
   */
  render(product) {
    const scoreClass = product.seoScore >= 70
      ? 'score-good'
      : product.seoScore >= 40
      ? 'score-medium'
      : 'score-bad';

    const currentTrans = this.getCurrentTranslation(product);
    const isGerman = appState.currentLanguage === 'de';

    // Get description content based on mode
    const descriptionContent = appState.descriptionMode === DESCRIPTION_MODES.HTML
      ? currentTrans.description
      : currentTrans.descriptionPlain;

    const productDetail = document.getElementById('productDetail');
    productDetail.innerHTML = `
      ${languageSelector.render()}

      <div class="product-header">
        <h2 class="product-title-large">${escapeHtml(product.title)}</h2>
        <button id="save-btn" class="save-btn" disabled>💾 Gespeichert</button>
      </div>

      <div class="field-group">
        <label class="field-label">Titel (${LANGUAGES[appState.currentLanguage]})</label>
        <input
          type="text"
          class="editable-field"
          id="field-title"
        />
        <div class="field-meta" id="field-title-meta">0 Zeichen</div>
        <button class="ai-generate-btn" id="ai-title-btn">
          ✨ Mit KI generieren / verbessern
        </button>
        <div id="ai-title-suggestion" class="ai-suggestion-container"></div>
      </div>

      <div class="field-group">
        <div class="description-header">
          <label class="field-label">Beschreibung (${LANGUAGES[appState.currentLanguage]})</label>
          <button class="toggle-mode-btn" id="toggle-mode-btn">
            ${appState.descriptionMode === DESCRIPTION_MODES.HTML ? '👁️ Formatiert' : '📝 HTML'}
          </button>
        </div>
        ${
          appState.descriptionMode === DESCRIPTION_MODES.RENDERED
            ? `
          ${richEditor.renderToolbar()}
          <div
            class="rendered-content"
            id="field-description"
            contenteditable="true"
          ></div>
          `
            : `
          <textarea
            class="editable-field"
            id="field-description"
          ></textarea>
          `
        }
        <div class="field-meta" id="field-description-meta">0 Zeichen</div>
        <button class="ai-generate-btn" id="ai-description-btn">
          ✨ Mit KI generieren / verbessern
        </button>
        <div id="ai-description-suggestion" class="ai-suggestion-container"></div>
      </div>

      <div class="field-group">
        <label class="field-label">URL-Slug (${LANGUAGES[appState.currentLanguage]})</label>
        <input
          type="text"
          class="editable-field"
          id="field-handle"
        />
      </div>

      <div class="field-group">
        <label class="field-label">SEO-Titel (${LANGUAGES[appState.currentLanguage]})</label>
        <input
          type="text"
          class="editable-field"
          id="field-seoTitle"
        />
        <div class="field-meta" id="field-seoTitle-meta">0 Zeichen (empfohlen: 50-60)</div>
      </div>

      <div class="field-group">
        <label class="field-label">Meta-Description (${LANGUAGES[appState.currentLanguage]})</label>
        <textarea
          class="editable-field"
          id="field-metaDescription"
        ></textarea>
        <div class="field-meta" id="field-metaDescription-meta">0 Zeichen (empfohlen: 150-160)</div>
      </div>

      ${
        isGerman
          ? `
      <div class="seo-score">
        <div class="score-circle ${scoreClass}" id="score-circle">
          ${product.seoScore}%
        </div>
        <div class="seo-issues">
          <h3>SEO-Analyse</h3>
          ${
            product.seoIssues.length > 0
              ? product.seoIssues.map((issue) => `<div class="issue-item">⚠️ ${escapeHtml(issue)}</div>`).join('')
              : '<div class="issue-item">✅ Keine Probleme gefunden</div>'
          }
        </div>
      </div>

      <!-- SEO Score Tooltip -->
      <div id="score-tooltip" class="score-tooltip">
        <div class="tooltip-header">
          <div class="tooltip-score-circle ${scoreClass}">${product.seoScore}%</div>
          <div class="tooltip-title">SEO-Score Erklärung</div>
        </div>
        <div class="tooltip-content">
          Dein SEO-Score wird auf Basis von 5 wichtigen Kriterien berechnet. Je höher der Score, desto besser ist dein Produkt für Suchmaschinen optimiert.
        </div>
        <div class="tooltip-criteria">
          <div class="tooltip-criteria-title">📊 Bewertungskriterien:</div>
          <div class="criteria-item">
            <span class="criteria-points">15 Pkt.</span>
            <span>Titel-Länge (30-70 Zeichen)</span>
          </div>
          <div class="criteria-item">
            <span class="criteria-points">15 Pkt.</span>
            <span>SEO-Titel (max. 60 Zeichen)</span>
          </div>
          <div class="criteria-item">
            <span class="criteria-points">20 Pkt.</span>
            <span>Beschreibung (mind. 150 Zeichen)</span>
          </div>
          <div class="criteria-item">
            <span class="criteria-points">20 Pkt.</span>
            <span>Meta-Description (120-160 Zeichen)</span>
          </div>
          <div class="criteria-item">
            <span class="criteria-points">30 Pkt.</span>
            <span>Alle Bilder haben Alt-Texte</span>
          </div>
        </div>
        <div class="tooltip-close">Klicke irgendwo, um zu schließen</div>
      </div>

      <div class="actions">
        <button class="btn btn-primary" id="suggest-seo-btn">
          🤖 SEO mit KI optimieren
        </button>
        <button class="btn btn-secondary" id="translate-direct-btn">
          🌍 In alle Sprachen übersetzen
        </button>
      </div>
      `
          : ''
      }

      <div id="suggestionContainer"></div>
      <div id="messageContainer"></div>
    `;

    // Set field values AFTER HTML is rendered
    this.populateFields(currentTrans, descriptionContent);
    this.attachEventListeners();
  }

  /**
   * Populate form fields with data
   */
  populateFields(currentTrans, descriptionContent) {
    document.getElementById('field-title').value = currentTrans.title;

    const descField = document.getElementById('field-description');
    if (appState.descriptionMode === DESCRIPTION_MODES.RENDERED) {
      descField.innerHTML = currentTrans.description;
    } else {
      descField.value = descriptionContent;
    }

    document.getElementById('field-handle').value = currentTrans.handle;
    document.getElementById('field-seoTitle').value = currentTrans.seoTitle;
    document.getElementById('field-metaDescription').value = currentTrans.metaDescription;

    // Store original data for change detection
    storeOriginalData({
      title: currentTrans.title,
      description: currentTrans.description,
      handle: currentTrans.handle,
      seoTitle: currentTrans.seoTitle,
      metaDescription: currentTrans.metaDescription,
    });

    // Reset change state
    appState.setHasUnsavedChanges(false);
    updateSaveButton(false);
    updateTranslateButton(false);

    // Update character counts
    const descLength = appState.descriptionMode === DESCRIPTION_MODES.RENDERED
      ? descField.innerText.length
      : descriptionContent.length;

    document.getElementById('field-title-meta').textContent = `${currentTrans.title.length} Zeichen`;
    document.getElementById('field-description-meta').textContent = `${descLength} Zeichen`;
    document.getElementById('field-seoTitle-meta').textContent = `${currentTrans.seoTitle.length} Zeichen (empfohlen: 50-60)`;
    document.getElementById('field-metaDescription-meta').textContent = `${currentTrans.metaDescription.length} Zeichen (empfohlen: 150-160)`;
  }

  /**
   * Attach all event listeners
   */
  attachEventListeners() {
    // Save button
    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.saveTranslation());
    }

    // Toggle description mode
    const toggleModeBtn = document.getElementById('toggle-mode-btn');
    if (toggleModeBtn) {
      toggleModeBtn.addEventListener('click', () => {
        richEditor.toggleDescriptionMode((product) => this.render(product));
      });
    }

    // SEO suggestion button
    const suggestBtn = document.getElementById('suggest-seo-btn');
    if (suggestBtn) {
      suggestBtn.addEventListener('click', () => {
        if (window.app && window.app.suggestSEO) {
          window.app.suggestSEO();
        }
      });
    }

    // Translate button
    const translateBtn = document.getElementById('translate-direct-btn');
    if (translateBtn) {
      translateBtn.addEventListener('click', () => {
        if (window.app && window.app.translateDirect) {
          window.app.translateDirect();
        }
      });
    }

    // AI Title button
    const aiTitleBtn = document.getElementById('ai-title-btn');
    if (aiTitleBtn) {
      aiTitleBtn.addEventListener('click', () => this.generateAIContent('title'));
    }

    // AI Description button
    const aiDescriptionBtn = document.getElementById('ai-description-btn');
    if (aiDescriptionBtn) {
      aiDescriptionBtn.addEventListener('click', () => this.generateAIContent('description'));
    }

    // Character counters and change detection
    this.setupInputListeners();

    // Language selector
    languageSelector.attachEventListeners((product) => this.render(product));

    // Rich editor toolbar (if in rendered mode)
    if (appState.descriptionMode === DESCRIPTION_MODES.RENDERED) {
      richEditor.attachEventListeners();

      // Add input listener for contenteditable
      const descField = document.getElementById('field-description');
      if (descField) {
        descField.addEventListener('input', () => {
          document.getElementById('field-description-meta').textContent = `${descField.innerText.length} Zeichen`;
          const hasChanges = checkForChanges(appState.descriptionMode);
          appState.setHasUnsavedChanges(hasChanges);
          updateSaveButton(hasChanges);
          updateTranslateButton(hasChanges);
          highlightChangedFields(appState.descriptionMode);
        });
      }
    }

    // SEO Score Tooltip
    this.attachTooltipListeners();
  }

  /**
   * Attach tooltip event listeners
   */
  attachTooltipListeners() {
    const scoreCircle = document.getElementById('score-circle');
    const tooltip = document.getElementById('score-tooltip');

    if (!scoreCircle || !tooltip) return;

    // Show tooltip on click
    scoreCircle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = tooltip.classList.contains('show');

      if (isVisible) {
        tooltip.classList.remove('show');
      } else {
        // Position tooltip above and to the right of the score circle
        const rect = scoreCircle.getBoundingClientRect();
        const tooltipHeight = 350; // Approximate height of tooltip
        tooltip.style.left = `${rect.right + 20}px`;
        tooltip.style.top = `${Math.max(20, rect.top - tooltipHeight + 40)}px`;
        tooltip.classList.add('show');
      }
    });

    // Close tooltip when clicking anywhere else
    document.addEventListener('click', (e) => {
      if (tooltip.classList.contains('show') && !tooltip.contains(e.target)) {
        tooltip.classList.remove('show');
      }
    });

    // Prevent tooltip from closing when clicking inside it
    tooltip.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  /**
   * Setup input listeners for change detection
   */
  setupInputListeners() {
    const fields = [
      { id: 'field-title', recommended: null },
      { id: 'field-description', recommended: null },
      { id: 'field-handle', recommended: null },
      { id: 'field-seoTitle', recommended: '50-60' },
      { id: 'field-metaDescription', recommended: '150-160' },
    ];

    setupCharacterCounters(fields, () => {
      const hasChanges = checkForChanges(appState.descriptionMode);
      appState.setHasUnsavedChanges(hasChanges);
      updateSaveButton(hasChanges);
      updateTranslateButton(hasChanges);
      highlightChangedFields(appState.descriptionMode);
    });
  }

  /**
   * Generate AI content for title or description
   */
  async generateAIContent(fieldType) {
    const suggestionContainerId = `ai-${fieldType}-suggestion`;
    const suggestionContainer = document.getElementById(suggestionContainerId);

    // Get current field value
    let currentValue = '';
    if (fieldType === 'title') {
      currentValue = document.getElementById('field-title').value;
    } else if (fieldType === 'description') {
      const descField = document.getElementById('field-description');
      currentValue = appState.descriptionMode === DESCRIPTION_MODES.RENDERED
        ? descField.innerHTML
        : descField.value;
    }

    // Show loading state
    suggestionContainer.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <p>Generiere ${fieldType === 'title' ? 'Titel' : 'Beschreibung'} mit KI...</p>
      </div>
    `;

    try {
      const data = await apiService.generateAIContent(
        appState.selectedProduct.id,
        fieldType,
        currentValue,
        appState.currentLanguage
      );

      if (!data.success) {
        suggestionContainer.innerHTML = `<div class="error-message">Fehler bei der AI-Generierung: ${data.error}</div>`;
        setTimeout(() => { suggestionContainer.innerHTML = ''; }, 5000);
        return;
      }

      // Show the generated content in a suggestion box
      const fieldLabel = fieldType === 'title' ? 'Titel' : 'Beschreibung';
      suggestionContainer.innerHTML = `
        <div class="suggestion-box">
          <h3>✨ AI-Vorschlag für ${fieldLabel}</h3>
          <div class="suggestion-item">
            <label>Generierter Inhalt:</label>
            <div class="value">${escapeHtml(data.generatedContent)}</div>
            ${data.reasoning ? `
              <div class="reasoning">
                <strong>Begründung:</strong><br>
                ${escapeHtml(data.reasoning)}
              </div>
            ` : ''}
          </div>
          <div class="suggestion-actions">
            <button class="btn btn-reject" id="reject-ai-${fieldType}-btn">
              ❌ Ablehnen
            </button>
            <button class="btn btn-accept" id="accept-ai-${fieldType}-btn">
              ✅ Annehmen
            </button>
            <button class="btn btn-accept-translate" id="accept-translate-ai-${fieldType}-btn">
              🌍 Annehmen & Übersetzen
            </button>
          </div>
        </div>
      `;

      // Add event listeners for reject
      document.getElementById(`reject-ai-${fieldType}-btn`).addEventListener('click', () => {
        suggestionContainer.innerHTML = '';
      });

      // Add event listeners for accept
      document.getElementById(`accept-ai-${fieldType}-btn`).addEventListener('click', async () => {
        await this.acceptAISuggestion(fieldType, data.generatedContent, false);
        suggestionContainer.innerHTML = `
          <div class="success-message">
            ✅ ${fieldLabel} wurde übernommen und gespeichert!
          </div>
        `;
        setTimeout(() => { suggestionContainer.innerHTML = ''; }, 3000);
      });

      // Add event listeners for accept & translate
      document.getElementById(`accept-translate-ai-${fieldType}-btn`).addEventListener('click', async () => {
        await this.acceptAISuggestion(fieldType, data.generatedContent, true);
        suggestionContainer.innerHTML = `
          <div class="success-message">
            ✅ ${fieldLabel} wurde übernommen, gespeichert und übersetzt!
          </div>
        `;
        setTimeout(() => { suggestionContainer.innerHTML = ''; }, 3000);
      });

    } catch (error) {
      suggestionContainer.innerHTML = `<div class="error-message">Fehler: ${error.message}</div>`;
      setTimeout(() => { suggestionContainer.innerHTML = ''; }, 5000);
    }
  }

  /**
   * Accept AI suggestion and save
   */
  async acceptAISuggestion(fieldType, generatedContent, shouldTranslate) {
    const messageContainer = document.getElementById('messageContainer');

    // Update the field with generated content
    if (fieldType === 'title') {
      document.getElementById('field-title').value = generatedContent;
      document.getElementById('field-title-meta').textContent = `${generatedContent.length} Zeichen`;
    } else if (fieldType === 'description') {
      const descField = document.getElementById('field-description');
      if (appState.descriptionMode === DESCRIPTION_MODES.RENDERED) {
        descField.innerHTML = generatedContent;
        document.getElementById('field-description-meta').textContent = `${descField.innerText.length} Zeichen`;
      } else {
        descField.value = generatedContent;
        document.getElementById('field-description-meta').textContent = `${generatedContent.length} Zeichen`;
      }
    }

    // Trigger change detection
    const hasChanges = checkForChanges(appState.descriptionMode);
    appState.setHasUnsavedChanges(hasChanges);
    updateSaveButton(hasChanges);
    updateTranslateButton(hasChanges);
    highlightChangedFields(appState.descriptionMode);

    // Save the translation
    try {
      messageContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Speichere...</p></div>';

      const descField = document.getElementById('field-description');
      const description = appState.descriptionMode === DESCRIPTION_MODES.RENDERED
        ? descField.innerHTML
        : descField.value;

      const translationData = {
        title: document.getElementById('field-title').value,
        description: description,
        handle: document.getElementById('field-handle').value,
        seoTitle: document.getElementById('field-seoTitle').value,
        metaDescription: document.getElementById('field-metaDescription').value,
      };

      // Save the translation
      const data = await apiService.saveTranslation(
        appState.selectedProduct.id,
        appState.currentLanguage,
        translationData
      );

      if (!data.success) {
        messageContainer.innerHTML = `<div class="error-message">Fehler beim Speichern: ${data.error}</div>`;
        return;
      }

      // If shouldTranslate, translate the changed field
      if (shouldTranslate && appState.currentLanguage === 'de') {
        try {
          messageContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Übersetze...</p></div>';

          const changedFields = {};
          changedFields[fieldType] = generatedContent;

          const translateData = await apiService.translateProduct(
            appState.selectedProduct.id,
            changedFields
          );

          if (translateData.success) {
            messageContainer.innerHTML = `
              <div class="success-message">
                <strong>✅ Erfolgreich!</strong><br>
                Gespeichert und in ${Object.keys(translateData.translations).join(', ').toUpperCase()} übersetzt.
              </div>
            `;
          } else {
            messageContainer.innerHTML = `
              <div class="success-message">
                ✅ Gespeichert, aber Übersetzung fehlgeschlagen: ${translateData.error}
              </div>
            `;
          }
        } catch (translateError) {
          messageContainer.innerHTML = `
            <div class="success-message">
              ✅ Gespeichert, aber Übersetzung fehlgeschlagen: ${translateError.message}
            </div>
          `;
        }
      } else {
        messageContainer.innerHTML = `
          <div class="success-message">
            ✅ ${appState.currentLanguage === 'de' ? 'Produkt' : 'Übersetzung für ' + LANGUAGES[appState.currentLanguage]} gespeichert!
          </div>
        `;
      }

      // Update original data to reflect saved state
      storeOriginalData(translationData);
      appState.setHasUnsavedChanges(false);
      updateSaveButton(false);
      updateTranslateButton(false);
      clearFieldHighlights();

      setTimeout(() => {
        messageContainer.innerHTML = '';
      }, 3000);
    } catch (error) {
      messageContainer.innerHTML = `<div class="error-message">Fehler: ${error.message}</div>`;
    }
  }

  /**
   * Save translation
   */
  async saveTranslation() {
    const messageContainer = document.getElementById('messageContainer');
    messageContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Speichere und übersetze...</p></div>';

    const descField = document.getElementById('field-description');
    const description = appState.descriptionMode === DESCRIPTION_MODES.RENDERED
      ? descField.innerHTML
      : descField.value;

    const translationData = {
      title: document.getElementById('field-title').value,
      description: description,
      handle: document.getElementById('field-handle').value,
      seoTitle: document.getElementById('field-seoTitle').value,
      metaDescription: document.getElementById('field-metaDescription').value,
    };

    // Get only changed fields for translation
    const changedFields = getChangedFields(appState.descriptionMode);

    try {
      // Step 1: Save the translation
      const data = await apiService.saveTranslation(
        appState.selectedProduct.id,
        appState.currentLanguage,
        translationData
      );

      if (!data.success) {
        messageContainer.innerHTML = `<div class="error-message">Fehler beim Speichern: ${data.error}</div>`;
        return;
      }

      // Step 2: Translate only changed fields if we're in German and have changes
      if (appState.currentLanguage === 'de' && Object.keys(changedFields).length > 0) {
        try {
          const translateData = await apiService.translateProduct(
            appState.selectedProduct.id,
            changedFields
          );

          if (translateData.success) {
            messageContainer.innerHTML = `
              <div class="success-message">
                <strong>✅ Erfolgreich!</strong><br>
                Änderungen gespeichert und in ${Object.keys(translateData.translations).join(', ').toUpperCase()} übersetzt.
              </div>
            `;
          } else {
            messageContainer.innerHTML = `
              <div class="success-message">
                ✅ Gespeichert, aber Übersetzung fehlgeschlagen: ${translateData.error}
              </div>
            `;
          }
        } catch (translateError) {
          messageContainer.innerHTML = `
            <div class="success-message">
              ✅ Gespeichert, aber Übersetzung fehlgeschlagen: ${translateError.message}
            </div>
          `;
        }
      } else {
        messageContainer.innerHTML = `
          <div class="success-message">
            ✅ ${appState.currentLanguage === 'de' ? 'Produkt' : 'Übersetzung für ' + LANGUAGES[appState.currentLanguage]} gespeichert!
          </div>
        `;
      }

      // Update local translations cache
      if (appState.currentLanguage !== 'de') {
        const updatedTranslations = { ...appState.productTranslations };
        updatedTranslations[appState.currentLanguage] = translationData;
        appState.setProductTranslations(updatedTranslations);
      }

      // Update original data to reflect saved state
      storeOriginalData(translationData);
      appState.setHasUnsavedChanges(false);
      updateSaveButton(false);
      updateTranslateButton(false);
      clearFieldHighlights();

      setTimeout(() => {
        messageContainer.innerHTML = '';
      }, 3000);
    } catch (error) {
      messageContainer.innerHTML = `<div class="error-message">Fehler: ${error.message}</div>`;
    }
  }
}

export const productDetail = new ProductDetailComponent();
