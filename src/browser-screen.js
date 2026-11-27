'use strict';
const { t } = require('./localization');
const { randomUUID } = require('node:crypto');
const { validateCopilotUrl } = require('./browser');

function displayUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.origin + url.pathname
      : t('연결 준비 중');
  } catch {
    return t('연결 준비 중');
  }
}

// One owned Playwright page -> one local webview. No HTTP server, saved frames,
// cookie extraction, iframe embedding or security-header changes are involved.
class BrowserScreen {
  constructor(getBrowser, emit) {
    this.getBrowser = getBrowser;
    this.emit = emit;
    this.ids = new WeakMap();
    this.queue = Promise.resolve();
    this.sequence = 0;
    this.token = randomUUID();
  }
  id(page) {
    if (!this.ids.has(page)) this.ids.set(page, randomUUID());
    return this.ids.get(page);
  }
  async update() {
    if (this.updating || this.disposed) return;
    this.updating = true;
    try {
      const browser = this.getBrowser(),
        context = browser?.context;
      if (context !== this.context) {
        this.context?.off?.('page', this.onPage);
        this.context = context;
        this.manualPage = null;
        this.onPage = (page) => {
          this.manualPage = page;
        };
        this.context?.on?.('page', this.onPage);
      }
      if (browser?.page !== this.automationPage) {
        this.automationPage = browser?.page;
        this.manualPage = null;
      }
      const pages = context?.pages?.().filter((page) => !page.isClosed()) || [];
      const page =
        this.manualPage && pages.includes(this.manualPage)
          ? this.manualPage
          : pages.includes(browser?.page)
            ? browser.page
            : pages.at(-1);
      if (page !== this.page) await this.attach(page);
      if (this.resize && !browser?.automationActive && page) {
        const size = this.resize;
        this.resize = null;
        if (JSON.stringify(page.viewportSize()) !== JSON.stringify(size)) {
          this.token = randomUUID();
          await page.setViewportSize(size);
        }
      }
      const tabs = await Promise.all(
        pages.slice(-12).map(async (item) => ({
          id: this.id(item),
          title: (await item.title().catch(() => '')).slice(0, 100) || displayUrl(item.url()),
          url: displayUrl(item.url()),
        })),
      );
      const state = {
        type: 'browserState',
        connected: Boolean(page),
        url: page ? displayUrl(page.url()) : '',
        selected: page ? this.id(page) : '',
        tabs,
        locked: Boolean(browser?.automationActive),
      };
      const signature = JSON.stringify(state);
      if (signature !== this.stateSignature) {
        this.stateSignature = signature;
        this.emit(state);
      }
    } catch {
      this.emit({ type: 'browserNotice', text: t('브라우저 화면을 다시 연결하고 있습니다…') });
    } finally {
      this.updating = false;
    }
  }
  async attach(page) {
    await this.detach();
    if (this.disposed) return;
    this.page = page;
    this.token = randomUUID();
    if (!page || !page.context().newCDPSession) return;
    const client = await page.context().newCDPSession(page);
    if (this.disposed || this.page !== page) {
      await client.detach().catch(() => {});
      return;
    }
    this.client = client;
    this.onNavigation = (frame) => {
      if (frame === page.mainFrame()) {
        this.token = randomUUID();
        this.pending = null;
      }
    };
    page.on('framenavigated', this.onNavigation);
    client.on('Page.screencastFrame', (frame) => {
      client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      if (this.client !== client || this.disposed || !frame.data || frame.data.length > 6 * 1024 * 1024)
        return;
      const size = page.viewportSize();
      if (
        size &&
        (Math.abs(frame.metadata.deviceWidth - size.width) > 1 ||
          Math.abs(frame.metadata.deviceHeight - size.height) > 1)
      )
        return;
      this.pending = {
        type: 'browserFrame',
        id: ++this.sequence,
        token: this.token,
        data: frame.data,
        viewport: page.viewportSize() || {
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight,
        },
      };
      this.flush();
    });
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 75,
      maxWidth: 1920,
      maxHeight: 1400,
      everyNthFrame: 1,
    });
  }
  flush() {
    if (this.inFlight || !this.pending || this.disposed) return;
    const frame = this.pending;
    this.pending = null;
    this.inFlight = { id: frame.id, token: frame.token };
    this.emit(frame);
  }
  async detach() {
    if (this.onNavigation && this.page) this.page.off('framenavigated', this.onNavigation);
    this.onNavigation = null;
    const client = this.client;
    this.client = null;
    this.pending = null;
    this.inFlight = null;
    if (client) {
      await client.send('Page.stopScreencast').catch(() => {});
      await client.detach().catch(() => {});
    }
  }
  async handle(message) {
    if (message.type === 'frameAck') {
      if (message.id === this.inFlight?.id && message.token === this.inFlight?.token) {
        this.inFlight = null;
        this.flush();
      }
      return;
    }
    if (message.type === 'resize') {
      if (Number.isFinite(message.width) && Number.isFinite(message.height))
        this.resize = {
          width: Math.max(480, Math.min(1920, Math.round(message.width))),
          height: Math.max(320, Math.min(1400, Math.round(message.height))),
        };
      return;
    }
    if (
      message.type !== 'browserInput' &&
      message.type !== 'browserAction' &&
      message.type !== 'selectBrowserPage'
    )
      return;
    const job = this.queue.then(() => this.input(message));
    this.queue = job.catch(() => {});
    return job;
  }
  async input(message) {
    const browser = this.getBrowser(),
      page = this.page;
    if (this.disposed || !page || page.isClosed() || !browser?.context?.pages().includes(page)) return;
    if (browser.automationActive) {
      this.emit({
        type: 'browserNotice',
        text: t('에이전트 작업 중에는 브라우저 입력을 잠급니다. 중지 후 직접 조작할 수 있습니다.'),
      });
      return;
    }
    if (message.type === 'selectBrowserPage') {
      const selected = browser.context
        .pages()
        .find((item) => !item.isClosed() && this.id(item) === message.id);
      if (selected) {
        this.manualPage = selected;
        try {
          validateCopilotUrl(selected.url());
          browser.page = selected;
        } catch {
          /* Authentication popups stay separate from the automation target. */
        }
        await this.attach(selected);
      }
      return;
    }
    if (message.token !== this.token) return; // Old tab/viewport input must never target a new page.
    if (message.type === 'browserAction') {
      if (message.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      if (message.action === 'forward')
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      if (message.action === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return;
    }
    if (
      message.action === 'text' &&
      typeof message.text === 'string' &&
      message.text.length <= 50000 &&
      !message.text.includes('\0')
    ) {
      await page.keyboard.insertText(message.text);
      return;
    }
    if (message.action === 'key') {
      const special =
        /^(Enter|Tab|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/;
      if (typeof message.key !== 'string' || (!special.test(message.key) && !/^[a-z0-9]$/i.test(message.key)))
        return;
      const modifiers = (Array.isArray(message.modifiers) ? message.modifiers : []).filter((value) =>
        ['Control', 'Meta', 'Alt', 'Shift'].includes(value),
      );
      await page.keyboard.press([...new Set(modifiers), message.key].join('+'));
      return;
    }
    if (
      !Number.isFinite(message.x) ||
      !Number.isFinite(message.y) ||
      message.x < 0 ||
      message.x > 1 ||
      message.y < 0 ||
      message.y > 1
    )
      return;
    const viewport = page.viewportSize();
    if (!viewport) return;
    await page.mouse.move(
      Math.min(viewport.width - 1, message.x * viewport.width),
      Math.min(viewport.height - 1, message.y * viewport.height),
    );
    if (message.action === 'wheel' && Number.isFinite(message.deltaX) && Number.isFinite(message.deltaY)) {
      await page.mouse.wheel(
        Math.max(-3000, Math.min(3000, message.deltaX)),
        Math.max(-3000, Math.min(3000, message.deltaY)),
      );
      return;
    }
    if (!['left', 'middle', 'right'].includes(message.button)) return;
    const options = { button: message.button, clickCount: message.clickCount === 2 ? 2 : 1 };
    if (message.action === 'down') await page.mouse.down(options);
    if (message.action === 'up') await page.mouse.up(options);
  }
  async dispose() {
    this.disposed = true;
    this.context?.off?.('page', this.onPage);
    await this.detach();
    this.page = null;
    this.context = null;
  }
}
module.exports = { BrowserScreen, displayUrl };
