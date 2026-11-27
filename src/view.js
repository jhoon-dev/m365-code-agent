'use strict';
const { t, getLanguage, localizationScripts } = require('./localization');
function icon(name) {
  const shapes = {
    add: '<path d="M12 5v14M5 12h14"/>',
    history: '<path d="M3 11a9 9 0 1 1 2.6 7.3M3 4v7h7M12 7v5l3 2"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    sync: '<path d="M20 7h-5m5 0V2M4 17h5m-5 0v5M4 8a8 8 0 0 1 13-5l3 4M4 17l3 4a8 8 0 0 0 13-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shapes[name]}</svg>`;
}
function renderWebview({ nonce, cspSource, resource }) {
  return `<!doctype html>
<html lang="${getLanguage()}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('view.css')}">
</head>
<body>
<header>
<span class="brand">M365 <b>Code Agent</b>
</span>
<nav class="toolbar header-actions" aria-label="${t('대화 작업')}">
<button id="newChat" class="icon-button" title="${t('새 대화')}" aria-label="${t('새 대화')}">${icon('add')}</button>
<button id="history" class="icon-button" title="${t('대화 기록')}" aria-label="${t('대화 기록')}" aria-controls="historyPanel" aria-expanded="false">${icon('history')}</button>
<button id="more" class="icon-button" title="${t('더 보기')}" aria-label="${t('더 보기')}" aria-controls="moreMenu" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
</nav>
<div id="moreMenu" role="menu" hidden>
<button id="showBrowser" role="menuitem">${t('Copilot 브라우저 열기')}</button>
<button id="editorBrowser" role="menuitem">${t('VS Code 브라우저로 전환')}</button>
<button id="syncWeb" role="menuitem">${icon('sync')}${t('웹 대화 동기화')}</button>
<button id="checkWorkspace" role="menuitem" title="${t('M365 없이 코드 읽기와 임시 파일 쓰기·삭제를 점검합니다.')}">${t('프로젝트 점검')}</button>
<button id="diagnostics" role="menuitem">${icon('info')}${t('연결 진단')}</button>
<button id="mcpTools" role="menuitem">${t('조회용 MCP 도구 선택')}</button>
<button id="languageSettings" role="menuitem">${t('언어 설정')}</button>
</div>
</header>
<section id="historyPanel" hidden aria-label="${t('대화 기록')}">
<div class="history-heading">
<h2>${t('대화 기록')}</h2>
<button id="closeHistory" class="icon-button" title="${t('기록 닫기')}" aria-label="${t('기록 닫기')}">${icon('close')}</button>
</div>
<p class="history-note">${t('이 작업 영역에 저장한 VS Code 기록입니다. 삭제해도 Copilot 웹 대화와 프로젝트 파일은 유지됩니다.')}</p>
<input id="historySearch" type="search" placeholder="${t('대화 제목 검색')}" aria-label="${t('대화 제목 검색')}">
<div id="sessionList" role="list">
</div>
<button id="deleteAllSessions" class="danger-button">${t('모든 VS Code 기록 삭제')}</button>
</section>
<div class="context-bar">
<span id="workspaceName" title="${t('프로젝트 경로')}">${t('프로젝트 미확인')}</span>
<details id="readingOptions">
<summary>${t('읽기 설정')}</summary>
<div class="reading-options">
<div class="font-controls">
<span>${t('글자 크기')}</span>
<button id="fontSmaller" type="button" aria-label="${t('글자 작게')}">A−</button>
<output id="fontSize" aria-live="polite">14</output>
<button id="fontLarger" type="button" aria-label="${t('글자 크게')}">A+</button>
</div>
<label>
<input id="wrapCode" type="checkbox" checked> ${t('코드 줄바꿈')}</label>
</div>
</details>
</div>
<div class="conversation">
<main id="messages" aria-label="${t('대화')}">
</main>
<button id="jumpToLatest" type="button" hidden>${t('↓ 최신 응답')}</button>
<div id="welcome">
<h2>${t('어떤 작업을 할까요?')}</h2>
<p>${t('코드를 살펴보고, 계획하고, 함께 수정하세요.')}</p>
<button class="suggestion" data-prompt="${t('이 프로젝트의 구조와 실행 방법을 설명해줘.')}">${t('프로젝트 살펴보기')}</button>
<button class="suggestion" data-prompt="${t('현재 파일을 검토하고 버그 가능성과 테스트 계획을 알려줘.')}">${t('코드 검토 계획')}</button>
</div>
</div>
<footer>
<div id="roundProgress" hidden aria-live="polite">
</div>
<div id="status" role="status">${t('Copilot 연결 후 회사 계정으로 로그인하세요.')}</div>
<section id="changes" hidden>
<strong id="changeTitle">${t('변경 검토')}</strong>
<p id="reviewReason">
</p>
<div id="changeFiles">
</div>
<div class="toolbar">
<button id="apply">${t('적용')}</button>
<button id="reject">${t('거절')}</button>
</div>
</section>
<section id="approval" hidden>
<strong id="approvalTitle">${t('명령 실행 승인')}</strong>
<p id="commandRoot">
</p>
<p id="approvalNote" hidden></p>
<pre id="commandText">
</pre>
<div id="commandChanges">
</div>
<div class="toolbar">
<button id="approveCommand">${t('이번 명령 실행')}</button>
<button id="rejectCommand">${t('거절')}</button>
</div>
</section>
<div id="checkpoint" hidden>
<span>${t('마지막 파일 변경')}</span>
<button id="undo">${t('되돌리기')}</button>
</div>
<form id="form">
<div id="attachments">
</div>
<label class="sr-only" for="task">${t('개발 요청')}</label>
<textarea id="task" rows="2" maxlength="8000" placeholder="${t('질문하거나 코드 수정을 요청하세요')}">
</textarea>
<div class="composer-tools">
<div class="toolbar">
<button id="attach" type="button" title="${t('프로젝트 파일 첨부')}">${t('＋ 파일')}</button>
<button id="attachLocal" type="button" title="${t('전송 시 원본 파일을 M365에 업로드합니다. 동영상은 3개 시점의 화면을 분석하며 음성은 제외합니다.')}">${t('이미지·문서·동영상')}</button>
<button id="connect" type="button" title="${t('Copilot 연결 / 로그인')}">${t('연결')}</button>
</div>
<div>
<button id="stop" type="button" hidden>${t('■ 중지')}</button>
<button id="run" type="submit" title="${t('전송 (Enter)')}">↑</button>
</div>
</div>
<details id="composerOptions">
<summary>${t('모델 · 첨부 · 승인')} <span class="option-badges">
<span id="roundMode" hidden>${t('무제한')}</span>
<span id="approvalMode">
</span>
</span>
</summary>
<div class="model-tools">
<label class="sr-only" for="model">${t('M365 모델')}</label>
<select id="model" title="${t('현재 M365 계정에서 선택 가능한 모델')}">
<option value="">${t('M365 웹의 현재 모델')}</option>
</select>
<button id="refreshModels" type="button" title="${t('웹 모델 목록 불러오기')}">${t('모델 불러오기')}</button>
</div>
<div class="preferences">
<label>
<input type="checkbox" id="includeEditor" checked> ${t('현재 파일')}</label>
<label title="${t('끄면 일반 파일은 자동 적용합니다. 실행 설정과 명령은 계속 승인이 필요합니다.')}">
<input type="checkbox" id="review" checked> ${t('변경 승인')}</label>
<span id="webSync" title="${t('연결된 웹 대화를 5초마다 확인합니다.')}">M365 Copilot</span>
</div>
<label class="request-limit-option">
<input type="checkbox" id="unlimitedRounds" aria-describedby="unlimitedRoundsHint"> ${t('요청 횟수 무제한')}</label>
<p id="unlimitedRoundsHint" class="option-note">${t('켜면 요청 횟수 한도만 해제합니다. 반복 감지·중지·승인 설정은 유지합니다.')}</p>
<label class="auto-approve-option">
<input type="checkbox" id="autoApprove" aria-describedby="autoApproveHint"> ${t('승인 없이 진행')}</label>
<p id="autoApproveHint" class="option-note">${t('켜면 파일 변경·실행 설정·터미널 명령을 자동 승인합니다.')}
${t('명령은 사용자 권한으로 실행되며 프로젝트 밖 파일에도 영향을 줄 수 있습니다. 명령의 변경은 되돌리기에 포함되지 않습니다.')}</p>
</details>
</form>
<p class="hint">${t('Enter 전송 · Shift+Enter 줄바꿈')}</p>
</footer>
${localizationScripts(nonce, resource)}
<script nonce="${nonce}" src="${resource('reading.js')}">
</script>
<script nonce="${nonce}" src="${resource('view.js')}">
</script>
</body>
</html>`;
}
module.exports = { renderWebview };
