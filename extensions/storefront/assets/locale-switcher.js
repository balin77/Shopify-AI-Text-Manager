/*
 * Storefront Language & Currency switcher controller.
 *
 * Progressive enhancement:
 *   - The server renders one or two native Shopify `{% form 'localization' %}`
 *     forms, each with a real <select> + <noscript> submit button. That is
 *     the no-JS experience: plain dropdowns, text only (a <select> cannot
 *     render images inside its <option>s — a browser limitation, not ours).
 *   - When JS is available, this controller upgrades each <select> into a
 *     custom listbox UI that DOES show flag icons in every option (current
 *     selection + all open-list options). The native <select> remains in
 *     the DOM (hidden but interactive via JS) so form submission still goes
 *     through Shopify's own localization endpoint — we never bypass it.
 *
 * Flag rendering:
 *   - The Liquid template emits per-option data attributes:
 *       data-flag-country  ISO-2 code of the country whose flag to use
 *       data-flag-image    optional URL to a merchant-uploaded image
 *                          (image_picker — takes precedence over country)
 *   - The sprite is fetched once (data-sprite-url) and injected into the
 *     document so <use href="#xx"> references resolve same-document. This
 *     dodges any cross-origin <use> quirks (Shopify CDN ≠ shop origin).
 *
 * Mounting:
 *   - Merchants pick one or more mount points via checkboxes (floating
 *     corner, site header, site footer, custom CSS selector). The original
 *     element handles the first enabled mount; for each additional one we
 *     clone the element + place it into the target. Each clone runs through
 *     its own connectedCallback path but is short-circuited by the
 *     `cp-locale-switcher--clone` marker so it does not clone again.
 *   - Delegated listeners on `this` survive any element move;
 *     disconnectedCallback is intentionally a no-op.
 */
class CpLocaleSwitcher extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;

    this._debug = this.dataset.debug === '1';
    this._showFlag = this.dataset.showFlag === '1';
    this._labelFormat = this.dataset.labelFormat || 'endonym';
    this._countryDisplay = this.dataset.countryDisplay || 'flag_and_name';
    this._currencyFormat = this.dataset.currencyFormat || 'both';
    this._spriteUrl = this.dataset.spriteUrl || '';

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._init(), { once: true });
    } else {
      this._init();
    }
  }

  disconnectedCallback() {
    // Intentionally empty: the element is moved (header/footer relocation)
    // rather than destroyed, and a delegated listener on `this` travels
    // with the node. Tearing down here would kill the dropdown handlers.
  }

  _log(...a) { if (this._debug) console.info('[cp-locale-switcher]', ...a); }
  _warn(...a) { if (this._debug) console.warn('[cp-locale-switcher]', ...a); }

  _init() {
    const selects = this.querySelectorAll('select.cp-locale-switcher__select');
    if (!selects.length) {
      this._warn('no localization <select> found — aborting');
      return;
    }

    // Clones skip mount logic entirely (the original placed them already).
    // Without this guard a clone would recursively clone itself.
    if (!this.classList.contains('cp-locale-switcher--clone')) {
      this._renderAllMounts();
    }

    if (this._showFlag) {
      this._ensureSprite().then(() => this._upgradeAll(selects)).catch((err) => {
        this._warn('sprite fetch failed; flags disabled', err);
        this._showFlag = false;
        this._upgradeAll(selects);
      });
    } else {
      this._upgradeAll(selects);
    }
  }

  _upgradeAll(selects) {
    this.classList.add('cp-locale-switcher--js');
    selects.forEach((sel) => this._upgrade(sel));
  }

  /* ---------------------------------------------------------------- sprite */

  _ensureSprite() {
    if (!this._spriteUrl) return Promise.resolve();
    // One inject per page no matter how many switcher instances exist.
    if (document.getElementById('cp-locale-flag-sprite')) return Promise.resolve();
    if (window.__cpLocaleSpritePromise) return window.__cpLocaleSpritePromise;
    window.__cpLocaleSpritePromise = fetch(this._spriteUrl, { credentials: 'omit' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then((svg) => {
        const div = document.createElement('div');
        div.id = 'cp-locale-flag-sprite';
        div.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        div.setAttribute('aria-hidden', 'true');
        div.innerHTML = svg;
        document.body.appendChild(div);
        this._log('sprite injected');
      });
    return window.__cpLocaleSpritePromise;
  }

  _hasFlag(country) {
    if (!country) return false;
    const sprite = document.getElementById('cp-locale-flag-sprite');
    if (!sprite) return false;
    return !!sprite.querySelector('#' + CSS.escape(country));
  }

  /* ------------------------------------------------------------ upgrading */

  _upgrade(select) {
    const kind = select.dataset.kind || 'language';
    const options = Array.from(select.options).map((o) => ({
      value: o.value,
      country: (o.dataset.flagCountry || '').toLowerCase(),
      image: o.dataset.flagImage || '',
      endonym: o.dataset.endonym || o.textContent.trim(),
      iso: o.dataset.iso || o.value.toUpperCase(),
      name: o.dataset.name || '',
      currencyCode: o.dataset.currencyCode || '',
      currencySymbol: o.dataset.currencySymbol || '',
      selected: o.selected,
    }));
    if (!options.length) return;

    const baseId = `cp-ls-${kind}-${Math.random().toString(36).slice(2, 8)}`;

    // Hide the native <select> from sight but keep it focusable for form
    // submission and screen-reader resilience if the JS UI breaks at runtime.
    select.classList.add('cp-locale-switcher__select--hidden');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');

    // Build the custom listbox UI as a sibling of the native select.
    const root = document.createElement('div');
    root.className = 'cp-locale-field';
    root.dataset.kind = kind;

    // role=combobox per WAI-ARIA APG "Select-Only Combobox" pattern: the
    // trigger element IS the combobox, and aria-activedescendant on it
    // points into the sibling listbox while focus stays here. With role
    // explicitly set, screen readers expect the activedescendant pattern
    // (review R1). The <button> tag is kept so it remains keyboard- and
    // pointer-activatable without extra script.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cp-locale-field__button';
    button.id = `${baseId}-button`;
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `${baseId}-list`);
    button.setAttribute('aria-label', select.getAttribute('aria-label') || kind);

    const list = document.createElement('ul');
    list.className = 'cp-locale-field__list';
    list.id = `${baseId}-list`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    options.forEach((opt, i) => {
      const li = document.createElement('li');
      li.className = 'cp-locale-field__option';
      li.id = `${baseId}-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', opt.selected ? 'true' : 'false');
      li.dataset.value = opt.value;
      li.dataset.index = String(i);
      li.appendChild(this._renderFlag(opt, kind));
      li.appendChild(this._renderLabel(opt, kind));
      list.appendChild(li);
    });

    const selected = options.find((o) => o.selected) || options[0];
    this._fillButton(button, selected, kind);

    select.parentNode.insertBefore(root, select);
    root.appendChild(button);
    root.appendChild(list);
    root.appendChild(select); // keep <select> inside the field for form ctx

    this._bindField({ root, button, list, select, options, kind });
  }

  _renderFlag(opt, kind) {
    const wrap = document.createElement('span');
    wrap.className = 'cp-locale-field__flag';
    wrap.setAttribute('aria-hidden', 'true');
    const showFlag = kind === 'country'
      ? (this._countryDisplay === 'flag_and_name' || this._countryDisplay === 'flag_only')
      : this._showFlag;
    if (!showFlag) {
      wrap.classList.add('cp-locale-field__flag--off');
      return wrap;
    }
    if (opt.image) {
      const img = document.createElement('img');
      img.src = opt.image;
      img.alt = '';
      img.loading = 'lazy';
      wrap.appendChild(img);
      return wrap;
    }
    if (this._hasFlag(opt.country)) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 640 480');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + opt.country);
      svg.appendChild(use);
      wrap.appendChild(svg);
      return wrap;
    }
    // No flag available — render a small ISO badge so the row never looks
    // half-broken.
    wrap.classList.add('cp-locale-field__flag--placeholder');
    wrap.textContent = (opt.iso || '').slice(0, 2);
    return wrap;
  }

  _renderLabel(opt, kind) {
    const span = document.createElement('span');
    span.className = 'cp-locale-field__text';

    if (kind === 'country') {
      // Country uses its own display setting + currency-format; opt.endonym
      // was already rendered server-side per those rules, so reuse it. For
      // flag_only we still keep the text in the DOM (just visually hidden)
      // so screen readers announce the country.
      const visible = this._countryDisplay !== 'flag_only';
      if (!visible) span.classList.add('cp-locale-field__text--sr');
      span.textContent = opt.endonym;
      return span;
    }

    // Language dropdown — unchanged behaviour.
    if (this._labelFormat === 'none') {
      span.classList.add('cp-locale-field__text--sr');
      span.textContent = opt.endonym;
    } else if (this._labelFormat === 'iso') {
      span.textContent = opt.iso;
    } else {
      span.textContent = opt.endonym;
    }
    return span;
  }

  _fillButton(button, opt, kind) {
    button.textContent = '';
    button.appendChild(this._renderFlag(opt, kind));
    button.appendChild(this._renderLabel(opt, kind));
    // Auto-compact: for the country trigger we also stash a short variant
    // (currency symbol / code, or country ISO when currency is hidden). CSS
    // shows the long label by default and swaps to this one inside a
    // container query when the host's inline size gets tight. Language has
    // no short variant — the flag alone is enough at narrow widths.
    if (kind === 'country' && this._countryDisplay !== 'flag_only') {
      const short = document.createElement('span');
      short.className = 'cp-locale-field__short';
      short.setAttribute('aria-hidden', 'true');
      let shortText;
      if (this._currencyFormat === 'none') {
        shortText = (opt.value || '').toUpperCase();
      } else if (this._currencyFormat === 'code') {
        shortText = opt.currencyCode || (opt.value || '').toUpperCase();
      } else {
        // 'symbol' or 'both' — symbol is the most compact, fall back to code
        shortText = opt.currencySymbol || opt.currencyCode || (opt.value || '').toUpperCase();
      }
      short.textContent = shortText;
      button.appendChild(short);
    }
    const caret = document.createElement('span');
    caret.className = 'cp-locale-field__caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    button.appendChild(caret);
  }

  /* ------------------------------------------------------------ behaviour */

  _bindField(ctx) {
    const { root, button, list, select, options, kind } = ctx;
    let openIndex = options.findIndex((o) => o.selected);
    if (openIndex < 0) openIndex = 0;

    const open = () => {
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      const active = list.children[openIndex];
      if (active) {
        button.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView({ block: 'nearest' });
        active.classList.add('cp-locale-field__option--focus');
      }
    };
    const close = () => {
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-activedescendant');
      list.querySelectorAll('.cp-locale-field__option--focus').forEach((el) =>
        el.classList.remove('cp-locale-field__option--focus')
      );
    };
    const toggle = () => (list.hidden ? open() : close());

    const moveFocus = (delta) => {
      const next = (openIndex + delta + options.length) % options.length;
      list.children[openIndex]?.classList.remove('cp-locale-field__option--focus');
      openIndex = next;
      const el = list.children[openIndex];
      if (el) {
        el.classList.add('cp-locale-field__option--focus');
        el.scrollIntoView({ block: 'nearest' });
        button.setAttribute('aria-activedescendant', el.id);
      }
    };

    const choose = (index) => {
      const opt = options[index];
      if (!opt) return;
      // Update visual button
      this._fillButton(button, opt, kind);
      // Update aria-selected on all options
      Array.from(list.children).forEach((el, i) => {
        el.setAttribute('aria-selected', i === index ? 'true' : 'false');
      });
      // Update native select and submit its form (Shopify applies the change)
      if (select.value !== opt.value) {
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      this._remember(select.dataset.kind, opt.value);
      this._log('submitting', select.dataset.kind, '=', opt.value);
      const form = select.form;
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }
    };

    button.addEventListener('click', (e) => {
      e.preventDefault();
      toggle();
    });

    button.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          e.preventDefault();
          if (list.hidden) open();
          else moveFocus(e.key === 'ArrowDown' ? 1 : -1);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (list.hidden) open();
          else choose(openIndex);
          break;
        case 'Escape':
          if (!list.hidden) {
            e.preventDefault();
            close();
          }
          break;
        case 'Home':
          if (!list.hidden) { e.preventDefault(); openIndex = 0; moveFocus(0); }
          break;
        case 'End':
          if (!list.hidden) { e.preventDefault(); openIndex = options.length - 1; moveFocus(0); }
          break;
      }
    });

    list.addEventListener('click', (e) => {
      const li = e.target.closest('.cp-locale-field__option');
      if (!li) return;
      choose(Number(li.dataset.index));
    });

    list.addEventListener('mousemove', (e) => {
      const li = e.target.closest('.cp-locale-field__option');
      if (!li) return;
      const idx = Number(li.dataset.index);
      if (idx === openIndex) return;
      list.children[openIndex]?.classList.remove('cp-locale-field__option--focus');
      openIndex = idx;
      li.classList.add('cp-locale-field__option--focus');
    });

    // Outside-click close is handled by a SINGLE document-level listener
    // installed in _ensureOutsideClick (review R2 — avoids one extra
    // document listener per field). Track this field so the global
    // handler can close it.
    CpLocaleSwitcher._fields.push({ root, close });
    CpLocaleSwitcher._ensureOutsideClick();
  }

  /* One document click listener for the whole page, no matter how many
     switcher instances or fields exist. Each field registers itself in
     CpLocaleSwitcher._fields and is closed when a click lands outside. */
  static _ensureOutsideClick() {
    if (CpLocaleSwitcher._outsideClickBound) return;
    CpLocaleSwitcher._outsideClickBound = true;
    document.addEventListener('click', (e) => {
      for (const f of CpLocaleSwitcher._fields) {
        if (!f.root.contains(e.target)) f.close();
      }
    });
  }

  /* Persist a non-authoritative breadcrumb (analytics only — Shopify's
     cookie is the source of truth). Best-effort. */
  _remember(kind, value) {
    try {
      const key = kind === 'language' ? 'cp_ls_language' : 'cp_ls_country';
      window.localStorage.setItem(key, value);
    } catch (_) { /* storage may be unavailable */ }
  }

  /* Reads the data-mount-* flags into an ordered list of mount targets. */
  _readMounts() {
    const out = [];
    if (this.dataset.mountFloating === '1') {
      out.push({ kind: 'floating', corner: (this.dataset.floatingCorner || 'bottom-right') });
    }
    if (this.dataset.mountHeader === '1') {
      out.push({
        kind: 'header',
        selector: (this.dataset.headerSelector || '').trim(),
        position: (this.dataset.headerPosition || 'append'),
      });
    }
    if (this.dataset.mountFooter === '1') {
      out.push({
        kind: 'footer',
        selector: (this.dataset.footerSelector || '').trim(),
        position: (this.dataset.footerPosition || 'append'),
      });
    }
    if (this.dataset.mountCustom === '1') {
      out.push({
        kind: 'custom',
        selector: (this.dataset.customSelector || '').trim(),
        position: (this.dataset.customPosition || 'append'),
      });
    }
    return out;
  }

  /* Place `this` at the first enabled mount, then clone for each additional
     mount. Clones get a `--clone` class so their own _init skips remounting. */
  _renderAllMounts() {
    const mounts = this._readMounts();
    if (mounts.length === 0) {
      mounts.push({ kind: 'floating', corner: 'bottom-right' });
    }

    this._applyMount(this, mounts[0]);

    for (let i = 1; i < mounts.length; i++) {
      const clone = this.cloneNode(true);
      clone.classList.add('cp-locale-switcher--clone');
      // De-dupe ids so labels / aria refs / form submissions don't collide.
      // Each subtree id gets a -cN suffix; original is left untouched.
      const suffix = '-c' + i;
      if (clone.id) clone.id = clone.id + suffix;
      clone.querySelectorAll('[id]').forEach((el) => {
        if (el.id) el.id = el.id + suffix;
      });
      this._applyMount(clone, mounts[i]);
      this._log('cloned into', mounts[i].kind);
    }
  }

  _applyMount(el, mount) {
    // Drop any prior placement class — the original element may have had
    // one from a previous mount applied (the first iteration sets the base
    // class on `this`, and any clone-source class needs scrubbing too).
    el.classList.remove(
      'cp-locale-switcher--floating-bottom-right',
      'cp-locale-switcher--floating-bottom-left',
      'cp-locale-switcher--floating-top-right',
      'cp-locale-switcher--header',
      'cp-locale-switcher--footer',
      'cp-locale-switcher--custom'
    );

    if (mount.kind === 'floating') {
      el.classList.add('cp-locale-switcher--floating-' + (mount.corner || 'bottom-right'));
      if (el.parentNode !== document.body) document.body.appendChild(el);
      return;
    }

    let target = null;
    if (mount.selector) {
      try { target = document.querySelector(mount.selector); } catch (_) { target = null; }
    }
    if (!target && mount.kind === 'header') target = document.querySelector('header');
    if (!target && mount.kind === 'footer') target = document.querySelector('footer');

    if (!target) {
      this._warn(mount.kind, 'container not found; falling back to floating');
      el.classList.add('cp-locale-switcher--floating-bottom-right');
      if (!el.parentNode) document.body.appendChild(el);
      return;
    }
    el.classList.add('cp-locale-switcher--' + mount.kind);
    if (mount.position === 'prepend' && target.firstChild) {
      // Re-parenting via insertBefore handles both "already a child of
      // target" (moves to head) and "in another parent" (re-homes here).
      target.insertBefore(el, target.firstChild);
    } else if (el.parentNode !== target) {
      target.appendChild(el);
    }
  }
}

CpLocaleSwitcher._fields = [];
CpLocaleSwitcher._outsideClickBound = false;

if (!customElements.get('cp-locale-switcher')) {
  customElements.define('cp-locale-switcher', CpLocaleSwitcher);
}
