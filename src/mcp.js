// @ts-check
'use strict';
const { t } = require('./localization');
const { createHash, randomUUID } = require('node:crypto');
/** @typedef {import('../types/contracts').McpSession} McpSession */
/** @typedef {{name: string, fingerprint: string}} Selection */
/** @typedef {{name: string, description: string, inputSchema: object, fingerprint: string}} Tool */
/** @typedef {{context: {workspaceState: Pick<import('vscode').Memento, 'get' | 'update'>}, starting?: boolean, switchingBrowser?: boolean, sessionSwitching?: boolean, agent?: {running: boolean} | null, stopRequested?: boolean, pending: {kind: 'command' | 'changes', resolve: (approved: boolean) => void, viewData: import('../types/contracts').HostEvent} | null, post(event: import('../types/contracts').HostEvent): void}} McpHost */

/** Bounded JSON shared by tool metadata and untrusted model arguments.
 * @param {unknown} value @param {number} [maxCharacters] */
function jsonValue(value, maxCharacters = 12000) {
  let entries = 0;
  /** @param {unknown} item @param {number} depth @returns {unknown} */
  const copy = (item, depth) => {
    if (++entries > 2000 || depth > 20) throw new Error(t('MCP JSON 구조가 너무 큽니다.'));
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((child) => copy(child, depth + 1));
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, copy(/** @type {Record<string, unknown>} */ (item)[key], depth + 1)]),
      );
    throw new Error(t('MCP 인자에는 JSON 값만 사용할 수 있습니다.'));
  };
  const result = copy(value, 0);
  if (JSON.stringify(result).length > maxCharacters) throw new Error(t('MCP JSON 크기 제한을 초과했습니다.'));
  return result;
}
/** The public API exposes no trustworthy read-only capability flag. This is a
 * conservative name filter, never a sandbox or proof of a server's behaviour.
 * @param {string} name */
function lookupName(name) {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return (
    words.some((word) =>
      /^(get|list|search|find|fetch|read|lookup|query|resolve|describe|inspect|status|count|retrieve|docs|documentation|snapshot)$/.test(
        word,
      ),
    ) &&
    !words.some((word) =>
      /^(write|edit|delete|remove|rename|move|copy|create|update|patch|replace|execute|exec|run|push|commit|apply|send|upload|insert|upsert|drop|alter)$/.test(
        word,
      ),
    )
  );
}
/** @param {string} message @param {string} code */
function mcpError(message, code) {
  return Object.assign(new Error(message), { code });
}

class McpBridge {
  /** @param {McpHost} host @param {typeof import('vscode')} vscode @param {number} [timeoutMs] */
  constructor(host, vscode, timeoutMs = 120000) {
    this.host = host;
    this.vscode = vscode;
    this.timeoutMs = timeoutMs;
    /** @type {McpSession | undefined} */
    this.active = undefined;
  }
  available() {
    /** @type {Tool[]} */
    const result = [];
    for (const tool of this.vscode.lm?.tools || []) {
      if (!tool.tags.includes('mcp') || tool.name.length > 200 || !lookupName(tool.name)) continue;
      try {
        const schema = jsonValue(tool.inputSchema || { type: 'object', properties: {} }, 5000);
        if (!schema || typeof schema !== 'object' || Array.isArray(schema) || tool.description.length > 4000)
          continue;
        const fingerprint = createHash('sha256')
          .update(JSON.stringify([tool.name, tool.description, schema]))
          .digest('hex');
        result.push({ name: tool.name, description: tool.description, inputSchema: schema, fingerprint });
      } catch {
        /* Oversized or non-JSON schemas are not advertised. */
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  selected() {
    const value = this.host.context.workspaceState?.get('mcp.lookupTools', /** @type {unknown} */ ([]));
    return /** @type {Selection[]} */ (
      Array.isArray(value)
        ? value
            .filter(
              (item) =>
                item &&
                typeof item.name === 'string' &&
                typeof item.fingerprint === 'string' &&
                /^[a-f0-9]{64}$/.test(item.fingerprint),
            )
            .slice(0, 20)
        : []
    );
  }
  async select() {
    if (
      this.host.starting ||
      this.host.switchingBrowser ||
      this.host.sessionSwitching ||
      this.host.agent?.running
    )
      throw new Error(t('진행 중인 작업을 마친 뒤 MCP 도구를 선택하세요.'));
    if (!this.vscode.workspace.isTrusted)
      throw new Error(t('신뢰할 수 있는 프로젝트에서만 MCP를 설정할 수 있습니다.'));
    const tools = this.available(),
      selected = this.selected();
    if (!tools.length) {
      void this.vscode.window.showInformationMessage(
        t(
          '사용 가능한 조회용 MCP 도구가 없습니다. VS Code에서 신뢰할 수 있는 MCP 서버를 연결·시작한 뒤 다시 선택하세요.',
        ),
      );
      return;
    }
    const picks = await this.vscode.window.showQuickPick(
      tools.map((tool) => ({
        label: tool.name,
        detail: tool.description.slice(0, 300),
        picked: selected.some((item) => item.name === tool.name && item.fingerprint === tool.fingerprint),
        tool,
      })),
      {
        canPickMany: true,
        title: t('M365 Agent · 조회용 MCP 도구 선택'),
        placeHolder: t(
          '신뢰하는 조회·검색 도구만 선택하세요. 호출마다 인자를 승인하며 파일 수정은 기존 변경 검토를 사용합니다.',
        ),
      },
    );
    if (!picks) return;
    if (picks.length > 20) throw new Error(t('MCP 도구는 최대 20개까지 선택할 수 있습니다.'));
    if (this.host.starting || this.host.agent?.running || !this.vscode.workspace.isTrusted)
      throw new Error(t('작업이 시작되었거나 신뢰 상태가 변경되었습니다. MCP 도구를 다시 선택하세요.'));
    await this.host.context.workspaceState.update(
      'mcp.lookupTools',
      picks.map((item) => ({ name: item.tool.name, fingerprint: item.tool.fingerprint })),
    );
    this.host.post({
      type: 'status',
      text: t('조회용 MCP 도구 {0}개 선택됨 · 실행은 매번 승인합니다.', picks.length),
    });
  }
  /** @param {string} root @param {string} mode @returns {McpSession | undefined} */
  createSession(root, mode) {
    if (mode !== 'agent' || !this.vscode.workspace.isTrusted || !this.vscode.lm?.invokeTool) return;
    const selected = this.selected();
    const tools = new Map(
      this.available()
        .filter((tool) =>
          selected.some((item) => item.name === tool.name && item.fingerprint === tool.fingerprint),
        )
        .map((tool) => [tool.name, tool]),
    );
    if (!tools.size) return;
    let stopped = false;
    /** @type {string | undefined} */
    let pendingToken;
    /** @type {(() => void) | undefined} */
    let cancelInvocation;
    const advertised = new Set(),
      failed = new Set();
    /** @param {string} name */
    const current = (name) => {
      const tool = tools.get(name);
      if (stopped || this.host.stopRequested)
        throw mcpError(t('MCP 도구 실행을 중지했습니다.'), 'MCP_CANCELLED');
      if (
        !this.vscode.workspace.isTrusted ||
        !tool ||
        !this.selected().some((item) => item.name === name && item.fingerprint === tool.fingerprint) ||
        !this.available().some((item) => item.name === name && item.fingerprint === tool.fingerprint)
      )
        throw new Error(t('허용되지 않았거나 정의가 변경된 MCP 도구입니다. 도구를 다시 선택하세요.'));
      return tool;
    };
    /** @type {McpSession} */
    const session = {
      list: (maxCharacters, offset = 0) => {
        if (!Number.isInteger(offset) || offset < 0 || offset > tools.size)
          throw new Error(t('MCP 목록 offset은 도구 수 범위의 정수여야 합니다.'));
        const result = {
          tools: /** @type {{name: string, description: string}[]} */ ([]),
          truncated: false,
          nextOffset: /** @type {number | null} */ (null),
        };
        for (const tool of [...tools.values()].slice(offset)) {
          current(tool.name);
          result.tools.push({ name: tool.name, description: tool.description.slice(0, 200) });
          const next = offset + result.tools.length;
          result.nextOffset = next < tools.size ? next : null;
          if (JSON.stringify(result).length > maxCharacters) {
            result.tools.pop();
            result.truncated = true;
            result.nextOffset = offset + result.tools.length;
            break;
          }
          advertised.add(tool.name);
        }
        if (!result.tools.length && offset < tools.size)
          throw new Error(t('MCP 도구 목록을 전달할 문맥 예산이 부족합니다.'));
        return result;
      },
      info: (name, maxCharacters) => {
        const tool = current(name);
        const result = { name, description: tool.description.slice(0, 300), inputSchema: tool.inputSchema };
        if (JSON.stringify(result).length > maxCharacters)
          throw new Error(t('MCP 도구 스키마가 현재 문맥 예산보다 큽니다. 요청 예산을 늘리세요.'));
        advertised.add(name);
        return result;
      },
      invoke: async (name, input, maxCharacters) => {
        current(name);
        if (!advertised.has(name))
          throw new Error(t('먼저 mcp_list_tools 또는 mcp_tool_info로 제공된 도구를 확인하세요.'));
        const safeInput = /** @type {Record<string, unknown>} */ (jsonValue(input));
        if (!safeInput || typeof safeInput !== 'object' || Array.isArray(safeInput))
          throw new Error(t('MCP input은 JSON 객체여야 합니다.'));
        const signature = JSON.stringify([name, safeInput]);
        if (failed.has(signature))
          throw new Error(
            t('실패하거나 거절된 같은 MCP 호출은 이 요청에서 자동으로 다시 실행하지 않습니다.'),
          );
        if (this.host.pending) throw new Error(t('다른 승인 요청을 먼저 처리하세요.'));
        const viewData = {
          type: 'commandApproval',
          approvalKind: 'mcp',
          tool: name,
          command: JSON.stringify(safeInput, null, 2),
          root,
          changedFiles: [],
          token: randomUUID(),
        };
        pendingToken = viewData.token;
        const approved = await new Promise((resolve) => {
          this.host.pending = { kind: 'command', resolve, viewData };
          this.host.post(viewData);
        });
        const pending = /** @type {McpHost['pending']} */ (this.host.pending);
        if (pending?.viewData.token === viewData.token) this.host.pending = null;
        pendingToken = undefined;
        this.host.post({ type: 'approvalClosed' });
        current(name);
        if (!approved) {
          failed.add(signature);
          return {
            approved: false,
            message: t('사용자가 MCP 실행을 거절했습니다. 같은 호출을 다시 요청하지 마세요.'),
          };
        }
        const cancellation = new this.vscode.CancellationTokenSource();
        /** @type {NodeJS.Timeout | undefined} */
        let timer;
        const interrupted = new Promise((_, reject) => {
          cancelInvocation = () => {
            cancellation.cancel();
            reject(
              mcpError(
                t('MCP 실행을 중지했습니다. 원격 도구의 취소 완료는 보장하지 않습니다.'),
                'MCP_CANCELLED',
              ),
            );
          };
          timer = setTimeout(() => {
            stopped = true;
            cancellation.cancel();
            reject(
              mcpError(
                t(
                  'MCP 실행 시간이 초과됐습니다. 중지 신호를 보냈으며 실행 결과가 확인되지 않아 작업을 종료합니다.',
                ),
                'MCP_UNCERTAIN',
              ),
            );
          }, this.timeoutMs);
        });
        try {
          const result = await Promise.race([
            this.vscode.lm.invokeTool(
              name,
              { input: safeInput, toolInvocationToken: undefined },
              cancellation.token,
            ),
            interrupted,
          ]);
          current(name);
          if (
            !result ||
            typeof result !== 'object' ||
            !('content' in result) ||
            !Array.isArray(result.content)
          )
            throw new Error(t('MCP 도구 결과 형식이 올바르지 않습니다.'));
          let output = '',
            omittedParts = Math.max(0, result.content.length - 100),
            truncated = false;
          for (const part of result.content.slice(0, 100)) {
            if (!(part instanceof this.vscode.LanguageModelTextPart)) {
              omittedParts++;
              continue;
            }
            const room = Math.max(0, maxCharacters - output.length - 160);
            if (part.value.length + 1 > room) truncated = true;
            if (room > 0) output += (output ? '\n' : '') + part.value.slice(0, room);
          }
          const observation = {
            approved: true,
            output,
            truncated: truncated || omittedParts > 0,
            omittedParts,
          };
          while (JSON.stringify(observation).length > maxCharacters && observation.output.length) {
            observation.output = observation.output.slice(0, Math.floor(observation.output.length / 2));
            observation.truncated = true;
          }
          return observation;
        } catch (error) {
          failed.add(signature);
          throw error;
        } finally {
          clearTimeout(timer);
          cancelInvocation = undefined;
          cancellation.dispose();
        }
      },
      cancel: () => {
        stopped = true;
        cancelInvocation?.();
        if (pendingToken && this.host.pending?.viewData.token === pendingToken) {
          this.host.pending.resolve(false);
          this.host.pending = null;
          this.host.post({ type: 'approvalClosed' });
        }
      },
      dispose: () => {
        session.cancel();
        if (this.active === session) this.active = undefined;
      },
    };
    this.active = session;
    return session;
  }
  cancel() {
    this.active?.cancel();
  }
}
module.exports = { McpBridge, jsonValue, lookupName };
