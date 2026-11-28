'use strict';
const { t } = require('./localization');
const { parseReply, replyIdentity, mergeReplies } = require('./protocol');
const { createHash } = require('node:crypto');
const {
  normalizeDraft,
  matchesPrompt,
  readComposer,
  promptLimitError,
  isAgentProtocolDraft,
} = require('./composer');
const { scanResponses, defaultResponses } = require('./responses');
const { conversationUrl } = require('./web-history');
const { inspectControls, firstReadyControl, anyReadyControl } = require('./controls');
const { connectionError } = require('./connection');
const { prepareAttachments, verifyAttachments } = require('./browser-attachments');

const allowedHosts = new Set([
  'm365.cloud.microsoft',
  'copilot.cloud.microsoft',
  'www.microsoft365.com',
  'microsoft365.com',
  'www.office.com',
  'office.com',
]);
const authHosts = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'account.microsoft.com',
]);
function isLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && authHosts.has(url.hostname);
  } catch {
    return false;
  }
}
function validateCopilotUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !allowedHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    throw new Error(t('M365 Copilot의 HTTPS 주소만 연결할 수 있습니다.'));
  return url.href;
}

const defaultComposers = [
  '#userInput',
  '#m365-chat-editor-target-element',
  '[data-testid="chat-input"]',
  '[data-testid="chat-composer"] [contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
  'textarea[placeholder]',
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="combobox"]',
];

class CopilotBrowser {
  constructor(options) {
    this.options = options;
    this.context = null;
    this.page = null;
    this.busy = false;
    this.cancelled = false;
  }
  async connect() {
    if (!this.connecting)
      this.connecting = this.openConnection()
        .catch((error) => {
          const failure = connectionError(error, this.connectionStage || 'launch', this.options);
          this.lastConnectionFailure = failure.connectionFailure;
          throw failure;
        })
        .finally(() => {
          this.connecting = null;
        });
    return this.connecting;
  }
  async openConnection() {
    this.connectionStage = 'reuse';
    if (this.context) {
      try {
        const pages = this.context.pages().filter((page) => !page.isClosed());
        if (!this.page || this.page.isClosed()) {
          this.page =
            pages.findLast((page) => {
              try {
                validateCopilotUrl(page.url());
                return true;
              } catch {
                return false;
              }
            }) ||
            pages.at(-1) ||
            (await this.context.newPage());
        }
      } catch (error) {
        if (!/closed|disposed/i.test(error.message)) throw error;
        this.context = null;
        this.page = null;
      }
    }
    if (!this.context) {
      this.connectionStage = 'url';
      validateCopilotUrl(this.options.url);
      this.connectionStage = 'launch';
      const { chromium } = require('playwright-core');
      const context = await chromium.launchPersistentContext(this.options.profile, {
        channel: this.options.channel || 'msedge',
        headless: Boolean(this.options.embedded),
        viewport: this.options.embedded ? { width: 1100, height: 760 } : null,
        acceptDownloads: false,
        locale: 'ko-KR',
      });
      this.context = context;
      context.on('close', () => {
        if (this.context === context) {
          this.context = null;
          this.page = null;
        }
      });
      this.page = context.pages()[0] || (await context.newPage());
      this.needsNavigation = true;
    }
    this.page.setDefaultTimeout(7000);
    const current = this.page.url();
    if (this.needsNavigation && current !== 'about:blank' && !current.startsWith('chrome-error:')) {
      // Preserve a working composer or a sign-in page after a navigation timeout.
      if (
        isLoginUrl(current) ||
        (await this.getComposer()
          .then(() => true)
          .catch(() => false))
      )
        this.needsNavigation = false;
    }
    if (this.needsNavigation || current === 'about:blank' || current.startsWith('chrome-error:')) {
      this.connectionStage = 'navigation';
      this.needsNavigation = true;
      await this.page.goto(validateCopilotUrl(this.options.url), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      this.needsNavigation = false;
    }
    this.connectionStage = 'ready';
    this.lastConnectionFailure = null;
  }
  async getComposer() {
    const configured = this.options.composerSelector;
    const selectors = configured ? [configured] : defaultComposers;
    // Copilot can render the composer inside a same-origin or accessible child frame.
    for (const frame of this.page.frames()) {
      for (const selector of selectors) {
        const candidates = frame.locator(selector);
        for (const locator of (await candidates.all()).slice(0, 8)) {
          try {
            if ((await locator.isVisible()) && (await locator.isEditable()))
              return { locator, frame, selector };
          } catch {
            /* An ID can belong to a non-editable wrapper in some interface versions. */
          }
        }
      }
    }
    throw new Error(
      t(
        'Copilot 입력창을 찾지 못했습니다. 전용 Edge 창에서 로그인하고 대화 화면을 연 뒤 다시 연결하세요. 화면 구조가 달라졌다면 입력창 CSS 선택자를 설정하세요.',
      ),
    );
  }
  async waitForComposer(onStatus = () => {}) {
    const deadline =
      Date.now() + (this.options.loginTimeoutMs ?? (this.options.loginTimeoutSeconds || 600) * 1000);
    let handle,
      readySince = 0,
      lastStatus = '';
    const report = (text) => {
      if (text !== lastStatus) {
        onStatus(text);
        lastStatus = text;
      }
    };
    try {
      while (true) {
        if (this.cancelled) throw new Error(t('작업을 중지했습니다.'));
        if (!this.context || !this.context.pages().some((page) => !page.isClosed()))
          throw new Error(t('Copilot 브라우저가 닫혔습니다. 요청은 전송하지 않았습니다.'));
        if (Date.now() >= deadline)
          throw new Error(
            t(
              '로그인·입력창 준비 대기 시간이 끝났습니다. 요청은 전송하지 않았으며 입력창에서 다시 시도할 수 있습니다.',
            ),
          );
        let candidate;
        for (const page of [this.page, ...[...this.context.pages()].reverse()].filter(
          (page, index, all) => page && !page.isClosed() && all.indexOf(page) === index,
        )) {
          try {
            validateCopilotUrl(page.url());
          } catch {
            continue;
          }
          this.page = page;
          try {
            candidate = await this.getComposer();
            break;
          } catch {
            /* Login redirect or app hydration. */
          }
        }
        if (candidate) {
          if (
            handle &&
            this.readyPage === this.page &&
            this.readyFrame === candidate.frame &&
            (await handle.evaluate((element) => element.isConnected).catch(() => false))
          ) {
            if (Date.now() - readySince >= (this.options.composerStableMs ?? 900)) return candidate;
          } else {
            await handle?.dispose();
            handle = await candidate.locator.elementHandle();
            readySince = Date.now();
            this.readyPage = this.page;
            this.readyFrame = candidate.frame;
          }
          report(t('Copilot 입력창 준비 중 · 첫 요청을 보관하고 있습니다…'));
        } else {
          await handle?.dispose();
          handle = null;
          readySince = 0;
          const pages = this.context.pages().filter((page) => !page.isClosed());
          if (pages.some((page) => isLoginUrl(page.url())))
            report(t('계정 로그인·MFA 대기 중 · 완료되면 첫 요청을 자동으로 보냅니다.'));
          else {
            report(t('Copilot 대화 화면 대기 중 · 로그인과 화면 로딩이 끝나면 자동으로 계속합니다…'));
          }
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.readinessPollMs ?? 250));
      }
    } finally {
      await handle?.dispose().catch(() => {});
    }
  }
  async diagnostics({ connect = true } = {}) {
    if (connect) await this.connect();
    let composer;
    try {
      composer = (await this.getComposer()).selector;
    } catch (error) {
      composer = error.message;
    }
    return {
      url: this.page.url().split(/[?#]/)[0],
      connectionStage: this.connectionStage || 'ready',
      title: await this.page.title(),
      composer,
      frames: this.page.frames().length,
      lastSend: this.lastSend || null,
      lastResponse: this.lastResponse || null,
    };
  }
  async findSendButton(frame, composer) {
    const groups = this.options.sendButtonSelector
      ? [frame.locator(this.options.sendButtonSelector)]
      : [
          frame.getByRole('button', {
            name: /^(send|send message|send prompt|submit|submit prompt|보내기|전송|제출|메시지 보내기|메시지 전송|질문 보내기|프롬프트 제출|프롬프트 보내기)(\s*\(.*\))?$/i,
          }),
          frame.locator(
            'button[data-testid="send-button"], button[data-testid="sendButton"], button[data-testid="send-message-button"], button[data-testid="submit-button"], button#submit-button, button#sendMessageButton, button:has([data-icon-name="Send"])',
          ),
          composer.locator('xpath=ancestor::form[1]').locator('button[type="submit"]'),
        ];
    for (const group of groups) {
      const button = await firstReadyControl(group);
      if (button) return button;
    }
    return null;
  }
  async submitPrompt(locator, frame, prompt, baseline, id) {
    let button;
    try {
      const readyDeadline = Date.now() + (this.options.sendReadyTimeoutMs || 8000);
      while (Date.now() < readyDeadline) {
        if (this.cancelled) throw new Error(t('작업을 중지했습니다.'));
        button = await this.findSendButton(frame, locator);
        if (button) {
          let actionable = false;
          try {
            await button.click({
              trial: true,
              timeout: Math.max(1, Math.min(750, readyDeadline - Date.now())),
            });
            actionable = true;
          } catch {
            /* No click was dispatched; safely find a replacement control. */
          }
          if (actionable) {
            await this.verifyInput(locator, prompt);
            const [state] = await button.evaluate(inspectControls).catch(() => [{ visible: false }]);
            if (state.visible && state.enabled) break;
          }
          await button.dispose().catch(() => {});
          button = null;
        }
        await this.page.waitForTimeout(200);
      }
      if (!button) {
        await this.verifyInput(locator, prompt);
        this.lastSend.stage = 'button-not-ready';
        throw new Error(
          t(
            '전송 버튼을 찾지 못했거나 활성화되지 않았습니다. Copilot 로그인·입력 길이 제한을 확인하세요. 요청은 전송하지 않았습니다.',
          ),
        );
      }
      await this.verifyInput(locator, prompt);
      if (this.cancelled) throw new Error(t('작업을 중지했습니다.'));
      await verifyAttachments(this, locator, id);
      this.lastSend.stage = 'clicked';
      // Pin one DOM element and attempt a real click only once. Even if the page
      // replaces it during dispatch, inspect acknowledgement rather than re-clicking.
      let clickError;
      try {
        await button.click({ timeout: 2000 });
      } catch (error) {
        clickError = error;
        this.lastSend.clickError = error.name;
      }
      const deadline = Date.now() + (this.options.sendAckTimeoutMs || 12000);
      while (Date.now() < deadline) {
        if (this.cancelled) throw new Error(t('작업을 중지했습니다.'));
        const cleared = await readComposer(locator)
          .then((snapshot) => !snapshot.text.trim())
          .catch(() => false);
        const generating = await this.generationActive();
        let reply = false;
        for (const text of await this.responseCandidates(id, prompt)) {
          if (baseline.has(text)) continue;
          try {
            parseReply(text, id);
            reply = true;
            break;
          } catch {
            /* Not a complete response yet. */
          }
        }
        if (cleared || generating || reply) {
          this.lastSend.stage = 'confirmed';
          return;
        }
        await this.page.waitForTimeout(200);
      }
      this.lastSend.stage = 'unconfirmed';
      throw new Error(
        (clickError
          ? t('전송 중 버튼 화면이 변경되어 제출을 확인하지 못했습니다.')
          : t('전송 버튼을 눌렀지만 제출을 확인하지 못했습니다.')) +
          t(' Edge 창의 제한·오류 메시지를 확인하세요. 중복 전송을 피하려고 자동 재전송하지 않았습니다.'),
      );
    } finally {
      await button?.dispose().catch(() => {});
    }
  }
  async verifyInput(locator, prompt) {
    let snapshot;
    const deadline = Date.now() + (this.options.inputSettleTimeoutMs || 1500);
    do {
      snapshot = await readComposer(locator);
      this.lastSend = {
        stage: 'input-check',
        characters: prompt.length,
        observedCharacters: snapshot.text.length,
        maxLength: snapshot.maxLength,
        tag: snapshot.tag,
      };
      if (matchesPrompt(snapshot, prompt)) {
        this.ownedDraft = snapshot;
        return;
      }
      if (this.cancelled) throw new Error(t('작업을 중지했습니다.'));
      await this.page.waitForTimeout(100);
    } while (Date.now() < deadline);
    const actual = normalizeDraft(snapshot.text),
      expected = normalizeDraft(prompt);
    if (actual.length >= 32 && actual.length < expected.length && expected.startsWith(actual)) {
      this.ownedDraft = snapshot;
      this.promptCharacterLimit = snapshot.maxLength ?? actual.length;
      this.lastSend.stage = 'input-truncated';
      throw promptLimitError(this.promptCharacterLimit, prompt.length);
    }
    this.lastSend.stage = 'input-mismatch';
    const error = new Error(
      t(
        'Copilot 편집기가 입력 내용을 변경했습니다 (요청 {0}자 / 확인 {1}자). 길이 제한으로 단정하지 않았으며 전송하지 않았습니다. ⋯ 연결 진단에서 입력 상태를 확인하세요.',
        prompt.length.toLocaleString(),
        snapshot.text.length.toLocaleString(),
      ),
    );
    if (!actual) {
      error.code = 'COMPOSER_REINITIALIZED';
      error.notSubmitted = true;
    }
    throw error;
  }
  async writePrompt(locator, prompt) {
    const initial = await readComposer(locator);
    if (initial.maxLength !== null && prompt.length > initial.maxLength) {
      this.promptCharacterLimit = initial.maxLength;
      this.lastSend = {
        stage: 'input-limit',
        characters: prompt.length,
        observedCharacters: 0,
        maxLength: initial.maxLength,
        tag: initial.tag,
      };
      throw promptLimitError(initial.maxLength, prompt.length);
    }
    await locator.fill(prompt);
    const snapshot = await readComposer(locator);
    if (matchesPrompt(snapshot, prompt)) this.ownedDraft = snapshot;
    await this.verifyInput(locator, prompt);
  }
  async responseCandidates(id, prompt) {
    const texts = new Set(),
      sources = new Set();
    let truncated = false;
    const selector = this.options.responseSelector || defaultResponses;
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      const scan = await frame.evaluate(scanResponses, { selector, id, prompt });
      truncated ||= scan.truncated;
      for (const block of scan.blocks) {
        texts.add(block.text);
        sources.add(block.source);
      }
    }
    this.responseScan = { candidates: texts.size, sources: [...sources], scanTruncated: truncated };
    return [...texts];
  }
  async generationActive() {
    const pattern =
      /^(Stop generating|Stop responding|Stop response|Stop generation|응답 중지|생성 중지|답변 중지|응답 생성 중지|답변 생성 중지)(\s*\(.*\))?$/i;
    for (const frame of this.page.frames()) {
      if (!frame.isDetached() && (await anyReadyControl(frame.getByRole('button', { name: pattern }))))
        return true;
    }
    return false;
  }
  async newChat() {
    await this.connect();
    await this.protectConversationDraft();
    const name = /^(새 채팅|새 대화|New chat|New conversation)$/i;
    for (const frame of this.page.frames()) {
      for (const role of ['button', 'link']) {
        for (const button of await frame.getByRole(role, { name }).all()) {
          if (await button.isVisible()) {
            await button.click();
            return;
          }
        }
      }
    }
    throw new Error(
      t('새 대화 버튼을 찾지 못해 요청을 보내지 않았습니다. 전용 브라우저의 새 채팅 버튼을 확인하세요.'),
    );
  }
  async protectConversationDraft() {
    if (await this.generationActive())
      throw new Error(t('웹에서 응답을 생성 중입니다. 완료 후 대화를 전환하세요.'));
    let composer;
    try {
      composer = await this.getComposer();
    } catch {
      return;
    }
    if ((await readComposer(composer.locator)).text.trim())
      throw new Error(
        t('웹 입력창에 작성 중인 내용이 있어 대화를 전환하지 않았습니다. 초안을 먼저 정리하세요.'),
      );
    await prepareAttachments(this, composer.locator, composer.frame, '', []);
  }
  async resumeConversation(value) {
    const target = conversationUrl(validateCopilotUrl(value));
    if (!target.restorable)
      throw new Error(t('복원할 수 있는 웹 대화 주소가 아닙니다. 새 웹 대화를 만들지 않았습니다.'));
    await this.connect();
    if (this.conversationInfo().url === target.url) return;
    await this.protectConversationDraft();
    await this.page.goto(target.url, { waitUntil: 'domcontentloaded' });
    await this.waitForComposer();
    if (this.conversationInfo().url !== target.url)
      throw new Error(t('원래 웹 대화로 복원되지 않아 요청을 중단했습니다. 새 웹 대화를 만들지 않았습니다.'));
  }
  async request(
    prompt,
    id,
    onStatus = () => {},
    protocol = { parseReply, mergeReplies, replyIdentity },
    requestOptions = {},
  ) {
    const { parseReply, mergeReplies, replyIdentity } = protocol;
    if (this.busy) throw new Error(t('이미 Copilot 응답을 기다리는 중입니다.'));
    this.busy = true;
    this.cancelled = false;
    this.lastSend = null;
    this.lastResponse = { stage: 'not-submitted' };
    this.ownedDraft = null;
    let submitted = false;
    try {
      await this.connect();
      let baseline;
      for (let attempt = 0; attempt < 3; attempt++) {
        this.automationActive = false;
        const { locator, frame } = await this.waitForComposer(onStatus);
        this.automationActive = true;
        validateCopilotUrl(this.page.url());
        const draft = (await readComposer(locator)).text;
        if (await this.generationActive())
          throw new Error(t('Copilot이 다른 응답을 생성 중입니다. 완료 후 다시 실행하세요.'));
        if (draft.trim()) {
          if (!isAgentProtocolDraft(draft) || (await readComposer(locator)).text !== draft)
            throw new Error(
              t(
                'Copilot 입력창에 작성 중인 내용이 있습니다. 덮어쓰지 않았습니다. 전용 창에서 내용을 정리한 뒤 다시 실행하세요.',
              ),
            );
          await locator.fill('');
          onStatus(t('이전 버전이 남긴 자동화 요청 초안을 정리했습니다. 새 요청을 준비합니다.'));
        }
        if (this.cancelled) throw new Error(t('작업을 중지했습니다.'));
        baseline = new Set(await this.responseCandidates(id, prompt));
        onStatus(t('Copilot에 요청을 보내고 있습니다…'));
        try {
          await this.writePrompt(locator, prompt);
          await prepareAttachments(this, locator, frame, id, requestOptions.attachments, onStatus);
          if (this.cancelled) throw new Error(t('작업을 중지했습니다.'));
          await this.submitPrompt(locator, frame, prompt, baseline, id);
          submitted = true;
          this.pendingAttachments = null;
          break;
        } catch (error) {
          if (
            attempt === 2 ||
            error.code !== 'COMPOSER_REINITIALIZED' ||
            error.notSubmitted !== true ||
            ['clicked', 'unconfirmed'].includes(this.lastSend?.stage)
          )
            throw error;
          onStatus(t('로그인 후 입력창이 다시 준비되는 중입니다. 보관한 요청을 자동으로 이어 보냅니다…'));
        }
      }
      this.lastResponse = { stage: 'waiting' };
      onStatus(t('전송 확인됨 · Copilot 응답을 기다리고 있습니다…'));
      const deadline = Date.now() + (this.options.timeoutSeconds || 240) * 1000;
      let candidateText = '',
        stableSince = 0,
        lastStage = '',
        conflictSignature = '',
        conflictSince = 0;
      while (Date.now() < deadline) {
        if (this.cancelled) throw new Error(t('작업을 중지했습니다.'));
        if (this.page.isClosed()) throw new Error(t('Copilot 브라우저 창이 닫혔습니다.'));
        validateCopilotUrl(this.page.url());
        const blocks = await this.responseCandidates(id, prompt);
        let found,
          matching = 0,
          parseError;
        const parsed = [],
          conflicts = [];
        for (const text of blocks) {
          if (baseline.has(text) || !text.includes(id)) continue;
          matching++;
          try {
            parsed.push(parseReply(text, id));
          } catch (error) {
            parseError = error.code || 'REPLY_NOT_FOUND';
            if (error.code === 'AMBIGUOUS_REPLY') conflicts.push(error);
          }
        }
        if (!conflicts.length) {
          try {
            found = mergeReplies(parsed, id);
          } catch (error) {
            conflicts.push(error);
          }
        }
        const generating = await this.generationActive();
        if (conflicts.length) {
          const signature = createHash('sha256')
            .update(
              [
                ...new Set([
                  ...conflicts.map((error) => error.signature || error.code),
                  ...parsed.map(replyIdentity),
                ]),
              ]
                .sort()
                .join('\0'),
            )
            .digest('hex');
          if (signature !== conflictSignature) {
            conflictSignature = signature;
            conflictSince = Date.now();
          }
          candidateText = '';
          stableSince = 0;
          this.lastResponse = {
            stage: 'json-conflict',
            ...this.responseScan,
            matchingRequestId: matching,
            parsed: false,
            generating,
            parseError: conflicts[0].code,
          };
          if (!generating && Date.now() - conflictSince >= (this.options.responseStableMs ?? 2500))
            throw conflicts[0];
          if (lastStage !== 'json-conflict')
            onStatus(t('여러 JSON 수정안 확인 중 · 응답 완료 후 충돌을 검증합니다…'));
          lastStage = 'json-conflict';
          await this.page.waitForTimeout(500);
          continue;
        }
        conflictSignature = '';
        conflictSince = 0;
        const stage = found ? 'json-confirmed' : matching ? 'json-incomplete' : 'waiting';
        this.lastResponse = {
          stage,
          ...this.responseScan,
          matchingRequestId: matching,
          parsed: Boolean(found),
          generating,
          parseError: found ? null : parseError || null,
        };
        if (found) {
          const signature = replyIdentity(found);
          if (signature !== candidateText) {
            candidateText = signature;
            stableSince = Date.now();
          }
          if (Date.now() - stableSince >= (this.options.responseStableMs ?? 2500) && !generating) {
            this.lastResponse.stage = 'complete';
            this.options.onConversation?.(this.conversationInfo());
            return found;
          }
        } else {
          candidateText = '';
          stableSince = 0;
        }
        if (stage !== lastStage) {
          onStatus(
            found
              ? t('현재 요청의 JSON 확인됨 · 응답 완료 확인 중…')
              : matching
                ? t('현재 요청 ID가 있는 답변 발견 · JSON 수집 중…')
                : t('Copilot 답변 영역을 찾고 있습니다…'),
          );
          lastStage = stage;
        }
        await this.page.waitForTimeout(500);
      }
      const result = this.lastResponse;
      throw new Error(
        t(
          'Copilot 응답 수집 시간이 초과됐습니다. 후보 {0}개 / 현재 요청 ID {1}개 / JSON {2} / 생성 {3}. ⋯ 연결 진단에서 수집 단계를 확인하세요. 요청은 재전송하지 않았습니다.',
          result.candidates || 0,
          result.matchingRequestId || 0,
          result.parsed ? t('확인됨') : t('미확인'),
          result.generating ? t('진행 중으로 감지') : t('종료로 감지'),
        ),
      );
    } finally {
      if (
        !submitted &&
        !['clicked', 'unconfirmed'].includes(this.lastSend?.stage) &&
        this.ownedDraft &&
        this.page &&
        !this.page.isClosed()
      ) {
        try {
          const { locator } = await this.getComposer();
          const draft = await readComposer(locator);
          if (draft.text === this.ownedDraft.text && draft.visibleText === this.ownedDraft.visibleText)
            await locator.fill('');
        } catch {
          /* Never clear a draft that is not exactly the one we inserted. */
        }
      }
      this.busy = false;
      this.automationActive = false;
    }
  }
  async stop() {
    this.cancelled = true;
    if (!this.page || this.page.isClosed()) return;
    try {
      for (const frame of this.page.frames()) {
        const buttons = frame.getByRole('button', {
          name: /^(Stop generating|Stop responding|응답 중지|생성 중지|답변 중지)$/i,
        });
        for (const button of await buttons.all())
          if (await button.isVisible()) {
            await button.click({ timeout: 2000 });
            return;
          }
      }
    } catch {
      /* Local cancellation still prevents applying subsequent results. */
    }
  }
  conversationInfo() {
    validateCopilotUrl(this.page.url());
    return conversationUrl(this.page.url());
  }
  async models(onStatus) {
    await this.connect();
    await this.waitForComposer(onStatus);
    this.automationActive = true;
    try {
      return await require('./web-controls').listModels(this, onStatus);
    } finally {
      this.automationActive = false;
    }
  }
  async selectModel(id, onStatus) {
    await this.connect();
    await this.waitForComposer(onStatus);
    this.automationActive = true;
    try {
      return await require('./web-controls').selectModel(this, id, onStatus);
    } finally {
      this.automationActive = false;
    }
  }
  async readConversation() {
    validateCopilotUrl(this.page.url());
    return require('./web-controls').readConversation(this);
  }
  async close() {
    this.cancelled = true;
    if (this.context) await this.context.close();
  }
}
module.exports = { CopilotBrowser, validateCopilotUrl };
