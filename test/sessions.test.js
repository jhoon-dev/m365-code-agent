'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConversationController } = require('../src/conversations');
const { ChangeController } = require('../src/changes');

function fixture() {
  let url = 'https://m365.cloud.microsoft/chat?threadId=a', next = 'b';
  const page = { url: () => url, isClosed: () => false, async goto(value) { url = value; } };
  let newPages = 0, newChats = 0;
  const host = {
    sessionId: 'a', events: [{ type: 'message', role: 'user', text: 'A' }], webUrl: url,
    sessions: ['a', 'b'].map(id => ({ id, title: id, updated: Date.now(), events: [{ type: 'message', role: 'user', text: id.toUpperCase() }], webUrl: 'https://m365.cloud.microsoft/chat?threadId=' + id })),
    context: { workspaceState: { update() {} } }, view: { visible: true, webview: { postMessage() {} } },
    browser: { page, context: { async newPage() { newPages++; return page; } }, async newChat() { newChats++; url = 'https://m365.cloud.microsoft/chat'; }, async waitForComposer() {}, async readConversation() { return { url, restorable: true, messages: [] }; } },
    post() {}, state: () => ({}), async ensureBrowser() { return this.browser; }
  };
  const controller = new ConversationController(host, { window: { async showQuickPick(items) { return items.find(item => item.id === next); } } });
  host.saveSession = () => controller.saveSession();
  return { host, controller, choose: value => { next = value; }, navigate: value => { url = value; }, newPages: () => newPages, newChats: () => newChats };
}

test('repeated history switches reuse the browser active tab without a separate page cache', async () => {
  const { host, controller, choose, newPages } = fixture();
  const page = host.browser.page;
  for (let i = 0; i < 12; i++) {
    const id = i % 2 ? 'a' : 'b'; choose(id);
    await controller.showHistory();
    assert.equal(host.sessionId, id);
    assert.equal(host.browser.page, page);
  }
  assert.equal(newPages(), 0);
});

test('history selection and web sync clear attachments only when switching conversations', async () => {
  const { host, controller, navigate } = fixture();
  host.attachments = ['a.pdf'];
  await controller.selectSession('a');
  assert.deepEqual(host.attachments, ['a.pdf']);
  await controller.selectSession('b');
  assert.equal(host.sessionId, 'b');
  assert.deepEqual(host.attachments, []);

  host.attachments = ['b.pdf'];
  await controller.syncWeb(false);
  assert.deepEqual(host.attachments, ['b.pdf']);
  navigate('https://m365.cloud.microsoft/chat?threadId=a');
  await controller.syncWeb(false);
  assert.equal(host.sessionId, 'a');
  assert.deepEqual(host.attachments, []);

  host.attachments = ['a-again.pdf'];
  navigate('https://m365.cloud.microsoft/chat?threadId=another');
  await controller.syncWeb();
  assert.notEqual(host.sessionId, 'a');
  assert.deepEqual(host.attachments, []);
});

test('new chat prepares the same tab once and links its first conversation without old messages', async () => {
  const { host, controller, navigate, newChats, newPages } = fixture();
  const page = host.browser.page;
  await controller.newChat();
  const id = host.sessionId;
  assert.notEqual(id, 'a'); assert.equal(host.newWebChat, true);
  assert.ok(host.sessions.find(session => session.id === 'a').events.some(event => event.text === 'A'));
  await controller.syncWeb();
  assert.deepEqual(host.events, []);
  await controller.prepareWeb();
  assert.equal(host.browser.page, page); assert.equal(newChats(), 1); assert.equal(newPages(), 0);
  assert.equal(host.newWebChat, false);
  const url = 'https://m365.cloud.microsoft/chat?threadId=new'; navigate(url);
  host.browser.readConversation = async () => ({ url, restorable: true, messages: [{ type: 'message', role: 'user', text: '첫 요청', webId: 'first' }] });
  await controller.syncWeb();
  assert.equal(host.sessionId, id); assert.equal(host.webUrl, url);
  assert.deepEqual(host.events.map(event => event.text), ['첫 요청']);
  await controller.prepareWeb(); assert.equal(newChats(), 1);
});

test('new chat remains pending if web generation blocks preparation and can be retried', async () => {
  const { host, controller, newChats } = fixture();
  await controller.newChat();
  host.browser.generationActive = async () => true;
  await assert.rejects(controller.prepareWeb(), /생성 중/);
  assert.equal(host.newWebChat, true); assert.equal(newChats(), 0);
  host.browser.generationActive = async () => false;
  await controller.prepareWeb();
  assert.equal(host.newWebChat, false); assert.equal(newChats(), 1);
});

test('cancelling while the new chat composer loads cannot mark the task ready', async () => {
  const { host, controller } = fixture();
  await controller.newChat();
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  host.browser.waitForComposer = () => new Promise(resolve => { finish = resolve; entered(); });
  const preparing = controller.prepareWeb();
  await started;
  host.stopRequested = true; controller.invalidate(); finish();
  await assert.rejects(preparing, /중지/);
  assert.equal(host.newWebChat, true);
});

test('a pending sync cannot overwrite a history selection, including switching away and back', async () => {
  const { host, controller, choose } = fixture();
  let finish;
  host.browser.readConversation = () => new Promise(resolve => { finish = resolve; });
  const pending = controller.syncWeb();
  choose('b'); await controller.showHistory();
  choose('a'); await controller.showHistory();
  finish({ url: host.webUrl, restorable: true, messages: [{ type: 'message', role: 'assistant', text: 'STALE RESULT', webId: 'stale' }] });
  await pending;
  assert.equal(host.sessionId, 'a');
  assert.deepEqual(host.events.map(event => event.text), ['A']);
});

test('a pending sync cannot resurrect the previous conversation after New Chat', async () => {
  const { host, controller } = fixture();
  let finish;
  host.browser.readConversation = () => new Promise(resolve => { finish = resolve; });
  const pending = controller.syncWeb();
  await controller.newChat();
  const newId = host.sessionId;
  finish({ url: 'https://m365.cloud.microsoft/chat?threadId=a', restorable: true, messages: [{ type: 'message', role: 'user', text: 'OLD' }] });
  await pending;
  assert.equal(host.sessionId, newId); assert.deepEqual(host.events, []);
});

test('background sync does not read the browser while the sidebar is hidden', async () => {
  const { host, controller } = fixture(); let reads = 0;
  host.view.visible = false;
  host.browser.readConversation = async () => { reads++; };
  await controller.syncWeb(false);
  assert.equal(reads, 0);
});

test('command approval separates current-task changes from retained earlier changes', async () => {
  const host = { taskId: 'new', changedFiles: new Map([
    ['old', { root: 'C:/workspace', path: 'jest.config.js', id: 'old', taskId: 'old' }],
    ['new', { root: 'C:/workspace', path: 'src/main.js', id: 'new', taskId: 'new' }]
  ]), previews: new Map([['old-new', ''], ['new-new', '']]), post() {} };
  const changes = new ChangeController(host, {});
  const pending = changes.runCommand('npm test', 'C:/workspace');
  const files = host.pending.viewData.changedFiles;
  assert.equal(files.find(file => file.path === 'jest.config.js').currentTask, false);
  assert.equal(files.find(file => file.path === 'jest.config.js').sensitive, true);
  assert.equal(files.find(file => file.path === 'src/main.js').currentTask, true);
  host.pending.resolve(false);
  assert.equal((await pending).approved, false);
});

test('renaming a conversation persists across subsequent message saves without navigating the web', async () => {
  const { host, controller, newPages, newChats } = fixture();
  controller.vscode.window.showInputBox = async () => '새 프로젝트 분석';
  await controller.manageSession('rename', 'a');
  host.events.push({ type: 'message', role: 'assistant', text: '후속 답변' }); host.saveSession();
  assert.equal(controller.summaries().find(item => item.id === 'a').title, '새 프로젝트 분석');
  assert.equal(newPages(), 0); assert.equal(newChats(), 0);
});

test('deleting a conversation requires confirmation and cannot resurrect it from an in-flight sync', async () => {
  const { host, controller, newChats } = fixture();
  controller.vscode.window.showWarningMessage = async () => undefined;
  await controller.manageSession('delete', 'a');
  assert.equal(host.sessionId, 'a');
  let finish;
  host.browser.readConversation = () => new Promise(resolve => { finish = resolve; });
  const syncing = controller.syncWeb();
  controller.vscode.window.showWarningMessage = async (_message, options) => { assert.match(options.detail, /프로젝트 파일은 삭제하지/); return '삭제'; };
  await controller.manageSession('delete', 'a');
  const fresh = host.sessionId;
  finish({ url: 'https://m365.cloud.microsoft/chat?threadId=a', restorable: true, messages: [{ type: 'message', role: 'user', text: 'OLD' }] });
  await syncing;
  assert.notEqual(fresh, 'a'); assert.equal(host.sessionId, fresh);
  assert.equal(host.sessions.some(item => item.id === 'a'), false); assert.deepEqual(host.events, []);
  assert.equal(host.newWebChat, true); assert.equal(newChats(), 0);
});

test('bulk history deletion removes local records, preserves unrelated workspace state, and respects busy tasks', async () => {
  const { host, controller } = fixture();
  const checkpoint = { original: 'workspace source' }; host.checkpoints = [checkpoint];
  controller.vscode.window.showWarningMessage = async () => '삭제';
  host.starting = true;
  await assert.rejects(controller.manageSession('deleteAll'), /작업을 마친 뒤/);
  host.starting = false;
  await controller.manageSession('deleteAll');
  assert.deepEqual(controller.summaries(), []); assert.deepEqual(host.checkpoints, [checkpoint]);
  assert.equal(host.sessions.some(item => ['a', 'b'].includes(item.id)), false);
});

test('a stale history confirmation after cancellation cannot delete local records', async () => {
  const { host, controller } = fixture();
  controller.vscode.window.showWarningMessage = async () => { controller.invalidate(); return '삭제'; };
  await controller.manageSession('deleteAll');
  assert.equal(host.sessions.some(session => session.id === 'a'), true);
  assert.equal(host.sessionId, 'a');
});
