'use strict';
// Only extension-owned messages pass through this function. User/model text,
// code, file contents and terminal output must stay untouched.
window.M365Localize = (() => {
  const messages = JSON.parse(document.getElementById('m365-localization').textContent);
  return (message, ...args) => {
    const translated = Object.hasOwn(messages, message) ? messages[message] : message;
    return translated.replace(/\{(\d+)\}/g, (match, index) =>
      Number(index) < args.length ? String(args[Number(index)]) : match,
    );
  };
})();
