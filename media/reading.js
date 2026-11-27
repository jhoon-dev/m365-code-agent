'use strict';
// Shared by the conversation and the wider, read-only response view.
window.M365Reading = (api) => {
  const copies = new Map();
  window.addEventListener('message', ({ data }) => {
    if (data?.type !== 'copyResult' || !copies.has(data.id)) return;
    const { button, label, timeout } = copies.get(data.id);
    copies.delete(data.id);
    clearTimeout(timeout);
    button.textContent = data.success ? window.M365Localize('복사됨') : window.M365Localize('복사 실패');
    button.disabled = false;
    setTimeout(() => {
      button.textContent = label;
    }, 1800);
  });
  function copy(text, button, type = 'copyCode') {
    const id = crypto.randomUUID(),
      label = button.textContent;
    button.disabled = true;
    const timeout = setTimeout(() => {
      copies.delete(id);
      button.disabled = false;
      button.textContent = label;
    }, 5000);
    copies.set(id, { button, label, timeout });
    api.postMessage({ type, id, text });
  }
  function wrapButton(block) {
    const wrapped = block.dataset.wrap
      ? block.dataset.wrap === 'on'
      : document.body.classList.contains('wrap-code');
    block.querySelector('.wrap-button').setAttribute('aria-pressed', String(wrapped));
  }
  function setWrap(enabled) {
    document.body.classList.toggle('wrap-code', enabled);
    for (const block of document.querySelectorAll('.code-block')) {
      delete block.dataset.wrap;
      wrapButton(block);
    }
  }
  function enhance(body) {
    for (const code of body.querySelectorAll('pre > code')) {
      const pre = code.parentElement,
        block = document.createElement('div');
      block.className = 'code-block';
      const toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';
      const language = document.createElement('span');
      language.textContent = code.className.replace('language-', '') || window.M365Localize('코드');
      const actions = document.createElement('div');
      actions.className = 'code-actions';
      const wrap = document.createElement('button');
      wrap.type = 'button';
      wrap.className = 'wrap-button';
      wrap.textContent = window.M365Localize('줄바꿈');
      wrap.title = window.M365Localize('이 코드의 줄바꿈 전환');
      wrap.addEventListener('click', () => {
        block.dataset.wrap = wrap.getAttribute('aria-pressed') === 'true' ? 'off' : 'on';
        wrapButton(block);
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-button';
      button.textContent = window.M365Localize('복사');
      button.setAttribute('aria-label', window.M365Localize('코드 복사'));
      button.addEventListener('click', () => copy(code.textContent, button));
      actions.append(wrap, button);
      toolbar.append(language, actions);
      pre.before(block);
      block.append(toolbar, pre);
      wrapButton(block);
    }
    for (const link of body.querySelectorAll('a'))
      link.addEventListener('click', (event) => {
        event.preventDefault();
        api.postMessage({ type: 'openLink', url: link.href });
      });
  }
  return { copy, enhance, setWrap };
};
