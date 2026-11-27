'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const ts = require('typescript');
const { t: translate, setLanguage, getLanguage, resolveLanguage } = require('../src/localization');
const { renderWebview } = require('../src/view');
const { renderBrowserPanel } = require('../src/browser-panel');
const { renderResponse } = require('../src/response-panel');
const { decorate } = require('../src/markdown');
const messages = require('../l10n/en.json');
const root = path.resolve(__dirname, '..');

test('language preference overrides the OS, with platform fallback and English for unsupported locales', () => {
  assert.equal(resolveLanguage('auto', '{"osLocale":"ko-KR","userLocale":"en"}', 'en-US'), 'ko');
  assert.equal(resolveLanguage('auto', '{"osLocale":"en-US","userLocale":"ko"}', 'ko-KR'), 'en');
  assert.equal(resolveLanguage('en', '{"osLocale":"ko-KR"}', 'ko-KR'), 'en');
  assert.equal(resolveLanguage('ko', '{"osLocale":"en-US"}', 'en-US'), 'ko');
  assert.equal(resolveLanguage('auto', undefined, 'KO_kr'), 'ko');
  assert.equal(resolveLanguage('auto', 'invalid JSON', 'ko-KR'), 'ko');
  assert.equal(resolveLanguage('auto', '{"osLocale":null}', 'en-US'), 'en');
  assert.equal(resolveLanguage('auto', '{"osLocale":"fr-FR"}', 'ko-KR'), 'en');
});

test('English catalog covers every extension message without altering substituted content', async () => {
  for (const dir of ['src', 'media']) {
    for (const file of (await fs.readdir(path.join(root, dir))).filter(name => name.endsWith('.js'))) {
      const name = path.join(root, dir, file);
      const ast = ts.createSourceFile(name, await fs.readFile(name, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && /^(t|window\.M365Localize)$/.test(node.expression.getText(ast))) {
          const key = node.arguments[0];
          assert.ok(key && ts.isStringLiteral(key), `${file}: literal translation key`);
          assert.equal(typeof messages[key.text], 'string', `${file}: ${key.text}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  for (const [key, value] of Object.entries(messages)) {
    assert.ok(!/[가-힣]/.test(value), `Untranslated English value: ${key}`);
    assert.deepEqual([...key.matchAll(/\{\d+\}/g)].map(x => x[0]).sort(), [...value.matchAll(/\{\d+\}/g)].map(x => x[0]).sort(), key);
  }
  setLanguage('en');
  try {
    assert.equal(getLanguage(), 'en');
    assert.equal(translate('프로젝트'), 'Project');
    assert.equal(translate('파일이 변경되었습니다: {0}', '<script>{0}한국어.js</script>'), 'The file changed: <script>{0}한국어.js</script>');
  } finally { setLanguage('ko'); }
});

test('manifest command and setting translations resolve in both languages', () => {
  const manifest = require('../package.json');
  const en = require('../package.nls.json'), ko = require('../package.nls.ko.json');
  for (const match of JSON.stringify(manifest).matchAll(/%([^%]+)%/g)) {
    assert.equal(typeof en[match[1]], 'string', match[1]);
    assert.equal(typeof ko[match[1]], 'string', match[1]);
    assert.ok(!/[가-힣]/.test(en[match[1]]));
  }
  const setting = manifest.contributes.configuration.properties['m365Agent.language'];
  assert.deepEqual(setting.enum, ['auto', 'en', 'ko']);
  assert.equal(setting.default, 'auto');
  assert.equal(setting.scope, 'application');
});

test('English and Korean views keep drafts, approvals and original model text in a real browser', async testContext => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  testContext.after(() => browser.close());
  const options = { nonce: 'locale-test', cspSource: 'https://locale.test', resource: name => 'https://locale.test/' + name };
  for (const language of ['en', 'ko']) {
    setLanguage(language);
    let html = renderWebview(options);
    const browserHtml = renderBrowserPanel(options.nonce, options.cspSource, options.resource);
    const responseHtml = renderResponse({ ...options, text: '답변 원문 <script>unsafe()</script>\n\n```js\nconst 이름 = "한국어";\n```' });
    setLanguage('ko');
    assert.match(browserHtml, new RegExp(`lang="${language}"`));
    assert.match(responseHtml, new RegExp(`lang="${language}"`));
    assert.ok(!responseHtml.includes('<script>unsafe()'));
    const page = await browser.newPage({ viewport: { width: 320, height: 850 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.sent = [];
      window.saved = { draft: '사용자 초안 {0}', review: true, composerOptions: true, readingSize: 16 };
      window.acquireVsCodeApi = () => ({ getState: () => window.saved, setState: state => { window.saved = state; }, postMessage: message => window.sent.push(message) });
    });
    await page.route('https://locale.test/**', async route => {
      const file = new URL(route.request().url()).pathname.slice(1);
      await route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', body: file ? await fs.readFile(path.join(root, 'media', file)) : html });
    });
    await page.goto('https://locale.test/');
    await page.waitForFunction(() => window.sent.some(item => item.type === 'ready'));
    const host = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    assert.equal(await page.locator('#connect').textContent(), language === 'en' ? 'Connect' : '연결');
    assert.equal(await page.locator('#task').inputValue(), '사용자 초안 {0}');
    assert.equal(await page.locator('#fontSize').textContent(), '16');
    assert.equal(await page.locator('#review').isChecked(), true);
    await host(decorate({ type: 'message', role: 'assistant', text: '한국어 답변\n\n```js\nconst 이름 = "한국어";\n```' }));
    assert.ok((await page.locator('.markdown').textContent()).includes('한국어 답변'));
    assert.equal(await page.locator('.copy-button').textContent(), language === 'en' ? 'Copy' : '복사');
    await host({ type: 'changes', summary: 'Review proposal', review: true, files: [{path:'한국어.js', id:'preview', action:'edit'}], token:'review-locale' });
    assert.equal(await page.locator('#apply').textContent(), language === 'en' ? 'Apply' : '적용');
    await page.locator('#apply').click();
    assert.equal(await page.evaluate(() => window.sent.find(item => item.type === 'apply').token), 'review-locale');
    await host({ type: 'commandApproval', command:'npm test', root:'C:\\project', token:'command-locale' });
    assert.equal(await page.locator('#approveCommand').textContent(), language === 'en' ? 'Run this command' : '이번 명령 실행');
    await page.locator('#approveCommand').click();
    assert.equal(await page.evaluate(() => window.sent.find(item => item.type === 'approveCommand').token), 'command-locale');
    await host({ type: 'idle' });
    await page.locator('#more').click();
    await page.locator('#languageSettings').click();
    assert.ok(await page.evaluate(() => window.sent.some(item => item.type === 'languageSettings')));
    for (const width of [280, 320, 360]) {
      await page.setViewportSize({width, height:850});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language} at ${width}px`);
    }
    assert.deepEqual(errors, []);
    await page.locator('#more').click();
    await fs.mkdir(path.join(root, '.test-output', 'localization'), {recursive:true});
    await page.screenshot({path:path.join(root,'.test-output','localization',`${language}-sidebar.png`)});
    // A Settings change replaces webview HTML. VS Code keeps its persisted
    // form state and sends history/pending approval again after ready.
    await page.locator('#task').fill('보존할 초안 <script> {0}');
    const persisted = await page.evaluate(() => window.saved);
    const nextLanguage = language === 'en' ? 'ko' : 'en';
    setLanguage(nextLanguage);
    html = renderWebview(options);
    setLanguage('ko');
    await page.addInitScript(state => { window.saved = state; }, persisted);
    await page.reload();
    await page.waitForFunction(() => window.sent.some(item => item.type === 'ready'));
    await host({ type:'history', sessionId:'same-conversation', running:true, events:[decorate({type:'message',role:'assistant',text:'보존할 답변'})], attachments:['src/한국어.js'], pending:{type:'commandApproval',command:'npm test',root:'C:\\project',token:'preserved-approval'}, executionPolicy:{review:true,autoApprove:false,unlimitedRounds:false} });
    assert.equal(await page.locator('#task').inputValue(), '보존할 초안 <script> {0}');
    assert.equal(await page.locator('#fontSize').textContent(), '16');
    assert.ok((await page.locator('.markdown').textContent()).includes('보존할 답변'));
    assert.ok((await page.locator('#attachments').textContent()).includes('한국어.js'));
    assert.equal(await page.locator('#approveCommand').textContent(), nextLanguage === 'en' ? 'Run this command' : '이번 명령 실행');
    await page.locator('#approveCommand').click();
    assert.equal(await page.evaluate(() => window.sent.find(item => item.type === 'approveCommand').token), 'preserved-approval');
    assert.deepEqual(errors, []);
    await page.close();
  }
});
