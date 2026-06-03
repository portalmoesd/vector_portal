/**
 * Simple i18n system — key-based translations.
 */
const I18n = {
  _locale: 'ka',
  _strings: {},

  async init() {
    const saved = localStorage.getItem('locale');
    if (saved) this._locale = saved;
    await this.load(this._locale);
    // Apply the loaded strings to whatever is already in the DOM so the
    // page renders in the active locale (Georgian by default) on first
    // paint — without this, static [data-i18n] fallback text (English)
    // would show until the user manually toggled the language.
    this.translateRoot(document);
  },

  async load(locale) {
    try {
      const res = await fetch(`/locales/${locale}.json`);
      this._strings = await res.json();
      this._locale = locale;
      localStorage.setItem('locale', locale);
      document.documentElement.lang = locale;
    } catch (e) {
      console.warn(`Failed to load locale "${locale}", falling back to en`);
      if (locale !== 'en') await this.load('en');
    }
  },

  t(key, params) {
    let str = key.split('.').reduce((obj, k) => obj && obj[k], this._strings);
    if (str == null) return key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      });
    }
    return str;
  },

  // tr() — preferred call site for inline JS strings (toasts, alerts,
  // dynamic modal titles). Identical to t() today; kept as a stable
  // alias so we can later add e.g. plural / context handling without
  // touching every call site.
  tr(key, params) {
    return this.t(key, params);
  },

  getLocale() {
    return this._locale;
  },

  // Walk a DOM subtree and translate every [data-i18n], [data-i18n-placeholder],
  // and [data-i18n-title] descendant. setLocale() walks the whole document;
  // this helper is for fragments built mid-flight (modal HTML, dynamically
  // inserted card rows, etc.).
  translateRoot(root) {
    if (!root) return;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = this.t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = this.t(el.dataset.i18nPlaceholder);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.dataset.i18nTitle);
    });
  },

  async setLocale(locale) {
    await this.load(locale);
    this.translateRoot(document);
  },
};

function t(key, params) {
  return I18n.t(key, params);
}
