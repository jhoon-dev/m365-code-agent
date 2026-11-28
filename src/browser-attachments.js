'use strict';
const { t } = require('./localization');
/* global getComputedStyle */
const { createHash } = require('node:crypto');

// This function runs in the composer frame. Only composer-local attachment
// cards count; previously submitted files in the conversation are excluded.
function attachmentSnapshot(element, selectors) {
  const visible = (node) => {
    const style = getComputedStyle(node);
    return (
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      [...node.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)
    );
  };
  let scope = selectors.scope
    ? element.closest(selectors.scope) || element.ownerDocument.querySelector(selectors.scope)
    : element.parentElement.closest(
        'form, .fai-BebopLiteChatInput, [data-testid="chat-composer"], [data-testid="composer"], [data-testid="chat-input-container"]',
      );
  if (!scope) {
    scope = element.parentElement;
    for (let depth = 0; depth < 4 && scope.parentElement; depth++) {
      if (scope.querySelector('input[type="file"], button, [role="button"]')) break;
      scope = scope.parentElement;
    }
  }
  const documentRoot = element.ownerDocument.documentElement;
  documentRoot.__m365AttachmentDocumentId ||= Date.now().toString(36) + Math.random().toString(36).slice(2);
  const cards = [...scope.querySelectorAll(selectors.ready)].filter(
    (node) =>
      !element.contains(node) &&
      node !== element &&
      visible(node) &&
      !node.closest('[data-message-author-role], [role="log"], [role="article"]'),
  );
  const labels = cards.map((node) =>
    [
      node.getAttribute('aria-label'),
      node.getAttribute('title'),
      node.getAttribute('data-attachment-name'),
      node.textContent,
    ]
      .filter(Boolean)
      .join(' '),
  );
  const failure =
    /\b(error|failed|failure|unable|unsupported|rejected|denied|blocked|cannot|exceeded)\b|too (?:large|big)|not supported|not allowed|went wrong|could not|can't|couldn't|오류|실패|업로드할 수 없|첨부할 수 없|문제가 (?:발생|있)|지원되지|지원하지|허용되지|차단|크기.{0,20}초과|제한.{0,15}초과|너무 (?:크|큰)|권한.{0,20}없/i;
  const explicitError =
    '[data-testid*="upload-error"], [data-testid*="attachment-error"], [data-status="error"], [data-state="error"], [data-status="failed"]';
  const errors = [...scope.querySelectorAll(selectors.error)]
    .filter(
      (node) =>
        visible(node) &&
        (selectors.customError ||
          node.closest(explicitError) ||
          failure.test(node.textContent || node.getAttribute('aria-label') || '')),
    )
    .map((node) => (node.textContent || node.getAttribute('aria-label') || '').trim())
    .filter(Boolean);
  for (const card of cards) {
    for (const status of card.querySelectorAll(
      '[role="status"], [data-status="error"], [data-state="error"], [data-status="failed"]',
    )) {
      const text = (status.textContent || '').trim();
      if (visible(status) && failure.test(text)) errors.push(text);
    }
  }
  const busy = [
    ...scope.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-uploading="true"]'),
  ].some(visible);
  const inputFiles = [...scope.querySelectorAll('input[type="file"]')].reduce(
    (count, input) => count + (input.files?.length || 0),
    0,
  );
  return { labels, errors, busy, inputFiles, documentId: documentRoot.__m365AttachmentDocumentId };
}

const defaults = {
  ready:
    '.fx-Attachment, [data-testid*="attachment-card"], [data-testid*="attachment-chip"], [data-testid*="file-chip"], [data-testid*="attached-file"], [data-testid*="file-preview"], [data-testid*="attachment-preview"], [class*="attachment-pill"], [class*="attachmentCard"], [class*="AttachmentCard"], [data-attachment-name]',
  error:
    '[role="alert"], [data-testid*="upload-error"], [data-testid*="attachment-error"], [data-status="error"], [data-state="error"], [data-status="failed"]',
};

function signature(files) {
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(file.name).update('\0').update(file.mimeType).update('\0').update(file.buffer);
  return hash.digest('hex');
}

async function snapshot(browser, locator) {
  return locator.evaluate(attachmentSnapshot, {
    ready: browser.options.attachmentReadySelector || defaults.ready,
    error: browser.options.attachmentErrorSelector || defaults.error,
    customError: Boolean(browser.options.attachmentErrorSelector),
    scope: browser.options.attachmentScopeSelector,
  });
}

function acceptsFile(accept, file) {
  const types = (accept || '')
    .split(',')
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean);
  if (!types.length || types.includes('*/*')) return true;
  const name = file.name.toLowerCase(),
    mimeType = file.mimeType.toLowerCase();
  return types.some((type) =>
    type.startsWith('.')
      ? name.endsWith(type)
      : type.endsWith('/*')
        ? mimeType.startsWith(type.slice(0, -1))
        : type === mimeType || type === '*/*',
  );
}

async function uploadTarget(element, files, chooser) {
  const accept = await element.getAttribute('accept');
  if (!acceptsFile(accept, files[0])) return null;
  const multiple = chooser ? chooser.isMultiple() : (await element.getAttribute('multiple')) !== null;
  return {
    ...(chooser ? { chooser } : { input: element }),
    files: multiple ? files.filter((file) => acceptsFile(accept, file)) : [files[0]],
  };
}

async function findInput(browser, frame, files) {
  let best = null;
  for (const input of await frame
    .locator(browser.options.attachmentInputSelector || 'input[type="file"]')
    .all()) {
    if (await input.isDisabled()) continue;
    const target = await uploadTarget(input, files);
    if (target && (!best || target.files.length > best.files.length)) best = target;
    if (best?.files.length === files.length) return best;
  }
  return best;
}

async function openUpload(browser, frame, files) {
  const direct = await findInput(browser, frame, files);
  if (direct) return direct;
  const names =
    /^(attach(?: files?| images?)?|add (?:content|files?|images?|photos?|attachments?)|upload(?: files?| images?| photos?)?|파일 첨부|이미지 첨부|첨부|파일 추가|이미지 추가|사진 추가|콘텐츠 추가|업로드|파일 업로드|이미지 업로드|로컬 파일 업로드|Upload from this device|Upload from computer|이 장치에서 업로드|내 컴퓨터에서 업로드)(?:\s.*)?$/i;
  let opened = false;
  const clickedLabels = new Set();
  for (let step = 0; step < 3; step++) {
    const groups =
      step === 0 && browser.options.attachmentButtonSelector
        ? [frame.locator(browser.options.attachmentButtonSelector)]
        : [frame.getByRole('button', { name: names }), frame.getByRole('menuitem', { name: names })];
    let clicked = false;
    for (const group of groups) {
      for (const button of await group.all()) {
        if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
        const label = await button.evaluate(
          (node) => node.getAttribute('aria-label') || node.textContent || '',
        );
        if (clickedLabels.has(label)) continue;
        clickedLabels.add(label);
        // Start the listener before clicking: native choosers can fire synchronously.
        const chooser = browser.page.waitForEvent('filechooser', { timeout: 1200 }).catch(() => null);
        await button.click({ timeout: 2000 });
        const selected = await chooser;
        if (selected) {
          const target = await uploadTarget(selected.element(), files, selected);
          if (!target)
            throw new Error(
              t(
                'Copilot 파일 선택창이 {0} 형식을 지원하지 않습니다. 파일에 맞는 첨부 입력창 선택자를 설정하세요. 요청은 전송하지 않았습니다.',
                files[0].name,
              ),
            );
          return target;
        }
        const input = await findInput(browser, frame, files);
        if (input) return input;
        clicked = true;
        opened = true;
        break;
      }
      if (clicked) break;
    }
    if (!clicked) break;
  }
  if (opened) await browser.page.keyboard.press('Escape');
  throw new Error(
    t(
      '요청한 파일 형식을 지원하는 Copilot의 로컬 파일 첨부 입력창을 찾지 못했습니다. 이 계정의 파일 첨부 지원 여부와 첨부 선택자 설정을 확인하세요. 요청은 전송하지 않았습니다.',
    ),
  );
}

async function waitReady(browser, locator, names, onStatus) {
  const deadline = Date.now() + (browser.options.attachmentTimeoutMs ?? 120000);
  while (Date.now() < deadline) {
    if (browser.cancelled) throw new Error(t('작업을 중지했습니다.'));
    const state = await snapshot(browser, locator);
    if (state.errors.length)
      throw new Error(
        t('Copilot 파일 첨부 실패: {0}. 요청은 전송하지 않았습니다.', state.errors.join(' ').slice(0, 500)),
      );
    if (!state.busy && names.every((name) => state.labels.some((label) => label.includes(name)))) return;
    onStatus(t('파일 업로드 확인 중 · {0}개', names.length));
    await browser.page.waitForTimeout(200);
  }
  throw new Error(
    t(
      'Copilot 화면에서 모든 파일의 업로드 완료를 확인하지 못했습니다. 파일 형식·크기·업로드 권한과 첨부 완료 선택자를 확인하세요. 요청은 전송하지 않았습니다.',
    ),
  );
}

async function prepareAttachments(browser, locator, frame, id, files = [], onStatus = () => {}) {
  if (
    !Array.isArray(files) ||
    files.some(
      (file) =>
        !file ||
        typeof file.name !== 'string' ||
        !file.name ||
        /[\\/\0]/.test(file.name) ||
        typeof file.mimeType !== 'string' ||
        !Buffer.isBuffer(file.buffer) ||
        !file.buffer.length,
    )
  )
    throw new Error(t('첨부 파일의 이름·형식·본문이 올바르지 않습니다.'));
  if (new Set(files.map((file) => file.name)).size !== files.length)
    throw new Error(t('첨부 파일 이름이 중복됩니다. 서로 다른 이름을 사용하세요.'));
  let state = await snapshot(browser, locator);
  const settleDeadline = Date.now() + Math.min(browser.options.attachmentTimeoutMs ?? 120000, 5000);
  while (state.busy && !state.labels.length && !state.errors.length && Date.now() < settleDeadline) {
    if (browser.cancelled) throw new Error(t('작업을 중지했습니다.'));
    onStatus(t('Copilot 첨부 입력창 준비를 기다리고 있습니다…'));
    await browser.page.waitForTimeout(150);
    state = await snapshot(browser, locator);
  }
  let pending = browser.pendingAttachments;
  // A new document cannot still execute the previous document's upload handlers.
  // Merely disappearing cards in the same document are deliberately insufficient.
  if (
    pending &&
    pending.documentId !== state.documentId &&
    !state.labels.length &&
    !state.busy &&
    !state.errors.length &&
    !state.inputFiles
  ) {
    browser.pendingAttachments = null;
    pending = null;
  }
  if (pending) {
    if (pending.id !== id || pending.signature !== signature(files) || pending.url !== browser.page.url())
      throw new Error(
        t(
          '이전 요청의 미전송 첨부가 남아 있습니다. 전용 Copilot 창에서 첨부를 정리한 뒤 페이지를 새로고침하세요.',
        ),
      );
    if (!pending.uploaded)
      throw new Error(
        t(
          '이전 파일 업로드의 완료 여부가 불확실합니다. 중복 업로드하지 않았습니다. 전용 Copilot 창에서 첨부를 정리한 뒤 페이지를 새로고침하세요.',
        ),
      );
    await waitReady(
      browser,
      locator,
      files.map((file) => file.name),
      onStatus,
    );
    return;
  }
  if (state.labels.length || state.busy)
    throw new Error(
      t(
        'Copilot 입력창에 기존 첨부 파일이 있습니다. 덮어쓰거나 함께 전송하지 않았습니다. 전용 창에서 첨부를 먼저 정리하세요.',
      ),
    );
  if (!files.length) return;
  if (state.errors.length)
    throw new Error(t('Copilot 첨부 오류를 먼저 정리하세요: {0}', state.errors.join(' ').slice(0, 500)));
  onStatus(t('Copilot에 파일 {0}개를 업로드하고 있습니다…', files.length));
  const target = await openUpload(browser, frame, files);
  if (browser.cancelled) throw new Error(t('작업을 중지했습니다.'));
  browser.pendingAttachments = {
    id,
    signature: signature(files),
    url: browser.page.url(),
    uploaded: false,
    names: files.map((file) => file.name),
    documentId: state.documentId,
  };
  let remaining = files;
  const names = [];
  while (remaining.length) {
    if (browser.cancelled) throw new Error(t('작업을 중지했습니다.'));
    const upload = names.length === 0 ? target : await openUpload(browser, frame, remaining);
    if (upload.input) await upload.input.setInputFiles(upload.files, { timeout: 15000 });
    else await upload.chooser.setFiles(upload.files, { timeout: 15000 });
    names.push(...upload.files.map((file) => file.name));
    await waitReady(browser, locator, names, onStatus);
    remaining = remaining.filter((file) => !upload.files.includes(file));
  }
  browser.pendingAttachments.uploaded = true;
}

async function verifyAttachments(browser, locator, id) {
  const pending = browser.pendingAttachments;
  if (!pending) return;
  if (pending.id !== id || !pending.uploaded)
    throw new Error(t('첨부 업로드 완료 상태가 현재 요청과 일치하지 않습니다. 요청은 전송하지 않았습니다.'));
  const state = await snapshot(browser, locator);
  if (
    state.busy ||
    state.errors.length ||
    !pending.names.every((name) => state.labels.some((label) => label.includes(name)))
  )
    throw new Error(
      t('전송 직전 첨부 파일이 변경되었거나 업로드 오류가 발생했습니다. 요청은 전송하지 않았습니다.'),
    );
}

module.exports = { prepareAttachments, verifyAttachments, attachmentSnapshot };
