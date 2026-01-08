// Change tracking for unsaved changes detection

let originalData = {};
let pendingAction = null;

/**
 * Store original data for change detection
 */
export function storeOriginalData(data) {
  originalData = { ...data };
}

/**
 * Check if current data has changed from original
 */
export function checkForChanges(descriptionMode) {
  if (!originalData.title) return false; // No data loaded yet

  const descField = document.getElementById('field-description');
  const currentDescription = descriptionMode === 'rendered'
    ? descField.innerHTML
    : descField.value;

  const hasChanges =
    document.getElementById('field-title').value !== originalData.title ||
    currentDescription !== originalData.description ||
    document.getElementById('field-handle').value !== originalData.handle ||
    document.getElementById('field-seoTitle').value !== originalData.seoTitle ||
    document.getElementById('field-metaDescription').value !== originalData.metaDescription;

  return hasChanges;
}

/**
 * Update save button state based on changes
 */
export function updateSaveButton(hasChanges) {
  const saveBtn = document.getElementById('save-btn');
  if (!saveBtn) return;

  if (hasChanges) {
    saveBtn.disabled = false;
    saveBtn.classList.add('has-changes');
    saveBtn.textContent = '💾 Speichern & Übersetzen *';
  } else {
    saveBtn.disabled = true;
    saveBtn.classList.remove('has-changes');
    saveBtn.textContent = '💾 Gespeichert';
  }
}

/**
 * Set pending action for after save/discard
 */
export function setPendingAction(action) {
  pendingAction = action;
}

/**
 * Get pending action
 */
export function getPendingAction() {
  return pendingAction;
}

/**
 * Clear pending action
 */
export function clearPendingAction() {
  pendingAction = null;
}

/**
 * Get which fields have changed from original
 * Returns object with only the changed field names
 */
export function getChangedFields(descriptionMode) {
  if (!originalData.title) return {}; // No data loaded yet

  const descField = document.getElementById('field-description');
  const currentDescription = descriptionMode === 'rendered'
    ? descField.innerHTML
    : descField.value;

  const changedFields = {};

  if (document.getElementById('field-title').value !== originalData.title) {
    changedFields.title = document.getElementById('field-title').value;
  }

  if (currentDescription !== originalData.description) {
    changedFields.description = currentDescription;
  }

  if (document.getElementById('field-handle').value !== originalData.handle) {
    changedFields.handle = document.getElementById('field-handle').value;
  }

  if (document.getElementById('field-seoTitle').value !== originalData.seoTitle) {
    changedFields.seoTitle = document.getElementById('field-seoTitle').value;
  }

  if (document.getElementById('field-metaDescription').value !== originalData.metaDescription) {
    changedFields.metaDescription = document.getElementById('field-metaDescription').value;
  }

  return changedFields;
}

/**
 * Update translate button state based on changes
 */
export function updateTranslateButton(hasChanges) {
  const translateBtn = document.getElementById('translate-direct-btn');
  if (!translateBtn) return;

  if (hasChanges) {
    translateBtn.disabled = false;
    translateBtn.classList.remove('btn-disabled');
    translateBtn.textContent = '🌍 Änderungen übersetzen';
  } else {
    translateBtn.disabled = true;
    translateBtn.classList.add('btn-disabled');
    translateBtn.textContent = '🌍 Keine Änderungen';
  }
}

/**
 * Highlight changed fields visually
 */
export function highlightChangedFields(descriptionMode) {
  const changedFields = getChangedFields(descriptionMode);

  // Field IDs mapping
  const fieldIds = {
    title: 'field-title',
    description: 'field-description',
    handle: 'field-handle',
    seoTitle: 'field-seoTitle',
    metaDescription: 'field-metaDescription',
  };

  // Remove all highlights first
  Object.values(fieldIds).forEach((fieldId) => {
    const field = document.getElementById(fieldId);
    if (field) {
      field.classList.remove('field-changed');
    }
  });

  // Add highlights to changed fields
  Object.keys(changedFields).forEach((fieldName) => {
    const fieldId = fieldIds[fieldName];
    const field = document.getElementById(fieldId);
    if (field) {
      field.classList.add('field-changed');
    }
  });
}

/**
 * Remove all field highlights
 */
export function clearFieldHighlights() {
  const fieldIds = ['field-title', 'field-description', 'field-handle', 'field-seoTitle', 'field-metaDescription'];

  fieldIds.forEach((fieldId) => {
    const field = document.getElementById(fieldId);
    if (field) {
      field.classList.remove('field-changed');
    }
  });
}
