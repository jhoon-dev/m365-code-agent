'use strict';
const { t } = require('./localization');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const os = require('node:os');

function safeMessage(value, profile = '') {
  let text = String(value || t('상세 오류 없음')).split(/\r?\n/)[0];
  if (profile) {
    text = text.split(profile).join(t('<전용 프로필>'));
    const storage = path.dirname(profile);
    if (path.isAbsolute(storage)) text = text.split(storage).join(t('<확장 저장소>'));
  }
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        return url.origin + url.pathname;
      } catch {
        return t('<주소>');
      }
    })
    .slice(0, 600);
}
function connectionFailure(error, stage, options = {}) {
  if (error?.connectionFailure) return error.connectionFailure;
  const text = String(error?.message || error),
    native = text.match(/\b(?:ERR_[A-Z_]+|EACCES|EPERM|ENOTDIR|ENOSPC)\b/)?.[0];
  let code = 'BROWSER_CONNECTION_FAILED',
    hint = t('연결 진단의 실패 단계와 원인 코드를 확인하세요.');
  if (stage === 'url') {
    code = 'BROWSER_URL_INVALID';
    hint = t('m365Agent.copilotUrl에 M365 Copilot의 HTTPS 주소를 설정하세요.');
  } else if (stage === 'profile') {
    code = 'PROFILE_ACCESS_FAILED';
    hint = t(
      'VS Code 확장 저장소에 전용 프로필을 만들 수 없습니다. 폴더 접근 권한과 저장 공간을 확인하세요.',
    );
  } else if (stage === 'panel') {
    code = 'BROWSER_PANEL_FAILED';
    hint = t(
      'VS Code 브라우저 탭을 만들지 못했습니다. 창을 다시 로드하거나 브라우저 표시 위치를 external로 바꿔 확인하세요.',
    );
  } else if (
    /ProcessSingleton|SingletonLock|user data directory.*in use|profile.*(?:in use|locked)/i.test(text)
  ) {
    code = 'PROFILE_IN_USE';
    hint = t(
      '다른 VS Code 창의 M365 Agent가 같은 전용 프로필을 사용 중인지 확인하고 해당 연결을 종료한 뒤 다시 연결하세요.',
    );
  } else if (/executable.*(?:doesn.t exist|not found|does not exist)|distribution.*not found/i.test(text)) {
    code = 'BROWSER_NOT_FOUND';
    hint = t(
      '선택한 Edge 또는 Chrome이 이 PC에 설치되어 있는지 확인하세요. 별도 Playwright 브라우저 설치는 필요하지 않습니다.',
    );
  } else if (/ERR_CERT_/i.test(text)) {
    code = 'BROWSER_CERTIFICATE_FAILED';
    hint = t('인증서 체인을 확인하고 같은 M365 주소가 일반 브라우저에서 열리는지 확인하세요.');
  } else if (/ERR_.*(?:PROXY|TUNNEL)/i.test(text)) {
    code = 'BROWSER_PROXY_FAILED';
    hint = t('프록시·VPN 연결과 일반 브라우저의 M365 접속 상태를 확인하세요.');
  } else if (/EACCES|EPERM|access.*denied|permission denied/i.test(text)) {
    code = 'BROWSER_ACCESS_DENIED';
    hint = t('브라우저 실행·전용 프로필 접근 권한과 보안 설정을 확인하세요.');
  } else if (stage === 'navigation' && (/Timeout|timed out/i.test(text) || error?.name === 'TimeoutError')) {
    code = 'BROWSER_NAVIGATION_TIMEOUT';
    hint = t(
      '브라우저는 실행됐지만 M365 페이지 로딩이 끝나지 않았습니다. 현재 화면을 확인한 뒤 다시 연결하세요.',
    );
  } else if (stage === 'navigation') {
    code = 'BROWSER_NAVIGATION_FAILED';
    hint = t('일반 브라우저에서 M365 주소와 네트워크 연결을 확인한 뒤 다시 연결하세요.');
  }
  return {
    stage,
    code,
    nativeCode: native || null,
    channel: options.channel || 'msedge',
    display: options.embedded ? 'editor' : 'external',
    detail: safeMessage(text, options.profile),
    browserLog:
      stage === 'launch'
        ? text
            .split(/\r?\n/)
            .slice(1)
            .filter(
              (line) =>
                /error|failed|denied|exception|policy|singleton|ERR_|exitCode|signal/i.test(line) &&
                !/<launching>|--user-data-dir/i.test(line),
            )
            .slice(-4)
            .map((line) => safeMessage(line, options.profile))
        : [],
    hint,
  };
}
function connectionError(error, stage, options) {
  const info = connectionFailure(error, stage, options);
  const wrapped = new Error(
    t('M365 브라우저 연결 실패 [{0}] · 단계: {1}\n{2}\n{3}', info.code, info.stage, info.detail, info.hint),
    { cause: error },
  );
  wrapped.code = info.code;
  wrapped.connectionFailure = info;
  return wrapped;
}

async function environmentDiagnostics({
  profile,
  channel = 'msedge',
  embedded = true,
  version,
  vscodeVersion,
}) {
  const report = {
    version,
    vscodeVersion,
    nodeVersion: process.version,
    osRelease: os.release(),
    platform: process.platform,
    architecture: process.arch,
    channel,
    display: embedded ? 'editor' : 'external',
    defaultExecutableFound: null,
    profileWritable: false,
  };
  if (process.platform === 'win32') {
    const suffix =
      channel === 'chrome'
        ? ['Google', 'Chrome', 'Application', 'chrome.exe']
        : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    report.defaultExecutableFound = false;
    for (const base of [
      process.env['PROGRAMFILES(X86)'],
      process.env.PROGRAMFILES,
      process.env.LOCALAPPDATA,
    ].filter(Boolean)) {
      if (
        await fs
          .stat(path.join(base, ...suffix))
          .then((stat) => stat.isFile())
          .catch(() => false)
      ) {
        report.defaultExecutableFound = true;
        break;
      }
    }
  }
  const probe = path.join(profile, '.m365-connection-probe-' + randomUUID());
  let handle;
  try {
    await fs.mkdir(profile, { recursive: true });
    handle = await fs.open(probe, 'wx');
    report.profileWritable = true;
  } catch (error) {
    report.profileError = safeMessage(error.message, profile);
    report.profileWritable = false;
  } finally {
    if (handle) {
      await handle.close();
      await fs.unlink(probe);
    }
  }
  return report;
}
module.exports = { connectionFailure, connectionError, environmentDiagnostics };
