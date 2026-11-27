'use strict';
const { t, getLanguage, localizationScripts } = require('./localization');
const { randomBytes } = require('node:crypto');
const { renderMarkdown } = require('./markdown');

function renderResponse({ text, nonce, cspSource, resource }) {
  return `<!doctype html>
<html lang="${getLanguage()}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('view.css')}">
</head>
<body class="reader wrap-code">
<header class="reader-header">
<strong>${t('M365 Copilot · 답변')}</strong>
<button id="copyResponse">${t('답변 복사')}</button>
<label>
<input id="wrapCode" type="checkbox" checked>${t('코드 줄바꿈')}</label>
<button id="fontSmaller" aria-label="${t('글자 작게')}">A−</button>
<output id="fontSize">14</output>
<button id="fontLarger" aria-label="${t('글자 크게')}">A+</button>
</header>
<main class="reader-content markdown">${renderMarkdown(text)}</main>
${localizationScripts(nonce, resource)}
<script nonce="${nonce}" src="${resource('reading.js')}">
</script>
<script nonce="${nonce}" src="${resource('response-view.js')}">
</script>
</body>
</html>`;
}

class ResponsePanel {
  constructor(host, vscode) {
    this.host = host;
    this.vscode = vscode;
  }
  show(message, preserveFocus = false) {
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 1024 * 1024) return;
    const vscode = this.vscode;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        'm365Agent.response',
        t('M365 Copilot · 답변'),
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(this.host.context.extensionUri, 'media')],
        },
      );
      this.panel = panel;
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.panel = null;
          this.text = '';
        }
      });
      panel.webview.onDidReceiveMessage((value) => {
        if (this.panel !== panel || !value) return;
        if (value.type === 'ready') panel.webview.postMessage({ type: 'readingSettings', ...this.settings });
        if (value.type === 'copyResponse') this.host.copyText({ ...value, text: this.text }, panel.webview);
        if (value.type === 'copyCode') this.host.copyText(value, panel.webview);
        if (value.type === 'openLink' && typeof value.url === 'string' && /^https?:\/\//i.test(value.url))
          vscode.env.openExternal(vscode.Uri.parse(value.url));
      });
    } else this.panel.reveal(undefined, preserveFocus);
    this.panel.title = t('M365 Copilot · 답변');
    this.text = message.text;
    this.settings = {
      readingSize: Number.isFinite(message.readingSize)
        ? Math.min(18, Math.max(12, message.readingSize))
        : 14,
      wrapCode: message.wrapCode !== false,
    };
    const resource = (name) =>
      this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.host.context.extensionUri, 'media', name));
    this.panel.webview.html = renderResponse({
      text: this.text,
      nonce: randomBytes(18).toString('base64'),
      cspSource: this.panel.webview.cspSource,
      resource,
    });
  }
  dispose() {
    this.panel?.dispose();
    this.panel = null;
    this.text = '';
  }
  refreshLanguage() {
    if (this.panel) this.show({ text: this.text, ...this.settings }, true);
  }
}
module.exports = { ResponsePanel, renderResponse };
