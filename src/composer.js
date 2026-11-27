'use strict';
const { t } = require('./localization');
/* global getComputedStyle */

const normalizeDraft = (text) =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n+$/, '');
const matchesPrompt = (snapshot, prompt) =>
  [snapshot.text, snapshot.visibleText].some((text) => normalizeDraft(text) === normalizeDraft(prompt));
function isAgentProtocolDraft(text) {
  const normalized = normalizeDraft(text);
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (
    normalized.startsWith(
      'You are a coding agent used from VS Code. Respond in Korean, using exactly one JSON object inside a fenced m365-agent block.',
    ) &&
    new RegExp('Current requestId: ' + uuid, 'i').test(normalized) &&
    normalized.includes('Recent local tool results and conversation:')
  )
    return true;
  if (!new RegExp('^VS Code coding agent\\. Current requestId: ' + uuid + ' \\.', 'i').test(normalized))
    return false;
  try {
    const data = JSON.parse(normalized.slice(normalized.indexOf(' DATA: ') + 7));
    return (
      typeof data.task === 'string' &&
      typeof data.workspace === 'string' &&
      ['agent', 'ask', 'plan'].includes(data.mode) &&
      Array.isArray(data.history)
    );
  } catch {
    return false;
  }
}

// This function runs inside the page. Reconstruct editor text without CSS layout
// (innerText can add paragraph gaps or collapse meaningful repeated spaces).
async function readComposer(locator) {
  return locator.evaluate((element) => {
    const native = element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';
    function read(node) {
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      if (
        node !== element &&
        (node.getAttribute('aria-hidden') === 'true' || getComputedStyle(node).display === 'none')
      )
        return '';
      if (node.tagName === 'BR') return '\n';
      let text = '';
      const children = [...node.childNodes];
      children.forEach((child, index) => {
        const block = child.nodeType === 1 && /^(P|DIV|LI|PRE)$/.test(child.tagName);
        if (block && text && !text.endsWith('\n')) text += '\n';
        const value = read(child);
        text += value;
        if (block && index < children.length - 1 && !value.endsWith('\n')) text += '\n';
      });
      return text;
    }
    const text = native ? element.value : read(element);
    const rawLimit = element.getAttribute('maxlength');
    const maxLength = rawLimit !== null && /^\d+$/.test(rawLimit) ? Number(rawLimit) : null;
    return {
      text,
      visibleText: native ? element.value : element.innerText || '',
      maxLength,
      tag: element.tagName,
      richText: !native,
    };
  });
}

function promptLimitError(limit, expected) {
  const error = new Error(
    t(
      'Copilot 입력 한도에 맞춰 요청을 줄여야 합니다. 요청 {0}자 / 확인된 한도 {1}자. 아직 전송하지 않았습니다.',
      expected.toLocaleString(),
      limit.toLocaleString(),
    ),
  );
  error.code = 'PROMPT_LIMIT';
  error.maxCharacters = limit;
  error.notSubmitted = true;
  return error;
}
module.exports = { normalizeDraft, matchesPrompt, readComposer, promptLimitError, isAgentProtocolDraft };
