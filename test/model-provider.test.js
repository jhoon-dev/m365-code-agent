'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ExperimentalModelProvider, registerModelProvider } = require('../src/model-provider');
const protocol = require('../src/model-protocol');
const { cleanText, ModelConversations } = require('../src/model-conversations');

class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
class CancellationError extends Error {}
class LanguageModelTextPart { constructor(value) { this.value = value; } }
class LanguageModelToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class LanguageModelToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class LanguageModelDataPart { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
class LanguageModelPromptTsxPart { constructor(value) { this.value = value; } }
function cancellation() {
  const emitter = new EventEmitter();
  return { isCancellationRequested: false, onCancellationRequested: emitter.event, cancel() { this.isCancellationRequested = true; emitter.fire(); } };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const message = text => ({ role: 1, content: [new LanguageModelTextPart(text)] });
const tool = { name: 'test_read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const model = { id: 'web-current-experimental' };

async function fixture(t, respond, enabled = true) {
  const directory = path.join(__dirname, '..', '.test-output');
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.mkdtemp(path.join(directory, 'model-provider-'));
  const settings = { 'experimental.modelProvider.enabled': enabled, 'experimental.modelProvider.maxPromptCharacters': 12000 };
  const log = [];
  const vscode = {
    EventEmitter, CancellationError, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelDataPart, LanguageModelPromptTsxPart,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
    lm: { invokeTool() { throw new Error('Provider must never execute tools'); } },
  };
  let stored;
  const state = { get: (_key, fallback) => stored ?? fallback, async update(_key, value) { stored = structuredClone(value); } };
  const provider = new ExperimentalModelProvider({ globalStorageUri: { fsPath: root }, workspaceState: state }, vscode, options => {
    log.push({ type: 'create', options });
    let url = 'https://m365.cloud.microsoft/chat';
    return {
      async connect() { log.push({ type: 'connect' }); },
      async waitForComposer() {},
      async newChat() { url = 'https://m365.cloud.microsoft/chat?threadId=' + log.length; log.push({ type: 'newChat', url }); },
      async resumeConversation(value) { url = value; log.push({ type: 'resume', url }); },
      conversationInfo() { return { url, restorable: url.includes('threadId=') }; },
      async request(prompt, id, _status, wire) { log.push({ type: 'request', prompt, id }); return respond(prompt, id, wire); },
      async stop() { log.push({ type: 'stop' }); },
      async close() { log.push({ type: 'close' }); },
    };
  });
  t.after(() => provider.dispose());
  const request = (messages = [message('안녕')], options = {}, token = cancellation(), parts = []) => ({
    parts, token,
    done: provider.provideLanguageModelChatResponse(model, messages, { toolMode: 1, modelOptions: { m365ConversationId: 'fixture' }, ...options }, { report: part => parts.push(part) }, token),
  });
  return { provider, settings, log, vscode, request, state };
}

test('model discovery is opt-in, silent and trust-aware without launching the browser', async t => {
  const f = await fixture(t, () => {}, false);
  assert.deepEqual(await f.provider.provideLanguageModelChatInformation({ silent: true }, cancellation()), []);
  const denied = f.request(); await assert.rejects(denied.done, /꺼져/);
  f.settings['experimental.modelProvider.enabled'] = true;
  const models = await f.provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
  assert.equal(models[0].id, model.id);
  assert.equal(models[0].capabilities.toolCalling, true);
  f.vscode.workspace.isTrusted = false;
  assert.deepEqual(await f.provider.provideLanguageModelChatInformation({ silent: false }, cancellation()), []);
  assert.equal(f.log.length, 0);
});

test('text and tools round-trip preserve history, IDs and input; only the host executes tools', async t => {
  let callId;
  const f = await fixture(t, (prompt, id, wire) => {
    const data = JSON.parse(prompt.split('DATA: ')[1]);
    if (data.messages.length === 1) return wire.parseReply(JSON.stringify({ requestId: id, kind: 'model', text: '읽겠습니다.', toolCalls: [{ id: 'read-1', name: tool.name, input: { path: 'src/main.js' } }] }), id);
    assert.deepEqual(data.messages[1].content, [{ type: 'tool_call', id: callId, name: tool.name, input: { path: 'src/main.js' } }]);
    assert.deepEqual(data.messages[2].content, [{ type: 'tool_result', id: callId, content: [{ type: 'text', text: 'const value = "한글";\n' }] }]);
    return wire.parseReply(JSON.stringify({ requestId: id, kind: 'model', text: '확인했습니다.', toolCalls: [] }), id);
  });
  const first = f.request([message('파일을 읽어줘')], { tools: [tool], toolMode: 2 });
  await first.done;
  assert.ok(first.parts[1] instanceof LanguageModelToolCallPart);
  callId = first.parts[1].callId;
  assert.match(callId, /^m365_[a-f0-9]{32}$/);
  const second = f.request([message('파일을 읽어줘'), { role: 2, content: [first.parts[1]] }, { role: 1, content: [new LanguageModelToolResultPart(callId, [new LanguageModelTextPart('const value = "한글";\n')])] }], { tools: [tool], modelOptions: {} });
  await second.done;
  assert.equal(cleanText(second.parts[0].value), '확인했습니다.');
  assert.equal(f.log.filter(entry => entry.type === 'newChat').length, 1);
  assert.equal(f.log.filter(entry => entry.type === 'close').length, 0);
  assert.equal(f.log.filter(entry => entry.type === 'create').length, 1, 'successful turns reuse one browser');
  assert.ok(f.log.filter(entry => entry.type === 'create').every(entry => entry.options.profile.endsWith('model-provider-profile') && entry.options.embedded === false));
});

test('native Chat identity survives text turns, A/B switching and provider restart without extra web chats', async t => {
  const f = await fixture(t, (prompt, id) => {
    assert.ok(!prompt.includes('[m365-chat:'), 'routing markers are not model input');
    return { requestId: id, kind: 'model', text: 'Same conversation answer', toolCalls: [] };
  });
  const native = { modelOptions: {} };
  const a = [message('identical first prompt')];
  const first = f.request(a, native); await first.done;
  a.push({ role: 2, content: first.parts }, message('follow up'));
  const second = f.request(a, native); await second.done;
  // An independently created Chat with identical first input must not be merged with A.
  const b = f.request([message('identical first prompt')], native); await b.done;
  assert.equal(f.log.filter(entry => entry.type === 'newChat').length, 2);
  const urlA = f.log.find(entry => entry.type === 'newChat').url;
  // Return to A using its latest assistant marker, then reload persisted mappings.
  a.push({ role: 2, content: second.parts }, message('after switching'));
  const returned = f.request(a, native); await returned.done;
  assert.equal(f.log.at(-2).url, urlA);
  await f.provider.retireBrowser();
  f.provider.conversations = new ModelConversations(f.state);
  a.push({ role: 2, content: returned.parts }, message('after restart'));
  await f.request(a, native).done;
  assert.equal(f.log.filter(entry => entry.type === 'newChat').length, 2);
  assert.equal(f.log.filter(entry => entry.type === 'resume').at(-1).url, urlA);
  const saved = JSON.stringify(f.state.get());
  assert.ok(!saved.includes('identical first prompt') && !saved.includes('Same conversation answer'));
});

test('lost or stale Chat identity and failed restoration never fall back to a new web chat', async t => {
  const f = await fixture(t, (_prompt, id) => ({ requestId: id, kind: 'model', text: 'answer', toolCalls: [] }));
  const native = { modelOptions: {} }, a = [message('first')];
  const first = f.request(a, native); await first.done;
  a.push({ role: 2, content: first.parts }, message('next'));
  const second = f.request(a, native); await second.done;
  const submissions = () => f.log.filter(entry => entry.type === 'request').length;
  await assert.rejects(f.request(a, native).done, /분기/);
  await assert.rejects(f.request([message('first'), { role: 2, content: [new LanguageModelTextPart('marker stripped')] }, message('next')], native).done, /식별자/);
  const third = [...a, { role: 2, content: second.parts }, message('third')];
  f.provider.browser.resumeConversation = async () => { throw new Error('restore failed'); };
  await assert.rejects(f.request(third, native).done, /restore failed/);
  assert.equal(submissions(), 2);
  assert.equal(f.log.filter(entry => entry.type === 'newChat').length, 1);
  await f.request(third, native).done;
  assert.equal(f.log.filter(entry => entry.type === 'newChat').length, 1);
});

test('an identical first prompt after an anonymous failure starts a different web chat', async t => {
  let attempt = 0;
  const f = await fixture(t, (_prompt, id) => {
    if (++attempt === 1) throw new Error('response lost');
    return { requestId: id, kind: 'model', text: 'answer', toolCalls: [] };
  });
  await assert.rejects(f.request(undefined, { modelOptions: {} }).done, /response lost/);
  assert.equal(f.provider.conversations.records.size, 0);
  assert.deepEqual(f.state.get(), []);
  await f.request(undefined, { modelOptions: {} }).done;
  const urls = f.log.filter(entry => entry.type === 'newChat').map(entry => entry.url);
  assert.equal(new Set(urls).size, 2);
  assert.equal(f.log.some(entry => entry.type === 'resume'), false);
});

test('explicit conversation IDs recover a failed first submission and persistence failure closes the browser', async t => {
  let attempt = 0;
  const f = await fixture(t, (_prompt, id) => {
    if (++attempt === 1) throw new Error('response lost');
    return { requestId: id, kind: 'model', text: 'answer', toolCalls: [] };
  });
  await assert.rejects(f.request().done, /response lost/);
  await f.request().done;
  const opened = f.log.find(entry => entry.type === 'newChat');
  assert.deepEqual(f.log.filter(entry => entry.type === 'resume'), [{ type: 'resume', url: opened.url }]);
  assert.equal(f.log.filter(entry => entry.type === 'newChat').length, 1);
  f.state.update = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.request().done, /storage unavailable/);
  assert.equal(f.provider.browser, null);
});

test('shutdown during the first response saves its assigned web URL before closing the page', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async (_prompt, id) => {
    entered.resolve(); await release.promise;
    return { requestId: id, kind: 'model', text: 'late', toolCalls: [] };
  });
  const request = f.request();
  const rejected = assert.rejects(request.done, CancellationError);
  await entered.promise;
  await f.provider.dispose();
  const saved = f.state.get();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].url, f.log.find(entry => entry.type === 'newChat').url);
  release.resolve(); await rejected;
  assert.deepEqual(request.parts, []);
});

test('cancelling a queued explicit-session request cannot remove the first request routing record during startup', async t => {
  const f = await fixture(t, (_prompt, id) => ({ requestId: id, kind: 'model', text: 'answer', toolCalls: [] }));
  const first = f.request(), queued = f.request();
  const rejected = assert.rejects(queued.done, CancellationError);
  queued.token.cancel(); await rejected; await first.done;
  const history = [message('안녕'), { role: 2, content: first.parts }, message('next')];
  await f.request(history, { modelOptions: {} }).done;
  assert.equal(f.log.filter(entry => entry.type === 'newChat').length, 1);
  assert.equal(f.state.get().length, 1);
});

test('oversized history/tool definitions and unsupported input fail before opening a browser', async t => {
  const f = await fixture(t, () => {});
  await assert.rejects(f.request([message('가'.repeat(12000))]).done, /잘라 보내지/);
  await assert.rejects(f.request([message('hello')], { tools: [{ ...tool, description: 'x'.repeat(12000) }] }).done, /한도/);
  await assert.rejects(f.request([{ role: 1, content: [{ mimeType: 'image/png', data: new Uint8Array([1]) }] }]).done, /이미지/);
  await assert.rejects(f.request([message('hello')], { tools: [], toolMode: 2 }).done, /도구가 없습니다/);
  assert.equal(f.log.length, 0);
});

test('unknown tools, repeated call IDs and missing required calls emit no response parts', async t => {
  let calls = [{ id: 'bad', name: 'not_provided', input: {} }];
  const f = await fixture(t, (_prompt, id) => ({ requestId: id, kind: 'model', text: 'misleading text', toolCalls: calls }));
  const first = f.request([message('hello')], { tools: [tool] });
  await assert.rejects(first.done, /제공되지 않은/); assert.deepEqual(first.parts, []);
  calls = [];
  const second = f.request([message('hello')], { tools: [tool], toolMode: 2 });
  await assert.rejects(second.done, /필수/); assert.deepEqual(second.parts, []);
  calls = [{ id: 'old', name: tool.name, input: {} }];
  const third = f.request([message('hello'), { role: 2, content: [new LanguageModelToolCallPart('old', tool.name, {})] }], { tools: [tool] });
  await assert.rejects(third.done, /재사용/); assert.deepEqual(third.parts, []);
});

test('queue serializes requests and skips a cancelled queued request without submitting it', async t => {
  const entered = deferred(), release = deferred();
  let requests = 0;
  const f = await fixture(t, async (_prompt, id) => { requests++; if (requests === 1) { entered.resolve(); await release.promise; } return { requestId: id, kind: 'model', text: 'ok', toolCalls: [] }; });
  const first = f.request(); await entered.promise;
  const second = f.request(); const rejected = assert.rejects(second.done, CancellationError);
  const third = f.request();
  second.token.cancel(); await rejected;
  assert.equal(requests, 1);
  release.resolve(); await Promise.all([first.done, third.done]);
  assert.equal(requests, 2);
  assert.deepEqual(second.parts, []);
});

test('active cancellation suppresses late results and closes the browser before the next request', async t => {
  const entered = deferred(), release = deferred();
  let requests = 0;
  const f = await fixture(t, async (_prompt, id) => { if (++requests === 1) { entered.resolve(); await release.promise; } return { requestId: id, kind: 'model', text: 'late', toolCalls: [] }; });
  const first = f.request(); const rejected = assert.rejects(first.done, CancellationError);
  await entered.promise; first.token.cancel(); await rejected;
  const next = f.request(); release.resolve(); await next.done;
  assert.deepEqual(first.parts, []);
  assert.ok(f.log.findIndex(entry => entry.type === 'close') < f.log.findLastIndex(entry => entry.type === 'create'));
});

test('disabling an active provider stops it and refuses queued work', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async (_prompt, id) => { entered.resolve(); await release.promise; return { requestId: id, kind: 'model', text: 'late', toolCalls: [] }; });
  const first = f.request(); await entered.promise;
  const second = f.request();
  const rejected = [assert.rejects(first.done, /꺼져/), assert.rejects(second.done, /꺼져/)];
  f.settings['experimental.modelProvider.enabled'] = false; f.provider.refresh(); release.resolve();
  await Promise.all(rejected);
  assert.equal(f.log.filter(entry => entry.type === 'request').length, 1);
  assert.ok(f.log.some(entry => entry.type === 'stop'));
  assert.deepEqual(first.parts, []);
});

test('model wire rejects conflicting JSON, malformed calls and foreign request IDs', () => {
  const reply = { requestId: 'current', kind: 'model', text: 'ok', toolCalls: [] };
  assert.equal(protocol.parseReply('```json\n' + JSON.stringify(reply) + '\n```', 'current').text, 'ok');
  assert.throws(() => protocol.parseReply(JSON.stringify(reply), 'other'), { code: 'REPLY_NOT_FOUND' });
  assert.throws(() => protocol.parseReply(JSON.stringify(reply) + '\n' + JSON.stringify({ ...reply, text: 'different' }), 'current'), { code: 'AMBIGUOUS_REPLY' });
  const call = { id: 'same', name: tool.name, input: {} };
  assert.throws(() => protocol.parseReply(JSON.stringify({ ...reply, toolCalls: [call, call] }), 'current'), { code: 'INVALID_REPLY_SCHEMA' });
  assert.throws(() => protocol.parseReply(JSON.stringify({ ...reply, kind: 'changes', files: [] }), 'current'), { code: 'INVALID_REPLY_SCHEMA' });
});

test('failed chat isolation submits nothing, closes its browser and allows the next request', async t => {
  const f = await fixture(t, (_prompt, id) => ({ requestId: id, kind: 'model', text: 'ok', toolCalls: [] }));
  const factory = f.provider.createBrowser;
  f.provider.createBrowser = options => {
    const browser = factory(options);
    browser.newChat = async () => { throw new Error('새 대화 버튼 없음'); };
    return browser;
  };
  await assert.rejects(f.request().done, /새 대화/);
  assert.equal(f.log.filter(entry => entry.type === 'request').length, 0);
  assert.equal(f.log.filter(entry => entry.type === 'close').length, 1);
  f.provider.createBrowser = factory;
  await f.request().done;
  assert.equal(f.log.filter(entry => entry.type === 'request').length, 1);
});

test('queue capacity is bounded and an already-cancelled request launches nothing', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async (_prompt, id) => { entered.resolve(); await release.promise; return { requestId: id, kind: 'model', text: 'ok', toolCalls: [] }; });
  const cancelled = cancellation(); cancelled.cancel();
  await assert.rejects(f.request(undefined, undefined, cancelled).done, CancellationError);
  assert.equal(f.log.length, 0);
  const jobs = [f.request()]; await entered.promise;
  for (let index = 1; index < 8; index++) jobs.push(f.request());
  await assert.rejects(f.request().done, /8개/);
  release.resolve(); await Promise.all(jobs.map(job => job.done));
  assert.equal(f.log.filter(entry => entry.type === 'request').length, 8);
});

test('disable then re-enable never revives old active or queued requests', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async (_prompt, id) => { entered.resolve(); await release.promise; return { requestId: id, kind: 'model', text: 'late', toolCalls: [] }; });
  const first = f.request(); await entered.promise;
  const second = f.request();
  const rejected = [assert.rejects(first.done, CancellationError), assert.rejects(second.done, CancellationError)];
  f.settings['experimental.modelProvider.enabled'] = false; f.provider.refresh();
  f.settings['experimental.modelProvider.enabled'] = true; f.provider.refresh();
  release.resolve(); await Promise.all(rejected);
  assert.deepEqual(first.parts, []); assert.deepEqual(second.parts, []);
  assert.equal(f.log.filter(entry => entry.type === 'request').length, 1);
  await f.request().done;
  assert.equal(f.log.filter(entry => entry.type === 'request').length, 2);
});

test('System roles and supported text DataPart/PromptTsx content are preserved without promoting tool results', async t => {
  const f = await fixture(t, () => {});
  const tree = { node: { type: 1, ctor: 2, children: [{ type: 2, text: 'first' }, { type: 2, text: '한글', lineBreakBefore: true }] } };
  const converted = protocol.convertMessages([
    { role: 3, content: [new LanguageModelTextPart('system policy')] },
    { role: 1, content: [new LanguageModelDataPart(Buffer.from('{"한글":true}'), 'application/json'), new LanguageModelPromptTsxPart(tree)] },
    { role: 1, content: [new LanguageModelToolResultPart('result', [new LanguageModelPromptTsxPart(tree)])] },
  ], f.vscode);
  assert.equal(converted[0].role, 'system');
  assert.equal(converted[1].content[0].text, '{"한글":true}');
  assert.equal(converted[1].content[1].text, 'first\n한글');
  assert.equal(converted[2].content[0].type, 'tool_result');
  assert.equal(converted[2].content[0].content[0].text, 'first\n한글');
  assert.throws(() => protocol.convertMessages([{ role: 1, content: [new LanguageModelDataPart(Buffer.from([255]), 'text/plain')] }], f.vscode));
  assert.throws(() => protocol.convertMessages([{ role: 1, content: [new LanguageModelDataPart(Buffer.from([1]), 'image/png')] }], f.vscode), /바이너리/);
  assert.throws(() => protocol.convertMessages([{ role: 1, content: [new LanguageModelPromptTsxPart({ node: { type: 1, ctor: 3, children: [] } })] }], f.vscode), /이미지/);
  assert.throws(() => protocol.convertMessages([{ role: 4, content: [] }], f.vscode), /역할/);
});

test('large Agent input retains System/first/latest task, latest tool exchange and all 48 schemas', async t => {
  let sent;
  const f = await fixture(t, (prompt, id) => { sent = JSON.parse(prompt.split('DATA: ')[1]); return { requestId: id, kind: 'model', text: 'ok', toolCalls: [] }; });
  f.settings['experimental.modelProvider.maxPromptCharacters'] = 48000;
  const tools = Array.from({ length: 48 }, (_, index) => ({ ...tool, name: `read_${index}`, description: 'Complete tool description. '.repeat(15) }));
  const messages = [
    { role: 3, content: [new LanguageModelTextPart('System instruction. '.repeat(200))] },
    message('원래 작업 요청'),
    message('중간에 추가한 사용자 제한: 외부 전송 금지'),
    { role: 2, content: [new LanguageModelToolCallPart('old', tools[0].name, { path: 'old.js' })] },
    { role: 1, content: [new LanguageModelToolResultPart('old', [new LanguageModelTextPart('OLD SOURCE '.repeat(8000))])] },
    message('최신 요청: 새 결과로 확인해줘'),
    { role: 2, content: [new LanguageModelToolCallPart('latest', tools[1].name, { path: 'new.js' })] },
    { role: 1, content: [new LanguageModelToolResultPart('latest', [new LanguageModelTextPart('const exact = "한글";\n')])] },
  ];
  const request = f.request(messages, { tools }); await request.done;
  assert.deepEqual(sent.tools, tools);
  assert.equal(sent.messages[0].role, 'system');
  assert.ok(sent.messages.some(msg => msg.content.some(part => part.text === '원래 작업 요청')));
  assert.ok(sent.messages.some(msg => msg.content.some(part => part.text === '중간에 추가한 사용자 제한: 외부 전송 금지')));
  assert.ok(sent.messages.some(msg => msg.content.some(part => part.text?.startsWith('최신 요청'))));
  assert.deepEqual(sent.messages.at(-1).content[0].content, [{ type: 'text', text: 'const exact = "한글";\n' }]);
  assert.deepEqual(sent.usedToolCallIds, ['old', 'latest']);
  assert.equal(sent.contextReduction.omittedMessages, 2);
  assert.match(sent.contextReduction.policy, /old complete exchanges omitted/);
  assert.doesNotMatch(sent.contextReduction.policy, /replaced with references/);
  assert.ok(!JSON.stringify(sent.messages).includes('OLD SOURCE'));
  assert.match(request.parts[0].value, /문맥 축소/);
});

test('compaction never removes System instructions, the newest tool exchange or any tool schema', () => {
  const system = { role: 'system', content: [{ type: 'text', text: 'System '.repeat(3000) }] };
  assert.throws(() => protocol.prepareModelPrompt('id', [system, { role: 'user', content: [{ type: 'text', text: 'task' }] }], {}, 12000), error => {
    assert.equal(error.code, 'MODEL_CONTEXT_TOO_LARGE');
    assert.ok(error.requiredCharacters > 12000);
    assert.equal(error.maxCharacters, 12000);
    assert.equal(error.tools, 0);
    assert.match(error.message, /먼저 새 Chat을 시작하세요/);
    return true;
  });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'task' }] }, { role: 'assistant', content: [{ type: 'tool_call', id: 'read', name: tool.name, input: {} }] }, { role: 'user', content: [{ type: 'tool_result', id: 'read', content: [{ type: 'text', text: 'new source'.repeat(4000) }] }] }];
  assert.throws(() => protocol.prepareModelPrompt('id', messages, { tools: [tool] }, 12000), { code: 'MODEL_CONTEXT_TOO_LARGE' });
});

test('token reporting uses a UTF-8 token estimate and a separate conservative token budget', async t => {
  const f = await fixture(t, () => {});
  const ascii = await f.provider.provideTokenCount(model, 'a'.repeat(300), cancellation());
  const korean = await f.provider.provideTokenCount(model, '가'.repeat(300), cancellation());
  assert.equal(ascii, 100); assert.equal(korean, 300);
  const [info] = await f.provider.provideLanguageModelChatInformation({}, cancellation());
  assert.equal(info.maxInputTokens, 3333);
  assert.notEqual(info.maxInputTokens, f.settings['experimental.modelProvider.maxPromptCharacters']);
  delete f.settings['experimental.modelProvider.maxPromptCharacters'];
  const [defaults] = await f.provider.provideLanguageModelChatInformation({}, cancellation());
  assert.equal(f.provider.promptLimit(), 120000);
  assert.equal(defaults.maxInputTokens, 39333);
});

test('a confirmed unsent maxlength rejection rebudgets old exchanges once and keeps the warm browser', async t => {
  let attempts = 0;
  const f = await fixture(t, (prompt, id) => {
    if (++attempts === 1) throw Object.assign(new Error('maxlength'), { code: 'PROMPT_LIMIT', notSubmitted: true, maxCharacters: 6000 });
    assert.ok(prompt.length <= 6000);
    assert.ok(JSON.parse(prompt.split('DATA: ')[1]).contextReduction.omittedMessages > 0);
    return { requestId: id, kind: 'model', text: 'ok', toolCalls: [] };
  });
  const messages = [message('task'), { role: 2, content: [new LanguageModelToolCallPart('old', tool.name, {})] }, { role: 1, content: [new LanguageModelToolResultPart('old', [new LanguageModelTextPart('x'.repeat(7000))])] }, message('latest request'), { role: 2, content: [new LanguageModelToolCallPart('new', tool.name, {})] }, { role: 1, content: [new LanguageModelToolResultPart('new', [new LanguageModelTextPart('exact recent source')])] }];
  await f.request(messages, { tools: [tool] }).done;
  assert.equal(attempts, 2);
  assert.equal(f.log.filter(entry => entry.type === 'create').length, 1);
  assert.equal(f.log.filter(entry => entry.type === 'close').length, 0);
});

test('uncertain or submitted length failures are never resubmitted', async t => {
  let attempts = 0;
  const f = await fixture(t, () => { attempts++; throw Object.assign(new Error('uncertain send'), { code: 'PROMPT_LIMIT', notSubmitted: false, maxCharacters: 6000 }); });
  await assert.rejects(f.request().done, /uncertain/);
  assert.equal(attempts, 1);
  assert.equal(f.log.filter(entry => entry.type === 'close').length, 1);
});

test('idle browsers close on configuration change and shutdown', async t => {
  const f = await fixture(t, (_prompt, id) => ({ requestId: id, kind: 'model', text: 'ok', toolCalls: [] }));
  await f.request().done;
  f.provider.refresh(); await f.provider.closing;
  assert.equal(f.log.filter(entry => entry.type === 'close').length, 1);
  await f.request().done;
  await f.provider.dispose();
  assert.equal(f.log.filter(entry => entry.type === 'close').length, 2);
});

test('Agent-sized static context fits the advertised budget in the same token units', async t => {
  const f = await fixture(t, () => {});
  f.settings['experimental.modelProvider.maxPromptCharacters'] = 48000;
  // Real Copilot compact Agent: about 38K message characters plus 5K of schemas.
  const messages = [{ role: 'system', content: [{ type: 'text', text: 's'.repeat(38000) }] }, { role: 'user', content: [{ type: 'text', text: 'Fix calculator.js' }] }];
  const tools = Array.from({ length: 5 }, (_, index) => ({ ...tool, name: `file_${index}`, description: 'd'.repeat(800) }));
  const prepared = protocol.prepareModelPrompt('live-shaped', messages, { tools }, 48000);
  const tokens = protocol.estimateTokens(JSON.stringify(messages) + JSON.stringify(tools));
  const [info] = await f.provider.provideLanguageModelChatInformation({}, cancellation());
  assert.ok(prepared.prompt.length < 48000);
  assert.ok(tokens <= info.maxInputTokens, 'transport-valid static Agent context must not be rejected by an inconsistent /4 budget');
});

test('model diagnostics contain counts and phases but no prompt, tool input or response content', async t => {
  const f = await fixture(t, (_prompt, id) => ({ requestId: id, kind: 'model', text: 'PRIVATE RESPONSE', toolCalls: [] }));
  const lines = [];
  f.provider.output = { appendLine: line => lines.push(line), dispose() {} };
  await f.request([message('PRIVATE PROMPT')], { tools: [{ ...tool, description: 'PRIVATE SCHEMA' }] }).done;
  assert.ok(lines.some(line => JSON.parse(line).event === 'converted'));
  assert.ok(lines.some(line => JSON.parse(line).event === 'response'));
  assert.ok(!lines.join('\n').includes('PRIVATE'));
});

test('five user turns fit by referencing exact repeated text without losing intermediate restrictions', () => {
  const repeated = 'Full repeated host context and attachment\n'.repeat(260);
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'system policy' }] },
    ...Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: [
      { type: 'text', text: repeated },
      { type: 'text', text: `Turn ${index}: preserve restriction ${index}; do not modify config-${index}.json` },
    ] })),
  ];
  const original = structuredClone(messages);
  const prepared = protocol.prepareModelPrompt('five-turns', messages, {}, 30000);
  assert.ok(prepared.prompt.length <= 30000);
  const data = JSON.parse(prepared.prompt.split('DATA: ')[1]);
  assert.equal(prepared.omittedMessages, 0);
  assert.equal(data.contextReduction.referencedTextParts, 3);
  assert.match(data.contextReduction.policy, /replaced with references/);
  assert.doesNotMatch(data.contextReduction.policy, /exchanges omitted/);
  assert.deepEqual(data.messages[1], messages[1]);
  assert.deepEqual(data.messages.at(-1), messages.at(-1));
  const restored = data.messages.map(msg => ({ ...msg, content: msg.content.map(part =>
    part.type === 'text_reference' ? data.messages[part.messageIndex].content[part.partIndex] : part
  ) }));
  assert.deepEqual(restored, original);
  assert.deepEqual(messages, original, 'caller history must not be mutated');
});

test('unmarked and unique user text is never stripped as supposed attachment context', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: [{
    type: 'text', text: `<attachments>USER RESTRICTION ${index}: ${String(index).repeat(9000)}</attachments>`,
  }] }));
  assert.throws(() => protocol.prepareModelPrompt('untrusted-markup', messages, {}, 30000), { code: 'MODEL_CONTEXT_TOO_LARGE' });
});

test('Webview configuration changes leave model requests intact; consumed settings invalidate them', async t => {
  const f = await fixture(t, () => {});
  let listener;
  f.vscode.workspace.onDidChangeConfiguration = callback => { listener = callback; return { dispose() {} }; };
  f.vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  f.vscode.lm.registerLanguageModelChatProvider = () => ({ dispose() {} });
  const registered = registerModelProvider({ ...f.provider.context, subscriptions: [] }, f.vscode);
  t.after(() => registered.dispose());
  let interruptions = 0;
  registered.interruptActive = () => { interruptions++; };
  const change = key => listener({ affectsConfiguration: section => key === section || key.startsWith(section + '.') });
  for (const key of ['browserView', 'maxPromptCharacters', 'maxRounds', 'allowWithoutApproval']) change('m365Agent.' + key);
  assert.equal(registered.generation, 0);
  assert.equal(interruptions, 0);
  for (const key of ['experimental.modelProvider.enabled', 'experimental.modelProvider.maxPromptCharacters', 'copilotUrl', 'browserChannel', 'composerSelector', 'sendButtonSelector', 'responseSelector', 'modelButtonSelector', 'responseTimeoutSeconds', 'loginTimeoutSeconds']) change('m365Agent.' + key);
  assert.equal(registered.generation, 10);
  assert.equal(interruptions, 10);
});
