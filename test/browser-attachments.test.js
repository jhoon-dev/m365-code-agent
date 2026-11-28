'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { CopilotBrowser } = require('../src/browser');

const file = (name, mimeType = 'image/png') => ({ name, mimeType, buffer: Buffer.from('fixture-bytes') });
async function fixture(t, { multiple = true, chooser = false, reject = false, slow = false } = {}) {
  const process = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => process.close());
  const context = await process.newContext();
  await context.route('https://m365.cloud.microsoft/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
<form><textarea id="userInput"></textarea>
${chooser ? '<button type="button" id="attach">Attach files</button>' : `<input type="file" ${multiple ? 'multiple' : ''} hidden>`}
<div id="files"></div><button type="button" id="send">Send</button></form><div id="responses"></div>
<script>
window.uploads = 0; window.sends = 0; window.sentNames = [];
function register(input) { input.onchange = () => {
 window.uploads++;
 for (const file of input.files) {
  const chip=document.createElement('div');chip.dataset.testid='attachment-card';chip.textContent=file.name;chip.setAttribute('aria-busy','true');document.querySelector('#files').append(chip);
  ${reject ? "const error=document.createElement('div');error.role='alert';error.textContent='Unsupported file format';document.querySelector('form').append(error);" : ''}
  ${slow ? '' : "setTimeout(()=>chip.setAttribute('aria-busy','false'),150);"}
 }
}; }
${chooser ? `document.querySelector('#attach').onclick=()=>{const input=document.createElement('input');input.type='file';input.multiple=${multiple};input.hidden=true;register(input);document.querySelector('form').append(input);input.click();};` : "register(document.querySelector('input'));"}
document.querySelector('#send').onclick=()=>{
 window.sends++;window.sentNames=[...document.querySelectorAll('[data-testid="attachment-card"]')].map(x=>x.textContent);
 const input=document.querySelector('textarea');const id=input.value.match(/Current requestId: ([^\\s]+)/)[1];input.value='';
 document.querySelector('#files').replaceChildren();
 for(const fileInput of document.querySelectorAll('input'))fileInput.value='';
 const reply=document.createElement('pre');reply.textContent=JSON.stringify({requestId:id,kind:'done',message:'analyzed'});document.querySelector('#responses').append(reply);
};
</script></body></html>` }));
  const page = await context.newPage(); await page.goto('https://m365.cloud.microsoft/chat');
  const transport = new CopilotBrowser({ timeoutSeconds: 5, attachmentTimeoutMs: 900, composerStableMs: 5, responseStableMs: 5, readinessPollMs: 10 });
  transport.page = page; transport.context = context;
  return transport;
}
const request = (transport, files, id = 'files-1') => transport.request('Current requestId: ' + id, id, () => {}, undefined, { attachments: files });

test('native attachments are confirmed before send and are not uploaded again on tool rounds', async t => {
 const browser = await fixture(t);
 const files = [file('image.png'), file('report.pdf', 'application/pdf'), file('book.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')];
 assert.equal((await request(browser, files)).message, 'analyzed');
 assert.deepEqual(await browser.page.evaluate(() => window.sentNames), files.map(file => file.name));
 await request(browser, [], 'round-2');
 assert.equal(await browser.page.evaluate(() => window.uploads), 1);
 assert.equal(await browser.page.evaluate(() => window.sends), 2);
});

test('single-file inputs append several uploads sequentially and file chooser upload works', async t => {
 const browser = await fixture(t, { multiple: false, chooser: true });
 await request(browser, [file('one.png'), file('two.png')]);
 assert.deepEqual(await browser.page.evaluate(() => window.sentNames), ['one.png', 'two.png']);
 assert.equal(await browser.page.evaluate(() => window.uploads), 2);
});

test('pre-existing draft attachments and conversation switches are protected', async t => {
 const browser = await fixture(t);
 await browser.page.locator('#files').evaluate(node => { const card=document.createElement('div');card.dataset.testid='attachment-card';card.textContent='personal.pdf';node.append(card); });
 await assert.rejects(request(browser, [file('new.png')]), /기존 첨부/);
 await assert.rejects(browser.protectConversationDraft(), /기존 첨부/);
 assert.equal(await browser.page.evaluate(() => window.uploads + window.sends), 0);
 assert.equal(await browser.page.locator('#files').textContent(), 'personal.pdf');
});

test('upload rejection and unconfirmed upload never send a text-only request', async t => {
 for (const options of [{ reject: true }, { slow: true }]) {
  const browser = await fixture(t, options);
  await assert.rejects(request(browser, [file('bad.png')]), /첨부 실패|업로드 완료/);
  assert.equal(await browser.page.evaluate(() => window.sends), 0);
  assert.equal(await browser.page.locator('textarea').inputValue(), '');
 }
});

test('confirmed unsent composer retries reuse uploads without duplication', async t => {
 const browser = await fixture(t); const original = browser.submitPrompt.bind(browser); let attempts = 0;
 t.mock.method(browser, 'submitPrompt', async (...args) => {
  if (++attempts === 1) {
   await args[0].fill('');
   throw Object.assign(new Error('composer replaced'), { code: 'COMPOSER_REINITIALIZED', notSubmitted: true });
  }
  return original(...args);
 });
 await request(browser, [file('once.png')]);
 assert.equal(await browser.page.evaluate(() => window.uploads), 1);
 assert.equal(await browser.page.evaluate(() => window.sends), 1);
});

test('length rejection occurs before upload and an unrelated draft is never overwritten', async t => {
 const browser = await fixture(t);
 await browser.page.locator('textarea').evaluate(node => node.maxLength=4);
 await assert.rejects(request(browser, [file('x.png')]), { code: 'PROMPT_LIMIT', notSubmitted: true });
 assert.equal(await browser.page.evaluate(() => window.uploads), 0);
 await browser.page.locator('textarea').evaluate(node => node.removeAttribute('maxlength'));
 await browser.page.locator('textarea').fill('my draft');
 await assert.rejects(request(browser, [file('x.png')]), /작성 중/);
 assert.equal(await browser.page.locator('textarea').inputValue(), 'my draft');
 assert.equal(await browser.page.evaluate(() => window.uploads), 0);
});

test('attachments removed after upload completion cannot produce a text-only send', async t => {
 const browser = await fixture(t); const original = browser.verifyInput.bind(browser);
 t.mock.method(browser, 'verifyInput', async (...args) => {
  await original(...args);
  if (browser.pendingAttachments?.uploaded) await browser.page.locator('#files').evaluate(node => node.replaceChildren());
 });
 await assert.rejects(request(browser, [file('removed.png')]), /전송 직전 첨부/);
 assert.equal(await browser.page.evaluate(() => window.sends), 0);
});

test('uncertain pending uploads stay blocked until a fresh clean document is observed', async t => {
 const browser = await fixture(t); const original = browser.submitPrompt.bind(browser); let fail = true;
 t.mock.method(browser, 'submitPrompt', async (...args) => {
  if (fail) throw new Error('fixture interrupted before send');
  return original(...args);
 });
 await assert.rejects(request(browser, [file('pending.png')]), /fixture interrupted/);
 await browser.page.locator('#files').evaluate(node => node.replaceChildren());
 await browser.page.locator('input').evaluate(node => node.value='');
 await assert.rejects(request(browser, [file('new.png')], 'fresh'), /미전송 첨부/);
 assert.equal(await browser.page.evaluate(() => window.sends), 0);
 await browser.page.reload(); fail = false;
 assert.equal((await request(browser, [file('new.png')], 'fresh')).message, 'analyzed');
 assert.equal(await browser.page.evaluate(() => window.uploads), 1);
});

test('accept-aware routing separates image and document inputs and prefers a common multiple input', async t => {
 const browser = await fixture(t);
 await browser.page.evaluate(() => {
  window.routes=[];
  const track=(input,target)=>{const original=input.onchange;input.onchange=event=>{window.routes.push({target,names:[...input.files].map(file=>file.name)});original(event);};};
  const images=document.querySelector('input'); images.accept='image/*'; track(images,'image');
  const documents=document.createElement('input');documents.type='file';documents.multiple=true;documents.accept='.PDF,application/vnd.openxmlformats-officedocument.wordprocessingml.document';documents.hidden=true;document.querySelector('form').append(documents);register(documents);track(documents,'document');
 });
 const files=[file('photo.PNG'),file('report.PDF','application/pdf'),file('notes.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')];
 await request(browser,files);
 assert.deepEqual(await browser.page.evaluate(()=>window.routes),[
  {target:'image',names:['photo.PNG']},{target:'document',names:['report.PDF','notes.docx']}
 ]);
 await browser.page.evaluate(()=>{
  const common=document.createElement('input');common.type='file';common.multiple=true;common.accept='*/*';common.hidden=true;document.querySelector('form').append(common);register(common);
  const original=common.onchange;common.onchange=event=>{window.routes.push({target:'common',names:[...common.files].map(file=>file.name)});original(event);};
  window.routes=[];
 });
 await request(browser,files,'common-input');
 assert.deepEqual(await browser.page.evaluate(()=>window.routes),[{target:'common',names:files.map(file=>file.name)}]);
});

test('an image-only native chooser rejects a PDF before any upload or send', async t => {
 const browser=await fixture(t,{chooser:true});
 await browser.page.locator('#attach').evaluate(button=>{button.textContent='Upload image';button.onclick=()=>{const input=document.createElement('input');input.type='file';input.accept='image/*';input.hidden=true;register(input);document.querySelector('form').append(input);input.click();};});
 await assert.rejects(request(browser,[file('report.pdf','application/pdf')]),/파일 선택창.*지원하지/);
 assert.equal(await browser.page.evaluate(()=>window.uploads+window.sends),0);
});

async function bebopFixture(t, mode = 'ready') {
 const browser = await fixture(t);
 await browser.page.evaluate(mode => {
  const form = document.querySelector('form');
  const wrapper = document.createElement('div'); wrapper.className = 'fai-BebopLiteChatInput';
  form.replaceWith(wrapper); while (form.firstChild) wrapper.append(form.firstChild);
  const editor = document.createElement('span'); editor.id = 'm365-chat-editor-target-element'; editor.contentEditable = 'true';editor.setAttribute('role','textbox');editor.style.cssText='display:block;min-height:30px';
  const oldEditor = wrapper.querySelector('textarea'); const deep = document.createElement('div'); let leaf = deep;
  for(let i=0;i<5;i++){const next=document.createElement('div');leaf.append(next);leaf=next;}
  leaf.append(editor); const toolbar=document.createElement('button');toolbar.textContent='Editor toolbar';leaf.append(toolbar);oldEditor.replaceWith(deep);
  const history=document.createElement('section');history.setAttribute('role','log');history.innerHTML='<div class="fx-Attachment" aria-label="image-check.png"><span role="progressbar">old upload</span><span role="alert">Unsupported file format in old message</span></div>';wrapper.before(history);
  const input=wrapper.querySelector('input'); input.onchange=()=>{
   window.uploads++;
   for(const file of input.files){
    if(mode==='missing') {const dismiss=document.createElement('button');dismiss.className='fx-Attachment__dismissButton';dismiss.setAttribute('aria-label','첨부 파일 제거 '+file.name);wrapper.querySelector('#files').append(dismiss);continue;}
    const card=document.createElement('div');card.className='fx-Attachment bkox';card.id='e07cc706-f2e7-4fe7-9913-054e3a394543';card.setAttribute('aria-label',file.name);card.dataset.overflowItem='true';
    const image=document.createElement('img');image.alt='png';image.setAttribute('aria-hidden','true');image.width=20;image.height=20;image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';card.append(image);
    const dismiss=document.createElement('button');dismiss.className='fx-Attachment__dismissButton';dismiss.setAttribute('aria-label','첨부 파일 제거 '+file.name);card.append(dismiss);
    const progress=document.createElement('span');progress.role='progressbar';progress.textContent='Uploading';card.append(progress);wrapper.querySelector('#files').append(card);
    setTimeout(()=>{progress.remove();if(mode==='error'){const error=document.createElement('span');error.role='alert';error.textContent='Unsupported file format';card.append(error);}},200);
   }
  };
  wrapper.querySelector('#send').onclick=()=>{
   window.sentDuringUpload=!!wrapper.querySelector('[role="progressbar"]');window.sends++;
   window.sentNames=[...wrapper.querySelectorAll('.fx-Attachment')].map(node=>node.getAttribute('aria-label'));
   const id=editor.textContent.match(/Current requestId: ([^\s]+)/)[1];editor.textContent='';wrapper.querySelector('#files').replaceChildren();input.value='';
   const response=document.createElement('pre');response.textContent=JSON.stringify({requestId:id,kind:'done',message:'analyzed'});document.querySelector('#responses').append(response);
  };
 },mode);
 return browser;
}

test('Bebop composer confirms aria-label-only fx-Attachment cards after progress and excludes stale history', async t => {
 const browser=await bebopFixture(t);
 await request(browser,[file('image-check.png')]);
 assert.deepEqual(await browser.page.evaluate(()=>window.sentNames),['image-check.png']);
 assert.equal(await browser.page.evaluate(()=>window.sentDuringUpload),false);
 assert.equal(await browser.page.evaluate(()=>window.sends),1);
});

test('Bebop upload errors block sending and stale history or dismiss buttons cannot confirm a missing card', async t => {
 for(const mode of ['error','missing']) {
  const browser=await bebopFixture(t,mode);
  await assert.rejects(request(browser,[file('image-check.png')]),/첨부 실패|업로드 완료/);
  assert.equal(await browser.page.evaluate(()=>window.sends),0);
 }
});

test('an empty busy composer settles before upload while foreign cards appearing during settling remain protected', async t => {
 for(const foreign of [false,true]) {
  const browser=await fixture(t);const original=browser.writePrompt.bind(browser);
  t.mock.method(browser,'writePrompt',async (...args)=>{
   await original(...args);
   await browser.page.evaluate(foreign=>{
    const spinner=document.createElement('div');spinner.role='progressbar';spinner.textContent='Loading';document.querySelector('form').append(spinner);
    setTimeout(()=>{spinner.remove();if(foreign){const card=document.createElement('div');card.dataset.testid='attachment-card';card.textContent='personal.pdf';document.querySelector('#files').append(card);}},200);
   },foreign);
  });
  if(foreign){await assert.rejects(request(browser,[file('own.png')]),/기존 첨부/);assert.equal(await browser.page.evaluate(()=>window.uploads+window.sends),0);}
  else {await request(browser,[file('own.png')]);assert.equal(await browser.page.evaluate(()=>window.sends),1);}
 }
});

test('OneDrive informational alert allows three ready Bebop documents while Korean failures and configured alerts still block', async t => {
 const disclosure='장치에서 업로드하면 OneDrive로 복사본이 전송됩니다. 업로드 관리';
 const browser=await bebopFixture(t);
 await browser.page.locator('.fai-BebopLiteChatInput').evaluate((wrapper,text)=>{const alert=document.createElement('div');alert.role='alert';alert.textContent=text;wrapper.append(alert);},disclosure);
 const files=[file('report.pdf','application/pdf'),file('notes.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'),file('book.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')];
 await request(browser,files);
 assert.deepEqual(await browser.page.evaluate(()=>window.sentNames),files.map(file=>file.name));
 assert.equal(await browser.page.evaluate(()=>window.sends),1);
 const korean=await bebopFixture(t);
 await korean.page.locator('.fai-BebopLiteChatInput').evaluate(wrapper=>{const alert=document.createElement('div');alert.role='alert';alert.textContent='파일을 업로드할 수 없습니다. 문제가 발생했습니다.';wrapper.append(alert);});
 await assert.rejects(request(korean,[files[0]]),/첨부 오류/);
 assert.equal(await korean.page.evaluate(()=>window.uploads+window.sends),0);
 const custom=await bebopFixture(t);custom.options.attachmentErrorSelector='[role="alert"]';
 await custom.page.locator('.fai-BebopLiteChatInput').evaluate((wrapper,text)=>{const alert=document.createElement('div');alert.role='alert';alert.textContent=text;wrapper.append(alert);},disclosure);
 await assert.rejects(request(custom,[files[0]]),/첨부 오류/);
 assert.equal(await custom.page.evaluate(()=>window.uploads+window.sends),0);
});
