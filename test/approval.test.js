'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChangeController } = require('../src/changes');
const { buildPrompt } = require('../src/protocol');

function fixture() {
  const events = [], commands = [];
  const host = { changedFiles: new Map(), previews: new Map(), stopRequested: false, post: event => events.push(event), output: { appendLine() {}, append() {}, show() {} }, config: () => ({ get: (_name, fallback) => fallback }), runner: { async run(command, root) { commands.push({ command, root }); return { exitCode: 0, output: 'ok' }; } } };
  return { host, events, commands, controller: new ChangeController(host, {}) };
}

test('automatic approval runs commands without a pending prompt; default and non-boolean values still require approval', async () => {
  const { host, events, commands, controller } = fixture();
  assert.equal((await controller.runCommand('npm test', 'C:/project', true)).exitCode, 0);
  assert.equal(host.pending, undefined); assert.equal(commands.length, 1);
  assert.ok(events.some(event => event.role === 'system' && event.text.includes('승인 없이 진행')));
  for (const policy of [undefined, 'true']) {
    const job = controller.runCommand('npm test', 'C:/project', policy);
    assert.equal(host.pending.kind, 'command'); assert.equal(commands.length, 1);
    host.pending.resolve(false); assert.equal((await job).approved, false);
  }
});

test('automatic file approval bypasses execution-config review but never bypasses file validation or cancellation', async () => {
  const { host, events, controller } = fixture();
  const changes = [{ path: 'package.json', target: 'C:/project/package.json', action: 'replace', original: 'before', content: 'after' }];
  let verified = 0;
  const store = { async verifyChanges() { verified++; throw new Error('hash changed'); } };
  await assert.rejects(controller.stageAndApply(store, changes, 'Update script', true, true), /hash changed/);
  assert.equal(verified, 1); assert.equal(host.pending, undefined);
  assert.ok(events.some(event => event.type === 'changes' && event.autoApproved === true && event.review === false));
  host.stopRequested = true;
  assert.equal(await controller.stageAndApply(store, changes, 'Cancelled', false, true), false);
  assert.equal(verified, 1);
  await assert.rejects(controller.runCommand('npm test', 'C:/project', true), /중지/);
});

test('preview cache is bounded and evicts the oldest before and after entries together', async () => {
  const { host, controller } = fixture();
  host.stopRequested = true;
  const proposals = [];
  for (let index = 0; index < 130; index++) {
    const change = { path: 'example.js', action: 'replace', original: 'old ' + index, content: 'new ' + index };
    await controller.stageAndApply({}, [change], 'Preview', false, true);
    proposals.push(change);
    assert.ok(host.previews.size <= 200);
  }
  assert.equal(host.previews.size, 200);
  for (const [index, change] of proposals.entries()) {
    assert.equal(host.previews.get(change.previewId + '-old'), index < 30 ? undefined : change.original);
    assert.equal(host.previews.get(change.previewId + '-new'), index < 30 ? undefined : change.content);
  }
});

test('prompts reflect the host-selected policy while read-only tasks stay read-only', () => {
  const common = { id: 'test', task: 'Update the code.', workspace: 'test', files: [], history: [] };
  assert.match(buildPrompt(common), /Commands need user approval/);
  assert.match(buildPrompt({ ...common, autoApprove: true }), /commands run without approval prompts/);
  assert.doesNotMatch(buildPrompt({ ...common, autoApprove: true }), /execution configs always need review/);
  assert.match(buildPrompt({ ...common, mode: 'ask', autoApprove: true }), /read\/search only/);
});
