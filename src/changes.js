// @ts-check
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { decodeText, digest, digestBytes } = require('./workspace');
const { requiresReview } = require('./policy');
/** @typedef {import('../types/contracts').PreparedChange} PreparedChange */
/** @typedef {import('./workspace').WorkspaceStore} WorkspaceStore */
/** @param {string} target */
async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

class ChangeController {
  /** @param {import('../types/contracts').ChangeHost} host @param {typeof import('vscode')} vscode */
  constructor(host, vscode) {
    this.host = host;
    this.vscode = vscode;
  }
  /** @param {PreparedChange[]} changes */
  assertNoDirtyDeletions(changes) {
    for (const change of changes.filter((change) => change.action === 'delete')) {
      const target = path.resolve(change.target).toLowerCase();
      if (
        (this.vscode.workspace?.textDocuments || []).some((document) => {
          const filename =
            document.uri.scheme === 'file' ? path.resolve(document.uri.fsPath).toLowerCase() : '';
          return (
            document.isDirty &&
            (filename === target || (change.directory && filename.startsWith(target + path.sep)))
          );
        })
      )
        throw new Error(`저장하지 않은 변경이 있는 파일은 삭제·복원하지 않습니다: ${change.path}`);
    }
  }
  /** @param {WorkspaceStore} store @param {PreparedChange[]} changes */
  recordCheckpoint(store, changes) {
    const host = this.host;
    host.checkpoints.push({ store, changes });
    for (const change of changes) {
      change.taskId = host.taskId;
      host.changedFiles.set(store.root.toLowerCase() + '\0' + change.path.toLowerCase(), {
        root: store.root,
        path: change.path,
        action: change.action,
        id: change.previewId,
        taskId: host.taskId,
      });
    }
    host.checkpoints = host.checkpoints.slice(-20);
    host.post({ type: 'undoState', available: true });
  }
  /** @param {WorkspaceStore} store @param {PreparedChange[]} changes */
  async findPartialDeletes(store, changes) {
    /** @type {PreparedChange[]} */
    const missing = [];
    for (const change of changes.filter((change) => change.action === 'delete')) {
      try {
        await store.resolve(change.path, true);
        if (!(await exists(change.target))) missing.push(change);
        else if (change.directory) {
          const stat = await fs.stat(change.target);
          if (
            !stat.isDirectory() ||
            `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== change.directorySnapshot.identity
          ) {
            missing.push(change);
            continue;
          }
          const files = [],
            directories = [];
          for (const file of change.directorySnapshot.files) {
            const resolved = await store.resolve(file.path, true);
            if (!(await exists(resolved.target))) files.push(file);
          }
          for (const name of change.directorySnapshot.directories) {
            const resolved = await store.resolve(name, true);
            if (!(await exists(resolved.target))) directories.push(name);
          }
          if (files.length || directories.length)
            missing.push({
              ...change,
              partialDirectory: true,
              directorySnapshot: { ...change.directorySnapshot, files, directories },
            });
        }
      } catch (error) {
        this.host.output?.appendLine(`삭제 상태 확인 실패 · ${change.path}: ${error.message}`);
      }
    }
    return missing;
  }
  /** @param {WorkspaceStore} store @param {PreparedChange[]} changes */
  async findAppliedTextChanges(store, changes) {
    const applied = [];
    const normalizeEol = (/** @type {string} */ text) => text.replace(/\r\n/g, '\n');
    for (const change of changes.filter((item) => item.action !== 'delete')) {
      try {
        await store.resolve(change.path, true);
        if (!(await exists(change.target))) continue;
        const snapshot = await store.loadBytes(change.path);
        const diskText = normalizeEol(decodeText(snapshot.buffer));
        const planned = normalizeEol(change.content);
        const before = change.action === 'create' ? '' : normalizeEol(change.original);
        const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(change.target));
        const actual = document.getText();
        // WorkspaceEdit can leave a text edit in the editor while the disk still holds the original.
        if (change.action !== 'create' && actual === change.original) continue;
        if (normalizeEol(actual) !== planned || (diskText !== before && diskText !== planned)) continue;
        applied.push({
          ...change,
          appliedHash: digest(actual),
          diskHash: snapshot.hash,
          appliedDirty: document.isDirty,
        });
      } catch (error) {
        this.host.output?.appendLine('변경 상태 확인 실패 · ' + change.path + ': ' + error.message);
      }
    }
    return applied;
  }
  /** @param {string} command @param {string} root */
  async runCommand(command, root, autoApprove = false) {
    const host = this.host;
    if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\0\r\n]/.test(command))
      throw new Error('명령 형식이 올바르지 않습니다.');
    if (host.stopRequested) throw new Error('작업을 중지했습니다.');
    const approved =
      autoApprove === true ||
      (await new Promise((resolve) => {
        const changedFiles = [...host.changedFiles.values()]
          .filter((file) => path.resolve(file.root).toLowerCase() === path.resolve(root).toLowerCase())
          .map((file) => ({
            path: file.path,
            action: file.action,
            id: host.previews.has(file.id + '-new') ? file.id : null,
            sensitive: requiresReview(file.path),
            currentTask: file.taskId === host.taskId,
          }));
        const viewData = { type: 'commandApproval', command, root, changedFiles, token: crypto.randomUUID() };
        host.pending = { kind: 'command', resolve, viewData };
        host.post(viewData);
      }));
    if (autoApprove !== true) {
      host.pending = null;
      host.post({ type: 'approvalClosed' });
    }
    if (!approved || host.stopRequested)
      return { approved: false, message: '사용자가 실행을 거절했습니다. 다시 요청하지 마세요.' };
    if (autoApprove === true)
      host.post({
        type: 'message',
        role: 'system',
        text: `승인 없이 진행 · 명령 실행\n${command}\n작업 폴더: ${root}`,
      });
    host.output.appendLine(`\n> ${command}\n${root}`);
    host.output.show(true);
    host.runner.encoding = host.config().get('commandOutputEncoding', 'utf8');
    return host.runner.run(command, root, (text) => host.output.append(text));
  }
  /** @param {WorkspaceStore} store @param {PreparedChange[]} changes @param {string} summary @param {boolean} review */
  async stageAndApply(store, changes, summary, review, autoApprove = false) {
    const host = this.host;
    const vscode = this.vscode;
    this.assertNoDirtyDeletions(changes);
    const forcedReview =
      autoApprove === true
        ? []
        : changes
            .filter((change) => change.action === 'delete' || requiresReview(change.path))
            .map((change) => change.path);
    review = autoApprove !== true && (review || forcedReview.length > 0);
    for (const change of changes) {
      const id = crypto.randomUUID();
      change.previewId = id;
      host.previews.set(id + '-old', change.original);
      host.previews.set(id + '-new', change.content);
      while (host.previews.size > 200) {
        const oldest = host.previews.keys().next().value;
        if (oldest === undefined) break;
        const oldestId = oldest.slice(0, -4);
        host.previews.delete(oldestId + '-old');
        host.previews.delete(oldestId + '-new');
      }
    }
    const viewData = {
      type: 'changes',
      summary,
      files: changes.map((change) => ({
        path: change.path,
        action: change.action,
        id: change.previewId,
        binary: change.action === 'delete' && !change.directory ? change.binary : undefined,
        directory: change.directory === true,
        size:
          change.action === 'delete'
            ? change.directory
              ? change.directorySnapshot.size
              : change.originalBytes.length
            : undefined,
      })),
      review,
      autoApproved: autoApprove === true,
      forcedReview,
      token: crypto.randomUUID(),
    };
    if (review) {
      host.post({
        type: 'status',
        text: `파일 ${changes.length}개 변경 승인 대기 · diff를 확인하고 적용을 누르세요.`,
      });
      const approved = await new Promise((resolve) => {
        host.pending = { kind: 'changes', resolve, changes, viewData };
        host.post(viewData);
      });
      host.pending = null;
      host.post({ type: 'reviewClosed' });
      if (!approved || host.stopRequested || host.agent?.cancelled) return false;
    } else host.post(viewData);
    if (host.stopRequested || host.agent?.cancelled) return false;
    await store.verifyChanges(changes, () => !!(host.stopRequested || host.agent?.cancelled));
    const edit = new vscode.WorkspaceEdit();
    const documents = [];
    /** @type {string[]} */
    const directoryDeletes = [];
    let hasFileEdits = false;
    for (const change of changes) {
      const uri = vscode.Uri.file(change.target);
      if (change.action === 'delete') {
        if (change.directory) {
          // Delete only the observed entries, then empty directories. A new,
          // unobserved child makes the directory removal fail instead of being lost.
          for (const file of change.directorySnapshot.files)
            edit.deleteFile(vscode.Uri.file((await store.resolve(file.path)).target), {
              recursive: false,
              ignoreIfNotExists: false,
            });
          directoryDeletes.push(...change.directorySnapshot.directories);
          hasFileEdits ||= change.directorySnapshot.files.length > 0;
        } else edit.deleteFile(uri, { recursive: false, ignoreIfNotExists: false });
      } else if (change.action === 'create') {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(change.target)));
        edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), change.content);
      } else {
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty)
          throw new Error(
            `저장하지 않은 변경이 있는 파일입니다. 먼저 저장 후 다시 요청하세요: ${change.path}`,
          );
        if (digest(document.getText()) !== change.expectedHash)
          throw new Error(`파일이 변경되었습니다: ${change.path}`);
        edit.replace(
          uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          change.content,
        );
      }
      if (!change.directory) hasFileEdits = true;
      documents.push({ uri, change });
    }
    await store.verifyChanges(changes, () => !!(host.stopRequested || host.agent?.cancelled));
    if (host.stopRequested || host.agent?.cancelled) return false;
    this.assertNoDirtyDeletions(changes);
    let applied, applyError;
    try {
      applied = !hasFileEdits || (await vscode.workspace.applyEdit(edit, { isRefactoring: false }));
      // VS Code prevalidates all deletions in a single edit. A parent must be
      // removed in a later edit, after its observed children are actually gone.
      for (const depth of [...new Set(directoryDeletes.map((name) => name.split('/').length))].sort(
        (a, b) => b - a,
      )) {
        if (!applied) break;
        if (host.stopRequested || host.agent?.cancelled) throw new Error('작업을 중지했습니다.');
        this.assertNoDirtyDeletions(changes);
        const directoryEdit = new vscode.WorkspaceEdit();
        for (const name of directoryDeletes.filter((name) => name.split('/').length === depth))
          directoryEdit.deleteFile(vscode.Uri.file((await store.resolve(name)).target), {
            recursive: false,
            ignoreIfNotExists: false,
          });
        applied = await vscode.workspace.applyEdit(directoryEdit, { isRefactoring: false });
      }
    } catch (error) {
      applied = false;
      applyError = error;
    }
    if (!applied) {
      const partialDeletes = await this.findPartialDeletes(store, changes);
      const partial = [...partialDeletes, ...(await this.findAppliedTextChanges(store, changes))];
      if (partial.length) this.recordCheckpoint(store, partial);
      /** @type {Error & { code?: string }} */
      const error = new Error(
        `VS Code가 변경을 완료하지 못했습니다.${partial.length ? ' 부분 변경 ' + partial.length + '건의 복구 기록을 보관했습니다. 되돌리기로 복원할 수 있습니다.' : ' 편집기에서 파일 상태를 확인하세요.'}`,
        { cause: applyError },
      );
      if (partial.length) error.code = partialDeletes.length ? 'PARTIAL_DELETE' : 'PARTIAL_CHANGE';
      throw error;
    }
    this.recordCheckpoint(store, changes);
    const failed = [];
    for (const { uri, change } of documents) {
      if (change.action === 'delete') {
        change.appliedHash = null;
        change.diskHash = null;
        if (await exists(change.target))
          throw new Error(`삭제를 확인하지 못했습니다. 현재 파일 상태를 확인하세요: ${change.path}`);
        continue;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (!(await document.save())) failed.push(path.basename(uri.fsPath));
      change.appliedHash = digest(document.getText());
      change.diskHash = await fs
        .readFile(uri.fsPath)
        .then(digestBytes)
        .catch(() => null);
    }
    if (failed.length)
      throw new Error(
        `편집기에 적용했지만 저장하지 못한 파일이 있습니다: ${failed.join(', ')}. 직접 확인하세요.`,
      );
    const deleted = changes.filter((change) => change.action === 'delete').length;
    host.post({
      type: 'message',
      role: 'system',
      text: `${autoApprove === true ? '승인 없이 진행 · ' : ''}${changes.length}개 파일 변경을 적용했습니다.${deleted ? ' 삭제 ' + deleted + '개.' : ' 저장 완료.'} 테스트는 실행하지 않았습니다.`,
    });
    host.post({ type: 'applied' });
    return true;
  }
  async undo() {
    const host = this.host;
    const vscode = this.vscode;
    if (host.starting || host.agent?.running) throw new Error('작업 완료 후 되돌릴 수 있습니다.');
    const checkpoint = host.checkpoints.at(-1);
    if (!checkpoint) return;
    const edit = new vscode.WorkspaceEdit();
    const saves = [];
    const restores = [];
    const restoreDirectories = [];
    let editNeeded = false;
    this.assertNoDirtyDeletions(checkpoint.changes);
    for (const change of checkpoint.changes) {
      await checkpoint.store.resolve(change.path, change.action === 'delete');
      const uri = vscode.Uri.file(change.target);
      if (change.action === 'delete') {
        if ((!change.directory || !change.partialDirectory) && (await exists(change.target)))
          throw new Error(`삭제 후 같은 경로가 다시 생겨 덮어쓰지 않습니다: ${change.path}`);
        if (change.directory) {
          if (change.partialDirectory) {
            const stat = await fs.stat(change.target);
            if (
              !stat.isDirectory() ||
              `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== change.directorySnapshot.identity
            )
              throw new Error(`부분 삭제 후 폴더가 바뀌어 복원하지 않습니다: ${change.path}`);
          }
          for (const name of change.directorySnapshot.directories) {
            const resolved = await checkpoint.store.resolve(name, true);
            if (await exists(resolved.target))
              throw new Error(`삭제 후 같은 경로가 다시 생겨 덮어쓰지 않습니다: ${name}`);
            restoreDirectories.push({ path: name, target: resolved.target });
          }
          for (const file of change.directorySnapshot.files) {
            const resolved = await checkpoint.store.resolve(file.path, true);
            if (await exists(resolved.target))
              throw new Error(`삭제 후 같은 경로가 다시 생겨 덮어쓰지 않습니다: ${file.path}`);
            edit.createFile(vscode.Uri.file(resolved.target), {
              overwrite: false,
              ignoreIfExists: false,
              contents: file.bytes,
            });
            restores.push({ path: file.path, target: resolved.target });
            editNeeded = true;
          }
        } else {
          edit.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: change.originalBytes });
          restores.push(change);
          editNeeded = true;
        }
        continue;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (
        (document.isDirty && !change.appliedDirty) ||
        digest(document.getText()) !== change.appliedHash ||
        digestBytes(await fs.readFile(change.target)) !== change.diskHash
      )
        throw new Error(`이후 편집이 있어 되돌릴 수 없습니다: ${change.path}`);
      if (change.action === 'create') edit.deleteFile(uri, { recursive: false });
      else {
        edit.replace(
          uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          change.original,
        );
        saves.push(uri);
      }
      editNeeded = true;
    }
    for (const directory of restoreDirectories.sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length,
    )) {
      await checkpoint.store.resolve(directory.path, true);
      if (await exists(directory.target))
        throw new Error(`삭제 후 같은 경로가 다시 생겨 덮어쓰지 않습니다: ${directory.path}`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory.target));
      await checkpoint.store.resolve(directory.path);
    }
    for (const change of restores) {
      await checkpoint.store.resolve(change.path, true);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(change.target)));
      await checkpoint.store.resolve(change.path, true);
      if (await exists(change.target))
        throw new Error(`삭제 후 같은 경로가 다시 생겨 덮어쓰지 않습니다: ${change.path}`);
    }
    this.assertNoDirtyDeletions(checkpoint.changes);
    if (editNeeded && !(await vscode.workspace.applyEdit(edit)))
      throw new Error('되돌리기를 적용하지 못했습니다.');
    host.checkpoints.pop();
    for (const change of checkpoint.changes) {
      const key = checkpoint.store.root.toLowerCase() + '\0' + change.path.toLowerCase();
      const previous = [...host.checkpoints]
        .reverse()
        .filter((item) => item.store.root === checkpoint.store.root)
        .flatMap((item) => item.changes)
        .find((item) => item.path === change.path);
      if (previous)
        host.changedFiles.set(key, {
          root: checkpoint.store.root,
          path: previous.path,
          action: previous.action,
          id: previous.previewId,
          taskId: previous.taskId,
        });
      else host.changedFiles.delete(key);
    }
    for (const uri of saves)
      if (!(await (await vscode.workspace.openTextDocument(uri)).save()))
        throw new Error('되돌린 내용을 저장하지 못했습니다. 편집기를 확인하세요.');
    host.post({
      type: 'message',
      role: 'system',
      text: '마지막 파일 변경을 되돌렸습니다. 터미널에서 발생한 변경은 포함하지 않습니다.',
    });
    host.post({ type: 'undoState', available: host.checkpoints.length > 0 });
  }
}
module.exports = { ChangeController };
