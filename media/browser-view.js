'use strict';
const api = acquireVsCodeApi(),
  el = (id) => document.getElementById(id);
let token = '',
  locked = false,
  composing = false,
  frameTicket = 0,
  lastPointer = 0;
const browserCanvas = el('screen'),
  keyboard = el('keyboard'),
  browserViewport = el('viewport');
const send = (message) => api.postMessage(message);
function input(message) {
  if (!locked && token) send({ type: 'browserInput', token, ...message });
}
function position(event) {
  const rect = browserCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}
browserCanvas.addEventListener('pointerdown', (event) => {
  if (locked) return;
  event.preventDefault();
  browserCanvas.setPointerCapture(event.pointerId);
  keyboard.style.left = Math.max(0, Math.min(innerWidth - 2, event.clientX)) + 'px';
  keyboard.style.top = Math.max(0, Math.min(innerHeight - 2, event.clientY)) + 'px';
  keyboard.focus({ preventScroll: true });
  input({
    action: 'down',
    ...position(event),
    button: ['left', 'middle', 'right'][event.button],
    clickCount: event.detail,
  });
});
browserCanvas.addEventListener('pointerup', (event) =>
  input({
    action: 'up',
    ...position(event),
    button: ['left', 'middle', 'right'][event.button],
    clickCount: event.detail,
  }),
);
browserCanvas.addEventListener('pointermove', (event) => {
  if (event.buttons || performance.now() - lastPointer > 50) {
    lastPointer = performance.now();
    input({ action: 'move', ...position(event) });
  }
});
browserCanvas.addEventListener('contextmenu', (event) => event.preventDefault());
browserCanvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    input({ action: 'wheel', ...position(event), deltaX: event.deltaX, deltaY: event.deltaY });
  },
  { passive: false },
);
function flushText() {
  if (!composing && keyboard.value) {
    const text = keyboard.value;
    keyboard.value = '';
    input({ action: 'text', text });
  }
}
keyboard.addEventListener('compositionstart', () => {
  composing = true;
});
keyboard.addEventListener('compositionend', () => {
  composing = false;
  queueMicrotask(flushText);
});
keyboard.addEventListener('input', (event) => {
  if (!event.isComposing) flushText();
});
keyboard.addEventListener('paste', (event) => {
  event.preventDefault();
  input({ action: 'text', text: event.clipboardData.getData('text/plain') });
  keyboard.value = '';
});
keyboard.addEventListener('keydown', (event) => {
  if (composing || event.isComposing || event.keyCode === 229) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
  const special =
    /^(Enter|Tab|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/;
  if (special.test(event.key) || event.ctrlKey || event.metaKey || event.altKey) {
    event.preventDefault();
    input({
      action: 'key',
      key: event.key,
      modifiers: [
        ...(event.ctrlKey ? ['Control'] : []),
        ...(event.metaKey ? ['Meta'] : []),
        ...(event.altKey ? ['Alt'] : []),
        ...(event.shiftKey ? ['Shift'] : []),
      ],
    });
  }
});
for (const action of ['back', 'forward', 'reload'])
  el(action).addEventListener('click', () => send({ type: 'browserAction', token, action }));
el('pages').addEventListener('change', () => send({ type: 'selectBrowserPage', id: el('pages').value }));
for (const type of ['reconnect', 'external']) el(type).addEventListener('click', () => send({ type }));
function fitScreen() {
  const scale = Math.min(
    browserViewport.clientWidth / browserCanvas.width,
    browserViewport.clientHeight / browserCanvas.height,
  );
  browserCanvas.style.width = Math.floor(browserCanvas.width * scale) + 'px';
  browserCanvas.style.height = Math.floor(browserCanvas.height * scale) + 'px';
}
new ResizeObserver(() => {
  fitScreen();
  send({ type: 'resize', width: browserViewport.clientWidth, height: browserViewport.clientHeight });
}).observe(browserViewport);
window.addEventListener('message', async ({ data }) => {
  if (data.type === 'requestResize') {
    fitScreen();
    send({ type: 'resize', width: browserViewport.clientWidth, height: browserViewport.clientHeight });
  }
  if (data.type === 'browserFrame') {
    const img = new Image();
    const ticket = ++frameTicket;
    try {
      img.src = 'data:image/jpeg;base64,' + data.data;
      await img.decode();
      if (ticket !== frameTicket) return;
      browserCanvas.width = img.naturalWidth;
      browserCanvas.height = img.naturalHeight;
      browserCanvas.getContext('2d').drawImage(img, 0, 0);
      fitScreen();
      token = data.token;
      el('empty').hidden = true;
    } catch {
      el('notice').textContent = window.M365Localize('화면을 다시 불러오고 있습니다…');
    } finally {
      img.src = '';
      send({ type: 'frameAck', id: data.id, token: data.token });
    }
  }
  if (data.type === 'browserState') {
    locked = data.locked;
    el('address').textContent = data.url || window.M365Localize('브라우저 연결 대기');
    el('notice').textContent = locked
      ? window.M365Localize('에이전트가 작업 중입니다. 직접 조작하려면 M365 Agent에서 중지하세요.')
      : window.M365Localize('화면을 클릭해 로그인하거나 브라우저를 직접 조작하세요.');
    for (const id of ['back', 'forward', 'reload', 'pages']) el(id).disabled = locked || !data.connected;
    el('pages').replaceChildren(...(data.tabs || []).map((tab) => new Option(tab.title, tab.id)));
    el('pages').value = data.selected || '';
    if (!data.connected) {
      token = '';
      el('empty').hidden = false;
      el('empty').textContent = window.M365Localize(
        '브라우저 연결을 기다리고 있습니다. 다시 연결을 누르세요.',
      );
    }
  }
  if (data.type === 'browserNotice') el('notice').textContent = data.text;
});
send({ type: 'ready' });
