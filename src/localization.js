'use strict';
/** @type {Record<string, string>} */
const messages = require('../l10n/en.json');
let currentLanguage = 'ko';

/** @param {unknown} locale */
function normalizeLanguage(locale) {
  return typeof locale === 'string' && /^ko(?:[-_]|$)/i.test(locale) ? 'ko' : 'en';
}

/**
 * VS Code's desktop NLS configuration carries the OS locale separately from
 * its user-selected display language. Treat that internal hint as optional.
 * @param {unknown} setting @param {string | undefined} nlsConfig
 * @param {string} fallbackLocale
 * @returns {'ko' | 'en'}
 */
function resolveLanguage(setting, nlsConfig, fallbackLocale) {
  if (setting === 'ko' || setting === 'en') return setting;
  try {
    const value = JSON.parse(nlsConfig || '{}');
    if (typeof value?.osLocale === 'string' && value.osLocale.trim())
      return normalizeLanguage(value.osLocale);
  } catch {
    // Hosts without the optional desktop hint use the platform locale.
  }
  return normalizeLanguage(fallbackLocale);
}

/** @param {string} language */
function setLanguage(language) {
  currentLanguage = normalizeLanguage(language);
}
function getLanguage() {
  return currentLanguage;
}

/** @param {string} message @param {...unknown} args @returns {string} */
function t(message, ...args) {
  const translated =
    currentLanguage === 'en' && Object.hasOwn(messages, message) ? messages[message] : message;
  return translated.replace(/\{(\d+)\}/g, (match, index) =>
    Number(index) < args.length ? String(args[Number(index)]) : match,
  );
}

/** @param {string} nonce @param {(name: string) => unknown} resource */
function localizationScripts(nonce, resource) {
  const data = JSON.stringify(currentLanguage === 'en' ? messages : {}).replace(/</g, '\\u003c');
  return `<script type="application/json" id="m365-localization" nonce="${nonce}">${data}</script>
<script nonce="${nonce}" src="${resource('localization.js')}"></script>`;
}

module.exports = { t, getLanguage, setLanguage, resolveLanguage, localizationScripts };
