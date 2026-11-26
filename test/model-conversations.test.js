'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ModelConversations, cleanMessages, cleanText } = require('../src/model-conversations');
const { renderMarkdown } = require('../src/markdown');
const endpoint = 'https://m365.cloud.microsoft/chat';
const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });

test('routing references are invisible Markdown, stripped only from assistant text and persist without bodies', async () => {
  let saved;
  const state = { get: (_key, fallback) => saved ?? fallback, async update(_key, value) { saved = structuredClone(value); } };
  const map = new ModelConversations(state), input = [msg('user', 'private source')];
  const binding = map.resolve(input, {}, endpoint), record = binding.record;
  record.started = true;
  map.capture(record, { restorable: true, url: endpoint + '?threadId=a&access_token=SECRET' });
  const response = map.finish(record, '## Visible answer', [{ id: 'upstream', name: 'read', input: {} }]);
  assert.equal(renderMarkdown(response.text), renderMarkdown('## Visible answer'));
  const history = [...input, msg('assistant', response.text), msg('user', response.text), { role: 'user', content: [{ type: 'tool_result', id: response.calls[0].id, content: [{ type: 'text', text: response.text }] }] }];
  const clean = cleanMessages(history);
  assert.equal(clean[1].content[0].text, '## Visible answer');
  assert.equal(clean[2].content[0].text, response.text);
  assert.equal(clean[3].content[0].content[0].text, response.text);
  assert.equal(map.resolve(history, {}, endpoint).record, record);
  await map.save();
  assert.ok(!JSON.stringify(saved).includes('SECRET') && !JSON.stringify(saved).includes('private source'));
  const restored = new ModelConversations(state);
  assert.equal(restored.resolve(history, {}, endpoint).record.url, endpoint + '?threadId=a');
  const toolOnly = [...input, { role: 'assistant', content: [{ type: 'tool_call', ...response.calls[0] }] }];
  assert.equal(restored.resolve(toolOnly, {}, endpoint).record.id, record.id);
  assert.equal(cleanText(response.text), '## Visible answer');
});

test('new native Chats remain distinct, user references cannot route, mixed/stale/foreign histories fail closed', () => {
  const map = new ModelConversations(), input = [msg('user', 'same prompt')];
  const a = map.resolve(input, {}, endpoint).record, b = map.resolve(input, {}, endpoint).record;
  assert.notEqual(a.id, b.id);
  const one = map.finish(a, 'one', []), two = map.finish(b, 'two', []);
  assert.notEqual(map.resolve([msg('user', one.text)], {}, endpoint).record.id, a.id);
  assert.throws(() => map.resolve([msg('assistant', one.text), msg('assistant', two.text)], {}, endpoint), /섞여/);
  const history = [msg('assistant', one.text)];
  map.finish(a, 'latest', []);
  assert.throws(() => map.check(map.resolve(history, {}, endpoint)), /분기/);
  assert.throws(() => map.resolve(history, {}, 'https://m365.cloud.microsoft/chat?agentId=different'), /설정/);
  const foreign = new ModelConversations();
  assert.throws(() => foreign.resolve(history, {}, endpoint), /연결 정보/);
});

test('legacy anonymous failed mappings are discarded while explicitly identified failures are restored', async () => {
  const input = [msg('user', 'same prompt')];
  const map = new ModelConversations();
  const anonymous = map.resolve(input, {}, endpoint).record;
  const options = { modelOptions: { m365ConversationId: 'known-chat' } };
  const explicit = map.resolve(input, options, endpoint).record;
  for (const record of [anonymous, explicit]) {
    record.started = true;
    map.capture(record, { restorable: true, url: endpoint + '?threadId=' + record.id });
  }
  let saved = [{ ...anonymous, failedInput: 'a'.repeat(64) }, explicit];
  const restored = new ModelConversations({ get: () => saved, async update(_key, value) { saved = value; } });
  assert.equal(restored.records.has(anonymous.id), false);
  assert.equal(restored.resolve(input, {}, endpoint).record.url, null);
  assert.equal(restored.resolve(input, options, endpoint).record.url, explicit.url);
  await restored.save();
  assert.deepEqual(saved.map(record => record.id), [explicit.id]);
});

test('bounded saved turn lookup accepts long histories only when their latest anchor is current', () => {
  const map = new ModelConversations(), record = map.resolve([msg('user', 'first')], {}, endpoint).record;
  const history = [];
  for (let i = 0; i < 80; i++) history.push(msg('assistant', map.finish(record, String(i), []).text));
  assert.equal(record.turns.length, 64);
  map.check(map.resolve(history, {}, endpoint));
  assert.throws(() => map.check(map.resolve(history.slice(0, 1), {}, endpoint)), /분기/);
});

test('malformed or unsafe saved mappings are rejected instead of silently creating conversations', () => {
  for (const saved of [{}, [null], [{ id: 'invalid' }]]) {
    const map = new ModelConversations({ get: () => saved });
    assert.throws(() => map.resolve([msg('user', 'new')], {}, endpoint), /저장된/);
  }
});
