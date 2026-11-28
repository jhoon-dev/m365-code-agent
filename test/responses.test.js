'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { CopilotBrowser } = require('../src/browser');
const { parseReply, buildPrompt } = require('../src/protocol');

test('response parser extracts wrapped JSON without changing source strings', () => {
  const content = 'const text = "{nested}";\nconst space = "a\u00a0b";\n';
  const value = { requestId: 'wrapped', kind: 'changes', files: [{ path: 'x.js', action: 'create', baseHash: null, content }] };
  const json = JSON.stringify(value, null, 2).replace(/\n  /g, '\n\u00a0\u00a0');
  assert.deepEqual(parseReply('JSON\n코드 복사\n' + json + '\nCopy code', 'wrapped'), value);
  assert.equal(parseReply('{"requestId":"x","kind":"done","message":"a"}\n{"requestId":"x","kind":"done","message":"b"}', 'x').message, 'a\n\nb');
  assert.throws(() => parseReply('{"requestId":"x","kind":"done"}', 'x'), error => error.code === 'INVALID_REPLY_SCHEMA');
  const prompt = buildPrompt({ id: 'never-echo', task: '설명해줘', workspace: 'sample', files: [] });
  assert.throws(() => parseReply(prompt, 'never-echo'), error => error.code === 'REPLY_NOT_FOUND');
});

test('Edge collects custom response widgets without clipboard or user interaction', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  async function fixture(options = {}) {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.route('https://m365.cloud.microsoft/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<textarea id="userInput"></textarea><button id="send">보내기</button><main><section id="reply"></section></main>' }));
    const page = await context.newPage();
    await page.goto('https://m365.cloud.microsoft/chat');
    const transport = new CopilotBrowser({ timeoutSeconds: 4, responseStableMs: 100, ...options });
    transport.context = context; transport.page = page;
    return transport;
  }
  const setup = async (transport, shape) => transport.page.evaluate(shape => {
    document.querySelector('#send').onclick = () => {
      const input = document.querySelector('textarea'), prompt = input.value;
      const id = prompt.match(/Current requestId: ([^\s]+)/)[1];
      input.value = '';
      const value = { requestId: id, kind: 'done', message: '수집 완료' };
      const json = JSON.stringify(value, null, 2), reply = document.querySelector('#reply');
      if (shape === 'wrapped') {
        const pre = document.createElement('pre'); pre.textContent = 'JSON\n복사\n' + json + '\n코드 복사'; reply.append(pre);
      } else if (shape === 'unknown') {
        const div = document.createElement('div'); div.className = 'custom-hashed-widget';
        for (const part of [json.slice(0, json.indexOf(id)), id, json.slice(json.indexOf(id) + id.length)]) { const span = document.createElement('span'); span.textContent = part; div.append(span); }
        reply.append(div);
      } else if (shape === 'shadow') {
        const host = document.createElement('custom-reply'); reply.append(host);
        const inner = document.createElement('div'); inner.textContent = json; host.attachShadow({ mode: 'open' }).append(inner);
      } else if (shape === 'frame') {
        const iframe = document.createElement('iframe'); reply.append(iframe);
        const div = iframe.contentDocument.createElement('div'); div.textContent = json; iframe.contentDocument.body.append(div);
      } else if (shape === 'editor') {
        reply.dataset.testid = 'code-block';
        const gutter = document.createElement('div'); gutter.textContent = '1 2 3 4';
        const lines = document.createElement('div'); lines.className = 'view-lines';
        for (const line of json.split('\n')) { const div = document.createElement('div'); div.className = 'view-line'; div.textContent = line.replace(/^  /, '\u00a0\u00a0'); lines.append(div); }
        reply.append(gutter, lines);
      } else if (shape === 'changing-footer') {
        reply.dataset.messageAuthorRole = 'assistant'; reply.append(document.createTextNode(json));
        const footer = document.createElement('button'); reply.append(footer);
        window.footerTimer = setInterval(() => { footer.textContent = '복사 ' + Date.now(); }, 40);
      } else if (shape === 'echo') {
        const pre = document.createElement('pre'); pre.textContent = prompt; reply.append(pre);
      } else if (shape === 'conflict') {
        for (const content of ['first', 'second']) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify({ requestId: id, kind: 'changes', files: [{ path: 'same.js', action: 'create', baseHash: null, content }] }); reply.append(pre); }
      } else if (shape === 'multi' || shape === 'transient-conflict') {
        if (shape === 'transient-conflict') { const stop = document.createElement('button'); stop.textContent = 'Stop generating'; document.body.append(stop); setTimeout(() => stop.remove(), 900); }
        for (const path of ['first.js', shape === 'multi' ? 'second.js' : 'first.js']) {
          const pre = document.createElement('pre'); pre.textContent = JSON.stringify({ requestId: id, kind: 'changes', files: [{ path, action: 'create', baseHash: null, content: 'content-' + reply.children.length }] }); reply.append(pre);
        }
        if (shape === 'multi') { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(value); reply.append(pre); reply.dataset.messageAuthorRole = 'assistant'; }
        else setTimeout(() => reply.firstElementChild.remove(), 350);
      }
    };
  }, shape);

  for (const shape of ['wrapped', 'unknown', 'shadow', 'frame', 'editor', 'changing-footer']) {
    await t.test(shape, async () => {
      const transport = await fixture();
      await setup(transport, shape);
      const reply = await transport.request(`Current requestId: ${shape}\n테스트 요청`, shape);
      assert.equal(reply.message, '수집 완료');
      assert.equal(transport.lastResponse.stage, 'complete');
      assert.equal(transport.lastResponse.parsed, true);
      assert.equal(JSON.stringify(transport.lastResponse).includes('수집 완료'), false);
    });
  }
  await t.test('disabled or unrelated Stop buttons do not keep a completed reply waiting', async () => {
    const transport = await fixture();
    await transport.page.evaluate(() => {
      const button = document.createElement('button'); button.textContent = 'Stop generating'; button.disabled = true;
      const voice = document.createElement('button'); voice.textContent = '중지';
      document.body.append(button, voice);
    });
    await setup(transport, 'unknown');
    assert.equal((await transport.request('Current requestId: stopped', 'stopped')).kind, 'done');
  });
  await t.test('outgoing prompt echo never becomes a reply', async () => {
    const transport = await fixture({ timeoutSeconds: 1 });
    await setup(transport, 'echo');
    const prompt = buildPrompt({ id: 'echo', task: '설명해줘', workspace: 'sample', files: [] });
    await assert.rejects(transport.request(prompt, 'echo'), /수집 시간이 초과/);
    assert.equal(transport.lastResponse.parsed, false);
    assert.equal(transport.lastResponse.matchingRequestId, 0);
  });
  await t.test('conflicting current-turn objects are never selected arbitrarily', async () => {
    const transport = await fixture();
    await setup(transport, 'conflict');
    await assert.rejects(transport.request('Current requestId: conflict', 'conflict'), /서로 다른 JSON/);
  });
  await t.test('per-file JSON blocks plus a done block merge across overlapping DOM containers', async () => {
    const transport = await fixture(); await setup(transport, 'multi');
    const reply = await transport.request('Current requestId: multi\n코드 작성해줘', 'multi');
    assert.equal(reply.kind, 'changes'); assert.deepEqual(reply.files.map(file => file.path), ['first.js', 'second.js']);
  });
  await t.test('transient conflicting renderings wait for generation to finish before deciding', async () => {
    const transport = await fixture(); await setup(transport, 'transient-conflict');
    const reply = await transport.request('Current requestId: transient\n코드 작성해줘', 'transient');
    assert.equal(reply.kind, 'changes'); assert.equal(reply.files.length, 1); assert.equal(reply.files[0].content, 'content-1');
  });
});
