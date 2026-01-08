// DOM utility functions

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Update character counter for an input field
 */
export function updateCharacterCounter(element, metaElement, recommendedRange = null) {
  const length = element.value ? element.value.length : (element.innerText ? element.innerText.length : 0);
  let metaText = `${length} Zeichen`;

  if (recommendedRange) {
    metaText += ` (empfohlen: ${recommendedRange})`;
  }

  metaElement.textContent = metaText;
  return length;
}

/**
 * Setup character counters for multiple fields
 */
export function setupCharacterCounters(fieldIds, onChangeCallback = null) {
  fieldIds.forEach(({ id, recommended }) => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', (e) => {
        const meta = e.target.parentElement.querySelector('.field-meta');
        if (meta) {
          updateCharacterCounter(e.target, meta, recommended);
        }
        if (onChangeCallback) {
          onChangeCallback();
        }
      });
    }
  });
}
