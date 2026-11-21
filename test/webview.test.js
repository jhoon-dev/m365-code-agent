'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const { decorate } = require('../src/markdown');

test('chat UI handles submission, Korean IME, progress, approvals and narrow layouts', async t => {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'src', 'extension.js');
  const localRequire = createRequire(source);
  let provider;
  const noop = () => {};
  const vscode = {
    window: { createTreeView: () => ({ visible: false, onDidChangeVisibility: noop, dispose: noop }), createOutputChannel: () => ({ appendLine: noop, dispose: noop }), registerWebviewViewProvider: (_id, value) => { provider = value; } },
    workspace: { registerTextDocumentContentProvider: noop }, commands: { registerCommand: noop },
    languages: { registerCodeActionsProvider: noop },
    CodeActionKind: { QuickFix: { append: value => `quickfix.${value}` } },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) }
  };
  const sandbox = { require: name => name === 'vscode' ? vscode : localRequire(name), module: { exports: {} } };
  vm.runInNewContext(await fs.readFile(source, 'utf8'), sandbox, { filename: source });
  sandbox.module.exports.activate({ workspaceState: { get: (_key, fallback) => fallback, update: noop }, subscriptions: [], extensionUri: { fsPath: root } });
  const view = { webview: { cspSource: 'https://agent.test', asWebviewUri: uri => 'https://agent.test/' + path.basename(uri.fsPath), onDidReceiveMessage: noop } };
  provider.resolveWebviewView(view);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  await page.addInitScript(() => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: message => window.sent.push(message) });
  });
  await page.route('https://agent.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const theme = ':root{--vscode-foreground:#ddd;--vscode-sideBar-background:#181818;--vscode-input-background:#252526;--vscode-input-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#444;--vscode-focusBorder:#569cd6;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#333;--vscode-button-secondaryForeground:#ddd;--vscode-errorForeground:#f88;--vscode-font-family:Segoe UI,sans-serif;--vscode-editor-font-family:Consolas,monospace;--vscode-textLink-foreground:#79b8ff}';
    await route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', body: file ? (file.endsWith('.css') ? theme : '') + await fs.readFile(path.join(root, 'media', file), 'utf8') : view.webview.html });
  });
  await page.goto('https://agent.test/');
  await page.waitForFunction(() => window.sent.some(message => message.type === 'ready'));
  await page.getByRole('button', { name: '이미지·문서·동영상', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'attachLocal').length), 1);
  assert.equal(await page.locator('#review').isChecked(), true);
  const input = page.locator('#task');
  await input.fill('첫 줄'); await input.press('Shift+Enter');
  assert.equal((await page.evaluate(() => window.sent.filter(message => message.type === 'run'))).length, 0);
  await input.evaluate(element => { element.dispatchEvent(new CompositionEvent('compositionstart')); element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })); element.dispatchEvent(new CompositionEvent('compositionend')); });
  assert.equal((await page.evaluate(() => window.sent.filter(message => message.type === 'run'))).length, 0);
  await input.press('Enter');
  assert.equal((await page.evaluate(() => window.sent.filter(message => message.type === 'run'))).length, 1);
  assert.equal(await page.locator('#stop').isVisible(), true);
  assert.equal(await page.locator('#attachLocal').isDisabled(), true);
  const host = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  assert.equal(await page.locator('#mode').count(), 0);
  await host({ type: 'idle' });
  const submitted = await page.evaluate(() => window.sent.find(message => message.type === 'run'));
  await host({ type: 'runResult', clientRequestId: submitted.clientRequestId, success: false });
  assert.match(await input.inputValue(), /첫 줄/);
  await input.fill('다시 요청'); await input.press('Enter');
  const next = await page.evaluate(() => window.sent.filter(message => message.type === 'run').at(-1));
  await input.fill('다음 작업 작성 중');
  await host({ type: 'runResult', clientRequestId: next.clientRequestId, success: false });
  assert.equal(await input.inputValue(), '다음 작업 작성 중');
  await host({ type: 'message', role: 'user', text: '빈 배열 오류를 수정하고 테스트해줘.' });
  await host({ type: 'tool', id: 'read-1', label: 'read_file · src/average.js', state: 'running' });
  await host({ type: 'tool', id: 'read-1', label: 'read_file · src/average.js', state: 'done' });
  assert.equal(await page.locator('.tool').count(), 1);
  await host({ type: 'progress', round: 3, total: 20, remaining: 17 });
  await host({ type: 'status', text: '웹 응답을 수집하고 있습니다.' });
  assert.equal(await page.locator('#roundProgress').textContent(), 'Copilot 요청 3회 · 안전 한도 20회');
  await host(decorate({ type: 'message', role: 'assistant', text: '## 변경 결과\n\n빈 배열에는 null을 반환하도록 수정합니다.\n```js\naverage([]) === null\n```\n\n| 파일 | 결과 |\n| --- | --- |\n| average.js | 완료 |' }));
  assert.equal(await page.locator('.markdown h2').textContent(), '변경 결과');
  assert.equal(await page.locator('.markdown table').count(), 1);
  await page.locator('.code-toolbar .copy-button').click();
  assert.match((await page.evaluate(() => window.sent.find(message => message.type === 'copyCode'))).text, /average\(\[\]\)/);
  await host({ type: 'changes', summary: '빈 배열 처리 및 회귀 테스트', files: [{ id: 'preview-1', path: 'src/average.js', action: 'replace' }], review: true, forcedReview: ['package.json'], token: 'review-123' });
  assert.match(await page.locator('#reviewReason').textContent(), /자동 적용/);
  await page.locator('#apply').click();
  assert.equal((await page.evaluate(() => window.sent.find(message => message.type === 'apply'))).token, 'review-123');
  await host({ type: 'commandApproval', command: 'npm test', root: 'C:\\workspace\\sample', changedFiles: [{ path: 'package.json', sensitive: true, id: 'preview-1', currentTask: true }, { path: 'src/earlier.js', id: 'earlier', currentTask: false }], token: 'cmd-123' });
  assert.match(await page.locator('#commandChanges').textContent(), /실행 설정 · package.json/);
  assert.match(await page.locator('#commandChanges').textContent(), /이번 요청에서 변경한 파일/);
  assert.match(await page.locator('#commandChanges').textContent(), /이전 요청에서 변경한 파일/);
  await page.locator('#approveCommand').click();
  assert.equal((await page.evaluate(() => window.sent.find(message => message.type === 'approveCommand'))).token, 'cmd-123');
  await host({ type: 'idle' });
  assert.equal(await page.locator('#roundProgress').isVisible(), false);
  await host({ type: 'models', choices: [{ id: 'real-id', label: '계정에서 읽은 모델' }], selected: '' });
  await page.locator('#composerOptions > summary').click();
  await page.locator('#model').selectOption('real-id');
  assert.equal((await page.evaluate(() => window.sent.find(message => message.type === 'selectModel'))).id, 'real-id');
  await host({ type: 'status', text: '전송을 확인하지 못했습니다.', error: true });
  assert.equal(await page.locator('#status.error').textContent(), '전송을 확인하지 못했습니다.');
  for (const width of [280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await host({ type: 'status', text: '변경 검토 · 파일을 눌러 diff를 확인하세요.' });
  await host({ type: 'changes', summary: '빈 배열 처리 및 회귀 테스트', files: [{ id: 'preview-1', path: 'src/average.js', action: 'replace' }, { id: 'preview-2', path: 'test/average.test.js', action: 'create' }], review: true, token: 'new' });
  await fs.mkdir(path.join(root, '.test-output'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.test-output', 'agent-ui.png') });

  await page.getByRole('button', { name: '더 보기', exact: true }).click();
  assert.equal(await page.getByRole('menu').isVisible(), true);
  await page.getByRole('menuitem', { name: '프로젝트 점검' }).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getByRole('menuitem', { name: '연결 진단' }).evaluate(element => element === document.activeElement), true);
  await page.getByRole('menuitem', { name: '연결 진단' }).click();
  assert.equal(await page.getByRole('menu').isVisible(), false);
  assert.ok((await page.evaluate(() => window.sent)).some(message => message.type === 'diagnostics'));
  await page.getByRole('button', { name: '대화 기록', exact: true }).click();
  assert.equal(await page.locator('#historyPanel').isVisible(), true);
  assert.ok((await page.evaluate(() => window.sent)).some(message => message.type === 'listSessions'));
  await host({ type: 'sessions', items: [{ id: 'one', title: '프로젝트 분석', count: 4, updated: Date.now(), active: true, linked: true }, { id: 'two', title: '<img src=x onerror=alert(1)> 쇼핑몰 코드 작성', count: 2, updated: Date.now() }] });
  assert.equal(await page.locator('.session-row').count(), 2);
  assert.equal(await page.locator('#sessionList img').count(), 0);
  await page.locator('#historySearch').fill('쇼핑몰');
  assert.equal(await page.locator('.session-row').count(), 1);
  await page.getByRole('button', { name: '이름 변경', exact: true }).click();
  assert.equal((await page.evaluate(() => window.sent.find(message => message.type === 'renameSession'))).id, 'two');
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  assert.equal((await page.evaluate(() => window.sent.find(message => message.type === 'deleteSession'))).id, 'two');
  await page.locator('#historySearch').fill('');
  await host({ type: 'sessions', items: [{ id: 'one', title: '프로젝트 구조 분석', count: 4, updated: Date.now(), active: true, linked: true }, { id: 'two', title: '쇼핑몰 상품 목록 컴포넌트 작성', count: 2, updated: Date.now() }] });
  for (const width of [280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.screenshot({ path: path.join(root, '.test-output', 'history-ui.png') });
  await page.getByRole('button', { name: '모든 VS Code 기록 삭제' }).click();
  assert.ok((await page.evaluate(() => window.sent)).some(message => message.type === 'deleteAllSessions'));
  await page.locator('.session-open').first().click();
  assert.equal(await page.locator('#historyPanel').isVisible(), false);
  assert.equal((await page.evaluate(() => window.sent.find(message => message.type === 'openSession'))).id, 'one');

  // Editor actions use review even when the next chat request prefers auto-approval.
  await page.locator('#composerOptions').evaluate(element => { element.open = true; });
  await page.locator('#autoApprove').check();
  await page.locator('#unlimitedRounds').check();
  await input.fill('작성 중인 다음 요청');
  await host({ type: 'busy', policy: { autoApprove: false, review: true, unlimitedRounds: false } });
  assert.equal(await page.locator('#approvalMode').textContent(), '승인 켜짐');
  assert.equal(await page.locator('#roundMode').isVisible(), false);
  assert.equal(await page.locator('#autoApprove').isChecked(), true);
  assert.equal(await input.inputValue(), '작성 중인 다음 요청');
  await host({ type: 'history', sessionId: 'editor-action', events: [], attachments: [], running: true,
    executionPolicy: { autoApprove: false, review: true, unlimitedRounds: false } });
  assert.equal(await page.locator('#approvalMode').textContent(), '승인 켜짐');
  await host({ type: 'idle' });
  assert.equal(await page.locator('#approvalMode').textContent(), '승인 없이 진행');
  assert.equal(await page.locator('#roundMode').isVisible(), true);
  assert.equal(await input.inputValue(), '작성 중인 다음 요청');

  await host({ type: 'busy', policy: { autoApprove: true, review: false, mcpRequiresApproval: true } });
  assert.equal(await page.locator('#approvalMode').textContent(), '로컬 자동 승인 · MCP 매번 승인');
  const mcpInput = JSON.stringify({ query: '<script>not executed</script>' }, null, 2);
  await host({ type: 'commandApproval', approvalKind: 'mcp', tool: 'mcp_docs_search', root: 'C:/project', command: mcpInput,
    changedFiles: [], token: 'mcp-review-token' });
  assert.equal(await page.locator('#approvalTitle').textContent(), 'MCP 도구 실행 승인');
  assert.equal(await page.locator('#commandText').textContent(), mcpInput);
  assert.equal(await page.locator('#commandText script').count(), 0);
  await page.locator('#approveCommand').click();
  assert.equal((await page.evaluate(() => window.sent.findLast(message => message.type === 'approveCommand'))).token, 'mcp-review-token');
  await host({ type: 'commandApproval', command: 'npm test', root: 'C:/project', changedFiles: [], token: 'normal-review-token' });
  assert.equal(await page.locator('#approvalTitle').textContent(), '명령 실행 승인');
  assert.equal(await page.locator('#approvalNote').isVisible(), false);
  await host({ type: 'idle' });

  // Exercise the host's actual conversation mapping without calling a model or file tool.
  view.webview.postMessage = noop;
  let snapshot = { url: 'https://m365.cloud.microsoft/chat?threadId=one', restorable: true, messages: [{ type: 'message', role: 'user', text: '첫 대화', webId: 'one:1' }] };
  provider.browser = { page: { isClosed: () => false }, async newChat() {}, async waitForComposer() {}, readConversation: async () => snapshot };
  await provider.syncWeb();
  assert.equal(provider.webUrl, undefined, 'a pending new local chat must not adopt the previously opened web chat');
  await provider.conversations.prepareWeb();
  await provider.syncWeb();
  const firstId = provider.sessionId;
  snapshot = { url: 'https://m365.cloud.microsoft/chat?threadId=two', restorable: true, messages: [{ type: 'message', role: 'user', text: '다른 대화', webId: 'two:1' }] };
  await provider.syncWeb();
  assert.notEqual(provider.sessionId, firstId);
  assert.equal(provider.events[0].text, '다른 대화');
  snapshot = { url: 'https://m365.cloud.microsoft/chat?threadId=one', restorable: true, messages: [{ type: 'message', role: 'user', text: '첫 대화', webId: 'one:1' }, { type: 'message', role: 'assistant', text: '웹에서 추가된 답변', webId: 'one:2' }] };
  await provider.syncWeb();
  assert.equal(provider.sessionId, firstId);
  assert.equal(provider.events.length, 2);
  await provider.syncWeb();
  assert.equal(provider.events.length, 2);
  await provider.newChat();
  await provider.syncWeb();
  assert.equal(provider.events.length, 0, 'a new local chat must not re-import the previous web conversation');
});
