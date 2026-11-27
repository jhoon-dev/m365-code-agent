'use strict';
const { t } = require('./localization');
const path = require('node:path');
const { createHash } = require('node:crypto');

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function fileIdentity(file) {
  return {
    path: file.path,
    action: file.action,
    baseHash: file.baseHash,
    content: file.action === 'delete' ? undefined : file.content,
    edits:
      file.action === 'delete'
        ? undefined
        : file.edits?.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
  };
}
function replyIdentity(value) {
  if (value.kind === 'tools')
    return stableJson({ requestId: value.requestId, kind: value.kind, calls: value.calls });
  if (value.kind === 'changes')
    return stableJson({ requestId: value.requestId, kind: value.kind, files: value.files.map(fileIdentity) });
  return stableJson({
    requestId: value.requestId,
    kind: value.kind,
    message: value.message,
    outcome: value.outcome || 'completed',
  });
}
function conflict(values, filename) {
  const error = new Error(t('같은 파일에 서로 다른 JSON 수정안이 있어 적용하지 않았습니다: ') + filename);
  error.code = 'AMBIGUOUS_REPLY';
  error.signature = createHash('sha256')
    .update([...new Set(values.map(replyIdentity))].sort().join('\0'))
    .digest('hex');
  return error;
}
const textParts = (values) => [
  ...new Set(values.filter((value) => typeof value === 'string' && value.trim())),
];

function mergeReplies(values, requestId) {
  values = values.filter((value) => value?.requestId === requestId);
  if (!values.length) return null;
  const unique = [...new Map(values.map((value) => [replyIdentity(value), value])).values()];
  const tools = unique.filter((value) => value.kind === 'tools');
  const changes = unique.filter((value) => value.kind === 'changes');
  const done = unique.filter((value) => value.kind === 'done');
  // Tools must complete before proposals based on their future results are trusted.
  // Ask for fresh proposals with the actual hashes; never replay premature changes.
  if (tools.length) {
    const calls = [
      ...new Map(tools.flatMap((value) => value.calls).map((call) => [stableJson(call), call])).values(),
    ];
    if (calls.length > 8) {
      const error = new Error(t('합친 도구 요청이 8개를 초과했습니다. 더 작은 묶음으로 요청해야 합니다.'));
      error.code = 'INVALID_REPLY_SCHEMA';
      throw error;
    }
    const deferred = [
      ...new Set([
        ...values
          .flatMap((value) => value.deferred || [])
          .filter((kind) => ['changes', 'done'].includes(kind)),
        ...(changes.length ? ['changes'] : []),
        ...(done.length ? ['done'] : []),
      ]),
    ];
    return { requestId, kind: 'tools', calls, ...(deferred.length ? { deferred } : {}) };
  }
  if (changes.length) {
    const files = new Map();
    for (const file of changes.flatMap((value) => value.files)) {
      const key =
        typeof file.path === 'string'
          ? path.posix.normalize(file.path.replace(/\\/g, '/')).toLowerCase()
          : '';
      const previous = files.get(key);
      if (!previous) {
        files.set(key, { ...file, ...(file.edits ? { edits: [...file.edits] } : {}) });
        continue;
      }
      if (
        stableJson({ ...fileIdentity(previous), path: key }) ===
        stableJson({ ...fileIdentity(file), path: key })
      )
        continue;
      if (
        previous.action !== 'edit' ||
        file.action !== 'edit' ||
        previous.baseHash !== file.baseHash ||
        !Array.isArray(previous.edits) ||
        !Array.isArray(file.edits)
      )
        throw conflict(values, key);
      for (const edit of file.edits) {
        const existing = previous.edits.find((value) => value.oldText === edit.oldText);
        if (existing && existing.newText !== edit.newText) throw conflict(values, key);
        if (!existing) previous.edits.push(edit);
      }
      // WorkspaceStore still checks read evidence, unique anchors, overlap and limits.
    }
    const summaries = textParts([
      ...values.filter((value) => value.kind === 'changes').map((value) => value.summary),
      ...done.map((value) => value.message),
    ]);
    return {
      requestId,
      kind: 'changes',
      ...(summaries.length ? { summary: summaries.join('\n\n') } : {}),
      files: [...files.values()],
    };
  }
  if (done.length === 1) return done[0];
  const outcomes = new Set(done.map((value) => value.outcome || 'completed'));
  return {
    requestId,
    kind: 'done',
    message: textParts(done.map((value) => value.message)).join('\n\n'),
    ...(outcomes.has('blocked')
      ? { outcome: 'blocked' }
      : outcomes.size === 1 && outcomes.has('no_changes')
        ? { outcome: 'no_changes' }
        : {}),
  };
}
module.exports = { replyIdentity, mergeReplies };
