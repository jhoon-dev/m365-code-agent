'use strict';
const crypto = require('node:crypto');
const { validateCopilotUrl } = require('./browser');
const { conversationUrl, mergeHistory } = require('./web-history');
const { readComposer } = require('./composer');

class ConversationController {
  constructor(host, vscode) {
    this.host = host;
    this.vscode = vscode;
    this.revision = 0;
  }
  invalidate() {
    this.revision++;
  }
  async protectWebDraft(browser) {
    if (browser.generationActive && (await browser.generationActive()))
      throw new Error('웹에서 응답을 생성 중입니다. 완료 후 대화를 전환하세요.');
    if (!browser.getComposer) return;
    let composer;
    try {
      composer = await browser.getComposer();
    } catch {
      return; /* Authentication/loading screen. */
    }
    if ((await readComposer(composer.locator)).text.trim())
      throw new Error(
        '웹 입력창에 작성 중인 내용이 있어 대화를 전환하지 않았습니다. 초안을 먼저 정리하세요.',
      );
  }
  async openWeb(url) {
    const host = this.host;
    const browser = await host.ensureBrowser();
    if (conversationUrl(browser.page.url()).url !== url) {
      await this.protectWebDraft(browser);
      await browser.page.goto(validateCopilotUrl(url), { waitUntil: 'domcontentloaded' });
    }
    return browser;
  }
  async prepareWeb() {
    const host = this.host,
      browser = host.browser;
    const revision = this.revision,
      sessionId = host.sessionId;
    if (host.webUrl) await this.openWeb(host.webUrl);
    else if (host.newWebChat) {
      await this.protectWebDraft(browser);
      await browser.newChat();
      await browser.waitForComposer((text) => host.post({ type: 'status', text }));
    }
    if (host.stopRequested || this.revision !== revision || host.sessionId !== sessionId)
      throw new Error('작업을 중지했습니다.');
    host.newWebChat = false;
  }
  saveSession() {
    const host = this.host;
    if (!host.sessionId) host.sessionId = crypto.randomUUID();
    const customTitle = host.sessions.find((session) => session.id === host.sessionId)?.customTitle;
    const session = {
      id: host.sessionId,
      title:
        customTitle || host.events.find((event) => event.role === 'user')?.text.slice(0, 70) || '새 대화',
      ...(customTitle ? { customTitle } : {}),
      updated: Date.now(),
      events: host.events,
      webUrl: host.webUrl,
      newWebChat: Boolean(host.newWebChat),
    };
    host.sessions = [session, ...host.sessions.filter((item) => item.id !== session.id)].slice(0, 20);
    host.context.workspaceState.update('sessions', host.sessions);
    host.context.workspaceState.update('activeSession', host.sessionId);
  }
  async newChat() {
    const host = this.host;
    if (host.starting || host.switchingBrowser || host.sessionSwitching || host.agent?.running)
      throw new Error('진행 중인 작업을 먼저 중지하세요.');
    this.invalidate();
    host.saveSession();
    host.sessionId = crypto.randomUUID();
    host.events = [];
    host.webUrl = undefined;
    host.newWebChat = true;
    host.attachments = [];
    host.saveSession();
    host.view?.webview.postMessage(host.state());
    host.post({ type: 'status', text: '새 대화 · 작업을 입력하세요.' });
  }
  async showHistory() {
    return this.selectSession(
      async () =>
        (
          await this.vscode.window.showQuickPick(
            this.summaries().map((item) => ({
              label: item.title,
              description: new Date(item.updated).toLocaleString(),
              id: item.id,
            })),
            { placeHolder: '이어서 작업할 대화' },
          )
        )?.id,
    );
  }
  summaries() {
    const host = this.host;
    return host.sessions
      .filter((session) => session.events.length || session.customTitle)
      .map((session) => ({
        id: session.id,
        title: session.title,
        updated: session.updated,
        count: session.events.filter((event) => event.type === 'message').length,
        active: session.id === host.sessionId,
        linked: Boolean(session.webUrl),
      }));
  }
  publishList() {
    this.host.view?.webview.postMessage({ type: 'sessions', items: this.summaries() });
  }
  async selectSession(select) {
    const host = this.host;
    if (host.starting || host.switchingBrowser || host.sessionSwitching || host.agent?.running) return;
    this.invalidate();
    host.sessionSwitching = true;
    host.stopRequested = false;
    host.post({ type: 'busy' });
    try {
      const id = typeof select === 'function' ? await select() : select;
      const selected = host.sessions.find((session) => session.id === id);
      if (!selected || host.stopRequested) return;
      if (selected.webUrl) await this.openWeb(selected.webUrl);
      if (host.stopRequested) return;
      host.saveSession();
      if (host.sessionId !== selected.id) host.attachments = [];
      host.sessionId = selected.id;
      host.events = selected.events;
      host.webUrl = selected.webUrl;
      host.newWebChat = !host.webUrl;
      host.saveSession();
    } finally {
      host.sessionSwitching = false;
      host.view?.webview.postMessage(host.state());
      host.post({ type: 'idle' });
    }
  }
  async manageSession(action, id) {
    const host = this.host,
      window = this.vscode.window;
    if (host.starting || host.switchingBrowser || host.sessionSwitching || host.agent?.running)
      throw new Error('진행 중인 작업을 마친 뒤 기록을 관리하세요.');
    if (!['rename', 'delete', 'deleteAll'].includes(action)) return;
    const session = host.sessions.find((item) => item.id === id);
    if (action !== 'deleteAll' && !session) return;
    this.invalidate();
    host.sessionSwitching = true;
    host.post({ type: 'busy' });
    const revision = this.revision;
    try {
      if (action === 'rename') {
        const title = await window.showInputBox({
          title: 'VS Code 대화 이름 변경',
          value: session.title,
          prompt: 'VS Code 기록에 표시할 제목(최대 80자). Copilot 웹 제목은 유지됩니다.',
          validateInput: (value) =>
            !value.trim()
              ? '제목을 입력하세요.'
              : value.trim().length > 80
                ? '80자 이하로 입력하세요.'
                : undefined,
        });
        if (title === undefined || this.revision !== revision) return;
        if (typeof title !== 'string' || !title.trim() || title.trim().length > 80)
          throw new Error('제목은 1~80자로 입력하세요.');
        session.title = session.customTitle = title.trim();
      } else {
        const targetIds = new Set(action === 'deleteAll' ? host.sessions.map((item) => item.id) : [id]);
        const label =
          action === 'deleteAll'
            ? '이 작업 영역의 VS Code 대화 기록을 모두 삭제할까요?'
            : `“${session.title}”의 VS Code 대화 기록을 삭제할까요?`;
        if (
          (await window.showWarningMessage(
            label,
            { modal: true, detail: 'Copilot 웹 대화와 프로젝트 파일은 삭제하지 않습니다.' },
            '삭제',
          )) !== '삭제'
        )
          return;
        if (this.revision !== revision) return;
        host.sessions = host.sessions.filter((item) => !targetIds.has(item.id));
        if (targetIds.has(host.sessionId)) {
          host.sessionId = crypto.randomUUID();
          host.events = [];
          host.webUrl = undefined;
          host.newWebChat = true;
          host.attachments = [];
          host.saveSession();
        }
      }
      await host.context.workspaceState.update('sessions', host.sessions);
      host.post({
        type: 'status',
        text:
          action === 'rename'
            ? '대화 이름을 변경했습니다.'
            : '선택한 VS Code 대화 기록을 삭제했습니다. 웹 대화는 유지됩니다.',
      });
    } finally {
      host.sessionSwitching = false;
      this.publishList();
      host.view?.webview.postMessage(host.state());
      host.post({ type: 'idle' });
    }
  }
  async syncWeb(manual = true) {
    const host = this.host;
    if (
      host.starting ||
      host.switchingBrowser ||
      host.sessionSwitching ||
      host.agent?.running ||
      host.syncing
    )
      return;
    if (host.newWebChat) {
      if (manual) host.post({ type: 'status', text: '이 대화는 첫 요청을 보내면 새 웹 대화와 연결됩니다.' });
      return;
    }
    if (!host.browser?.page || host.browser.page.isClosed() || !host.browser.readConversation) {
      if (manual) throw new Error('먼저 Copilot을 연결하고 웹 대화를 여세요.');
      return;
    }
    host.syncing = true;
    const sessionId = host.sessionId,
      revision = this.revision,
      browser = host.browser,
      page = browser.page;
    const pageUrl = page.url ? conversationUrl(page.url()).url : undefined;
    try {
      if (!manual && !host.view?.visible) return;
      const snapshot = await host.browser.readConversation();
      if (
        host.starting ||
        host.switchingBrowser ||
        host.sessionSwitching ||
        host.agent?.running ||
        host.newWebChat ||
        host.sessionId !== sessionId ||
        this.revision !== revision ||
        host.browser !== browser ||
        browser.page !== page ||
        page.isClosed() ||
        (pageUrl && conversationUrl(page.url()).url !== pageUrl)
      )
        return;
      if (host.webUrl && !snapshot.restorable) {
        if (manual)
          host.post({
            type: 'status',
            text: '웹 대화 주소가 아직 정해지지 않았습니다. 웹에서 대화를 시작한 뒤 동기화하세요.',
          });
        return;
      }
      const previousUrl = host.webUrl;
      if (snapshot.restorable && host.webUrl !== snapshot.url) {
        const session = host.sessions.find((session) => session.webUrl === snapshot.url);
        if (session) {
          host.sessionId = session.id;
          host.events = session.events;
        } else if (host.webUrl) {
          host.saveSession();
          host.sessionId = crypto.randomUUID();
          host.events = [];
        }
        if (host.sessionId !== sessionId) host.attachments = [];
        host.webUrl = snapshot.url;
      }
      const merged = mergeHistory(host.events, snapshot.messages);
      const changed = JSON.stringify(merged) !== JSON.stringify(host.events);
      host.events = merged;
      if (changed || previousUrl !== host.webUrl) host.saveSession();
      if (changed || previousUrl !== host.webUrl || manual) host.view?.webview.postMessage(host.state());
      if (manual)
        host.post({
          type: 'status',
          text: snapshot.messages.length
            ? `웹 대화 동기화 · ${snapshot.messages.length}개 메시지 확인`
            : '웹 대화 메시지 영역을 읽지 못했습니다. 현재 로컬 기록은 유지했습니다.',
        });
    } finally {
      host.syncing = false;
    }
  }
}
module.exports = { ConversationController };
