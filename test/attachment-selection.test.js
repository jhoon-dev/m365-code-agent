'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { prepareAttachments } = require('../src/attachments');

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const workspace = await fs.mkdtemp(path.join(temporaryRoot, 'm365-attachment-selection-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(workspace)), temporaryRoot);
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const extensionRoot = path.resolve(__dirname, '..');
  const source = path.join(extensionRoot, 'src', 'extension.js');
  const localRequire = createRequire(source);
  const noop = () => {};
  const posted = [];
  const vscode = {
    window: {
      createTreeView: () => ({ visible: false, onDidChangeVisibility: noop, dispose: noop }),
      createOutputChannel: () => ({ appendLine: noop, dispose: noop }),
      registerWebviewViewProvider: noop,
      showQuickPick: async items => items,
    },
    workspace: { registerTextDocumentContentProvider: noop },
    commands: { registerCommand: noop },
    languages: { registerCodeActionsProvider: noop },
    CodeActionKind: { QuickFix: { append: value => `quickfix.${value}` } },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  };
  const sandbox = { require: name => name === 'vscode' ? vscode : localRequire(name), module: { exports: {} }, process };
  vm.runInNewContext(await fs.readFile(source, 'utf8'), sandbox, { filename: source });
  const { provider } = sandbox.module.exports.activate({
    workspaceState: { get: (_key, fallback) => fallback, update: noop },
    subscriptions: [], extensionUri: { fsPath: extensionRoot },
  });
  t.after(() => clearInterval(provider.syncTimer));
  provider.rootFolder = async () => ({ uri: { fsPath: workspace }, name: 'fixture' });
  provider.sessionId = 'current';
  provider.view = { webview: { postMessage: message => posted.push(message) } };
  return { provider, workspace, vscode, posted };
}

test('workspace picker deduplicates an already selected absolute file before applying five-file limit', async t => {
  const { provider, workspace, posted } = await fixture(t);
  const names = Array.from({ length: 5 }, (_, index) => `report-${index}.pdf`);
  await Promise.all(names.map(name => fs.writeFile(path.join(workspace, name), name)));
  provider.attachments = [path.join(workspace, names[0])];
  await provider.attachFiles();
  assert.equal(provider.attachments.length, 5);
  const absolute = Array.from(provider.attachments, file => path.resolve(workspace, file));
  assert.equal(new Set(absolute).size, 5);
  assert.deepEqual(new Set(absolute), new Set(names.map(name => path.join(workspace, name))));
  assert.equal(posted.at(-1).type, 'attachments');
  assert.equal(posted.at(-1).files.length, 5);
  const prepared = await prepareAttachments(absolute);
  assert.equal(prepared.uploads.length, 5);
  assert.deepEqual(new Set(prepared.uploads.map(upload => upload.name)), new Set(names));
});

test('workspace picker preserves a genuinely excessive selection and refuses stale session results', async t => {
  const { provider, workspace, vscode, posted } = await fixture(t);
  await Promise.all(Array.from({ length: 6 }, (_, index) => fs.writeFile(path.join(workspace, `report-${index}.pdf`), 'data')));
  const original = path.join(workspace, 'report-0.pdf');
  provider.attachments = [original];
  vscode.window.showQuickPick = async items => items.filter(item => item.label !== 'report-0.pdf');
  await assert.rejects(provider.attachFiles(), /최대 5개/);
  assert.deepEqual(Array.from(provider.attachments), [original]);
  assert.equal(posted.length, 0);
  vscode.window.showQuickPick = async items => { provider.sessionId = 'different'; return items.slice(0, 1); };
  await provider.attachFiles();
  assert.deepEqual(Array.from(provider.attachments), [original]);
  assert.equal(posted.length, 0);
});
