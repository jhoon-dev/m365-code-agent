// @ts-check
'use strict';
const { buildPrompt, newId, normalizeToolCall, toolCallLimit } = require('./protocol');
const { inspectProject } = require('./project');
const { TaskProgress } = require('./task-progress');
const { commandEnvironment } = require('./terminal');
/** @param {string | undefined} value @param {string} field @returns {string} */
function requiredText(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field} 문자열이 필요합니다.`);
  return value;
}

class CodingAgent {
  /** @param {import('../types/contracts').AgentOptions} options */
  constructor({
    store,
    transport,
    approveAndApply,
    runCommand,
    emit,
    conversation = [],
    mode = 'agent',
    intent,
    autoApprove = false,
    unlimitedRounds = false,
    maxRounds = 100,
    maxPromptCharacters = 120000,
    initialPaths,
    attachments = [],
    attachmentContext = [],
    mcp,
  }) {
    this.store = store;
    this.transport = transport;
    this.approveAndApply = approveAndApply;
    this.runCommand = runCommand;
    this.emit = emit;
    this.conversation = conversation;
    this.mode = mode;
    this.intent = intent;
    this.autoApprove = autoApprove === true;
    this.unlimitedRounds = unlimitedRounds === true;
    this.maxRounds = Number.isFinite(maxRounds) ? Math.max(1, Math.min(500, Math.floor(maxRounds))) : 100;
    this.maxPromptCharacters = maxPromptCharacters;
    this.initialPaths = initialPaths;
    this.attachments = attachments;
    this.attachmentContext = attachmentContext;
    this.mcp = mcp;
    this.cancelled = false;
    this.running = false;
  }
  async stop() {
    this.cancelled = true;
    this.mcp?.cancel();
    await this.transport.stop();
  }
  /** @param {string} task */
  async run(task, extraContext = '') {
    if (this.running) throw new Error('이미 진행 중인 작업이 있습니다.');
    if (typeof task !== 'string' || !task.trim() || task.length > 8000)
      throw new Error('요청은 1~8,000자로 입력하세요.');
    this.running = true;
    this.cancelled = false;
    /** @type {import('../types/contracts').HistoryEntry[]} */
    const history = this.conversation
      .slice(-12)
      .map((event) => ({ role: event.role, text: event.text.slice(0, 4000) }));
    let promptBudget = Math.min(
      this.maxPromptCharacters,
      this.transport.promptCharacterLimit ?? this.maxPromptCharacters,
    );
    let appliedFiles = 0;
    const progress = new TaskProgress();
    let attachmentsSubmitted = false;
    try {
      this.emit({ type: 'message', role: 'user', text: task });
      const project = await inspectProject(
        this.store,
        task,
        promptBudget,
        this.emit,
        () => this.cancelled,
        this.initialPaths,
      );
      const files = project.files;
      history.push(project.history);
      if (project.discovered && !project.read && !project.inspected)
        throw new Error(
          '프로젝트 파일 본문을 읽지 못했습니다. 작업 기록의 파일별 오류를 확인하세요. 분석이나 수정이 완료된 것으로 처리하지 않았습니다.',
        );
      this.emit({
        type: 'message',
        role: 'system',
        text: `프로젝트 ${require('node:path').basename(this.store.root)} · ${project.discovered}개 파일 발견 · ${project.read}개 본문을 먼저 읽었습니다.${project.inspected ? ' 파일 정보·해시 ' + project.inspected + '개 확인.' : ''}${this.mode !== 'agent' ? ' 이번 요청은 분석·계획으로 처리하며 파일을 수정하지 않습니다.' : ''}`,
      });
      for (let round = 1; this.unlimitedRounds || round <= this.maxRounds; round++) {
        if (this.cancelled) throw new Error('작업을 중지했습니다.');
        const id = newId();
        const limit = this.unlimitedRounds ? null : this.maxRounds;
        this.emit({
          type: 'progress',
          round,
          total: limit,
          remaining: this.unlimitedRounds ? null : this.maxRounds - round,
          unlimited: this.unlimitedRounds,
        });
        this.emit({
          type: 'status',
          text: `요청 ${round}회 · ${this.unlimitedRounds ? '무제한' : '안전 한도 ' + this.maxRounds + '회'} · Copilot 요청 준비`,
        });
        /** @type {import('../types/contracts').AgentReply | undefined} */
        let reply;
        for (let attempt = 0; attempt < 3; attempt++) {
          const prompt = buildPrompt({
            id,
            task,
            workspace: require('node:path').basename(this.store.root),
            environment: commandEnvironment(this.store.root),
            files,
            history,
            extraContext,
            attachments: this.attachmentContext,
            mode: this.mode,
            intent: this.intent,
            autoApprove: this.autoApprove,
            hasMcp: Boolean(this.mcp),
            progress: progress.snapshot(round, limit, appliedFiles),
            maxCharacters: promptBudget,
          });
          try {
            reply = await this.transport.request(
              prompt,
              id,
              (text) => this.emit({ type: 'status', text }),
              undefined,
              { attachments: attachmentsSubmitted ? [] : this.attachments },
            );
            attachmentsSubmitted = true;
            break;
          } catch (error) {
            if (
              this.cancelled ||
              attempt === 2 ||
              error.code !== 'PROMPT_LIMIT' ||
              error.notSubmitted !== true ||
              !Number.isFinite(error.maxCharacters) ||
              error.maxCharacters < 2000 ||
              error.maxCharacters >= prompt.length
            )
              throw error;
            promptBudget = Math.min(promptBudget, error.maxCharacters);
            this.emit({
              type: 'status',
              text: `Copilot 입력 한도 ${promptBudget.toLocaleString()}자에 맞춰 문맥을 줄이고 있습니다. 아직 전송하지 않았습니다.`,
            });
          }
        }
        if (this.cancelled) throw new Error('작업을 중지했습니다.');
        if (!reply) throw new Error('Copilot 응답을 받지 못했습니다.');
        if (reply.kind === 'done') {
          this.emit({ type: 'message', role: 'assistant', text: reply.message });
          this.emit({
            type: 'message',
            role: 'system',
            text: `이번 요청에서 실제 적용한 파일: ${appliedFiles}개${appliedFiles === 0 ? ' · 파일 변경은 발생하지 않았습니다.' : ''}`,
          });
          return { status: 'done', message: reply.message, appliedFiles };
        }
        if (reply.kind === 'tools') {
          if (reply.deferred?.length)
            this.emit({
              type: 'status',
              text: '도구 요청을 먼저 처리합니다. 함께 온 수정안은 도구 결과 확인 뒤 다시 받습니다.',
            });
          /** @type {import('../types/contracts').ToolObservation[]} */
          const observations = [];
          let fresh = false;
          const batchLimit = toolCallLimit(promptBudget);
          for (const [index, rawCall] of reply.calls.entries()) {
            const call = normalizeToolCall(rawCall);
            if (this.cancelled) throw new Error('작업을 중지했습니다.');
            if (index >= batchLimit) {
              observations.push({
                call,
                error: `이번 요청의 도구 예산은 ${batchLimit}개입니다. 이 호출은 실행하지 않았습니다. 결과를 확인한 뒤 다음 요청에서 다시 호출하세요.`,
              });
              continue;
            }
            const toolId = newId();
            const label = `${call.name} · ${call.path || call.query || call.command || call.tool || '프로젝트'}`;
            this.emit({ type: 'tool', id: toolId, label, state: 'running' });
            try {
              /** @type {import('../types/contracts').ToolResult} */
              let result;
              const resultBudget = Math.max(
                256,
                Math.min(6000, Math.floor((promptBudget - 3500) / Math.min(batchLimit, reply.calls.length))),
              );
              if (call.name === 'read_file')
                result = await this.store.readFile(requiredText(call.path, 'path'), {
                  startLine: call.startLine,
                  startColumn: call.startColumn,
                  lineCount: call.lineCount,
                  maxCharacters: resultBudget,
                });
              else if (call.name === 'file_info')
                result = await this.store.fileInfo(requiredText(call.path, 'path'), () => this.cancelled);
              else if (call.name === 'folder_info')
                result = await this.store.folderInfo(requiredText(call.path, 'path'), () => this.cancelled);
              else if (call.name === 'list_files') result = await this.store.listFiles(call.limit, call.path);
              else if (call.name === 'search_text')
                result = await this.store.search(
                  requiredText(call.query, 'query'),
                  call.paths,
                  () => this.cancelled,
                );
              else if (call.name === 'search_code')
                result = await this.store.searchCode(
                  requiredText(call.query, 'query'),
                  call.paths,
                  () => this.cancelled,
                );
              else if (call.name === 'run_command') {
                if (this.mode !== 'agent' || !this.runCommand)
                  throw new Error(
                    '이번 요청은 읽기 전용 분석입니다. 명령 실행이 필요하면 실행할 작업을 요청하세요.',
                  );
                result = await this.runCommand(requiredText(call.command, 'command'));
              } else if (['mcp_list_tools', 'mcp_tool_info', 'mcp_call'].includes(call.name)) {
                if (this.mode !== 'agent' || !this.mcp)
                  throw new Error('MCP 실행은 조회용 도구를 선택한 Agent 요청에서만 사용할 수 있습니다.');
                if (call.name === 'mcp_list_tools') result = this.mcp.list(resultBudget, call.offset);
                else if (call.name === 'mcp_tool_info')
                  result = this.mcp.info(requiredText(call.tool, 'tool'), resultBudget);
                else {
                  if (!call.input) throw new Error('MCP input 객체가 필요합니다.');
                  result = await this.mcp.invoke(requiredText(call.tool, 'tool'), call.input, resultBudget);
                }
              } else throw new Error('지원하지 않는 도구입니다.');
              if (Array.isArray(result.files))
                while (JSON.stringify(result).length > resultBudget && result.files.length > 1) {
                  result.files.pop();
                  result.truncated = true;
                }
              if (Array.isArray(result.matches))
                while (JSON.stringify(result).length > resultBudget && result.matches.length > 1) {
                  result.matches.pop();
                  result.truncated = true;
                }
              if (typeof result.output === 'string' && result.output.length > resultBudget) {
                result.output = result.output.slice(-resultBudget);
                result.truncated = true;
              }
              if (JSON.stringify(result).length > 22000)
                throw new Error(
                  '파일 또는 검색 결과가 너무 큽니다. 더 작은 파일이나 검색 범위를 요청하세요.',
                );
              observations.push({ call, result });
              fresh = progress.observe(call, result) || fresh;
              const failed = result.exitCode !== undefined && result.exitCode !== 0;
              this.emit({
                type: 'tool',
                id: toolId,
                label,
                state: failed ? 'error' : 'done',
                detail:
                  typeof result.content === 'string'
                    ? `${result.content.length.toLocaleString()}자 읽음 · ${result.startLine}~${result.endLine}줄`
                    : ['file_info', 'folder_info'].includes(call.name) && result.size !== undefined
                      ? `${result.size.toLocaleString()} bytes · 파일 해시 확인`
                      : result.approved === false
                        ? '실행 거절됨'
                        : result.exitCode !== undefined
                          ? `종료 코드 ${result.exitCode}${result.timedOut ? ' · 시간 초과' : ''}`
                          : undefined,
              });
            } catch (error) {
              if (this.cancelled || ['MCP_CANCELLED', 'MCP_UNCERTAIN'].includes(error.code)) throw error;
              observations.push({ call, error: error.message });
              fresh = progress.failure(error) || fresh;
              this.emit({ type: 'tool', id: toolId, label, state: 'error', detail: error.message });
            }
          }
          history.push({
            kind: 'tool_results',
            observations,
            ...(reply.deferred?.length
              ? {
                  note: 'Premature changes/done in the same response were NOT applied. Re-propose needed changes using these actual results and hashes; return done only after local outcomes.',
                }
              : {}),
          });
          progress.finishRound(fresh, history, appliedFiles);
          continue;
        }
        if (reply.kind === 'changes') {
          let fresh = false;
          try {
            if (this.mode !== 'agent')
              throw new Error(
                '이번 요청은 분석·계획이므로 파일을 수정하지 않습니다. 설명 또는 계획으로 답변하세요.',
              );
            const changes = (await this.store.prepareChanges(reply.files, () => this.cancelled)).filter(
              (change) =>
                change.action === 'create' ||
                change.action === 'delete' ||
                change.content !== change.original,
            );
            if (!changes.length) {
              /** @type {Error & { code?: string }} */
              const error = new Error(
                '수정안이 현재 파일과 동일합니다. 새 변경 없이 완료한 파일을 다시 적용하지 마세요.',
              );
              error.code = 'UNCHANGED_CHANGES';
              throw error;
            }
            this.emit({
              type: 'message',
              role: 'assistant',
              text: reply.summary || '파일 수정안을 준비했습니다.',
            });
            if (!this.approveAndApply) throw new Error('파일 변경 적용기가 연결되지 않았습니다.');
            const applied = await this.approveAndApply(changes, reply.summary || '파일 수정안');
            if (applied) {
              appliedFiles += changes.length;
              fresh = true;
              progress.lastError = undefined;
              progress.recordChanges(changes);
            }
            if (this.cancelled) throw new Error('작업을 중지했습니다.');
            history.push({
              kind: 'change_result',
              applied,
              files: changes.map((change) => change.path),
              deletedFiles: changes
                .filter((change) => change.action === 'delete')
                .map((change) => change.path),
              tests: 'not_run',
            });
            if (!applied) return { status: 'rejected' };
          } catch (error) {
            if (this.cancelled || ['PARTIAL_DELETE', 'PARTIAL_CHANGE'].includes(error.code)) throw error;
            this.emit({ type: 'message', role: 'system', text: `수정안 검증: ${error.message}` });
            fresh = progress.failure(error);
            history.push({
              kind: 'change_error',
              error: error.message,
              nextStep:
                'Correct the proposal using actual read_file, file_info (files) or folder_info (folders) evidence. Existing files need read evidence; create requires baseHash=null and must not overwrite an existing file.',
            });
            if (this.mode === 'agent') {
              const paths = [
                ...new Set(
                  (Array.isArray(reply.files) ? reply.files : [])
                    .filter((file) => file && typeof file.path === 'string')
                    .map((file) => file.path),
                ),
              ]
                .filter((file) => !progress.repaired.has(file))
                .slice(0, 2);
              /** @type {import('../types/contracts').ToolObservation[]} */
              const observations = [];
              for (const path of paths) {
                if (this.cancelled) throw new Error('작업을 중지했습니다.', { cause: error });
                progress.repaired.add(path);
                const id = newId();
                this.emit({ type: 'tool', id, label: '수정 대상 자동 확인 · ' + path, state: 'running' });
                const deleting = reply.files.some((file) => file?.path === path && file.action === 'delete');
                const call = deleting
                  ? { name: 'file_info', path }
                  : { name: 'read_file', path, startLine: 1, lineCount: 120 };
                try {
                  /** @type {import('../types/contracts').ToolResult} */
                  const result = deleting
                    ? await this.store.deletionInfo(path, () => this.cancelled)
                    : await this.store.readFile(path, {
                        startLine: 1,
                        lineCount: 120,
                        maxCharacters: Math.max(
                          256,
                          Math.min(3000, Math.floor((promptBudget - 4000) / paths.length)),
                        ),
                      });
                  if (deleting) call.name = result.kind === 'directory' ? 'folder_info' : 'file_info';
                  observations.push({ call, result });
                  fresh = progress.observe(call, result) || fresh;
                  this.emit({
                    type: 'tool',
                    id,
                    label: '수정 대상 자동 확인 · ' + path,
                    state: 'done',
                    detail: `${deleting ? result.size + ' bytes' : (result.content || '').length + '자'} · 실제 hash 확인. 검증한 새 수정안을 요청합니다.`,
                  });
                } catch (readError) {
                  observations.push({ call, error: readError.message });
                  this.emit({
                    type: 'tool',
                    id,
                    label: '수정 대상 자동 확인 · ' + path,
                    state: 'error',
                    detail: readError.message,
                  });
                }
              }
              if (observations.length)
                history.push({ kind: 'tool_results', origin: 'proposal_validation_repair', observations });
            }
          }
          progress.finishRound(fresh, history, appliedFiles);
        }
      }
      throw new Error(
        `안전 한도 ${this.maxRounds}회에 도달해 중지했습니다. 실제 적용한 파일: ${appliedFiles}개. 적용 내역은 유지됩니다. 필요한 작업을 이어서 요청하거나 m365Agent.maxRounds를 조정하세요.`,
      );
    } finally {
      this.attachments = [];
      this.mcp?.dispose();
      this.running = false;
      this.emit({ type: 'idle' });
    }
  }
}
module.exports = { CodingAgent };
