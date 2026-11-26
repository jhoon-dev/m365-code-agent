'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { validateCopilotUrl } = require('./browser');
const { conversationUrl } = require('./web-history');

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const markerPattern = () =>
  new RegExp(
    `^\\[m365-chat:(${uuid}):(${uuid})\\]: https://m365\\.cloud\\.microsoft/[ \\t]*(?:\\r?\\n\\r?\\n|\\r?\\n|$)`,
    'gm',
  );
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sessionError = (text) => Object.assign(new Error(text), { code: 'MODEL_CONVERSATION_UNAVAILABLE' });

function cleanText(text) {
  return text.replace(markerPattern(), '');
}
function cleanMessages(messages) {
  return messages.map((message) =>
    message.role !== 'assistant'
      ? message
      : {
          ...message,
          content: message.content.map((part) =>
            part.type === 'text' ? { ...part, text: cleanText(part.text) } : part,
          ),
        },
  );
}
function webUrl(value) {
  const info = conversationUrl(validateCopilotUrl(value));
  if (!info.restorable)
    throw sessionError('웹 대화 주소를 복원할 수 없습니다. 새 웹 대화를 자동으로 만들지 않았습니다.');
  return info.url;
}

class ModelConversations {
  constructor(state) {
    this.state = state;
    this.records = new Map();
    this.references = new Map();
    this.invalid = false;
    const saved = state?.get('modelWebConversations.v1', []) || [];
    if (!Array.isArray(saved) || saved.length > 1000) this.invalid = true;
    else
      for (const value of saved) {
        try {
          if (
            !value ||
            !new RegExp(`^${uuid}$`).test(value.id) ||
            !/^[a-f0-9]{64}$/.test(value.scope) ||
            typeof value.started !== 'boolean' ||
            this.records.has(value.id) ||
            (value.explicitKey !== undefined && !/^[a-f0-9]{64}$/.test(value.explicitKey)) ||
            !Array.isArray(value.turns) ||
            !Array.isArray(value.calls)
          )
            throw Error('invalid');
          if (
            value.turns.length > 64 ||
            value.calls.length > 128 ||
            value.turns.some((turn) => !new RegExp(`^${uuid}$`).test(turn))
          )
            throw Error('invalid');
          if (
            value.calls.some(
              (call) => !/^m365_[a-f0-9]{32}$/.test(call.id) || !value.turns.includes(call.turn),
            )
          )
            throw Error('invalid');
          // An anonymous record without an emitted turn cannot identify a Chat.
          if (!value.explicitKey && !value.turns.length) continue;
          this.records.set(value.id, {
            id: value.id,
            scope: value.scope,
            started: value.started,
            ...(value.explicitKey ? { explicitKey: value.explicitKey } : {}),
            url: value.url ? webUrl(value.url) : null,
            turns: [...value.turns],
            calls: [...value.calls],
          });
        } catch {
          this.invalid = true;
        }
      }
  }

  resolve(messages, options, endpoint) {
    if (this.invalid)
      throw sessionError(
        '저장된 웹 대화 매핑을 읽지 못했습니다. 다른 대화로 연결하거나 새 웹 대화를 자동 생성하지 않았습니다.',
      );
    const scope = hash(validateCopilotUrl(endpoint));
    const explicit = options.modelOptions?.m365ConversationId;
    if (explicit !== undefined && (typeof explicit !== 'string' || !explicit.trim() || explicit.length > 200))
      throw sessionError('m365ConversationId는 1~200자의 대화별 고유 문자열이어야 합니다.');
    const explicitKey = explicit === undefined ? undefined : hash(explicit);
    const matches = [];
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type === 'text')
          for (const match of part.text.matchAll(markerPattern())) {
            const record = this.records.get(match[1]);
            if (!record)
              throw sessionError(
                '이 VS Code 대화의 웹 연결 정보를 찾지 못했습니다. 새 웹 대화를 자동으로 만들지 않았습니다.',
              );
            matches.push({ record, turn: match[2] });
          }
        if (part.type === 'tool_call' && /^m365_[a-f0-9]{32}$/.test(part.id)) {
          const record = [...this.records.values()].find((record) =>
            record.calls.some((call) => call.id === part.id),
          );
          if (!record && !matches.length)
            throw sessionError(
              '도구 호출의 웹 대화 연결 정보를 찾지 못했습니다. 새 웹 대화를 자동으로 만들지 않았습니다.',
            );
          if (record) matches.push({ record, turn: record.calls.find((call) => call.id === part.id).turn });
        }
      }
    }
    const ids = new Set(matches.map((match) => match.record.id));
    if (ids.size > 1)
      throw sessionError('서로 다른 VS Code 대화의 연결 정보가 섞여 있어 웹 요청을 보내지 않았습니다.');
    const explicitRecord =
      explicitKey && [...this.records.values()].find((record) => record.explicitKey === explicitKey);
    if (explicitKey && matches.length && matches.at(-1).record.explicitKey !== explicitKey)
      throw sessionError('명시한 대화 ID와 대화 기록의 웹 연결이 일치하지 않습니다.');
    const record = explicitRecord || matches.at(-1)?.record;
    if (record) {
      if (record.scope !== scope)
        throw sessionError(
          '이 대화의 Copilot 연결 설정이 바뀌었습니다. 기존 웹 대화에 다른 설정의 요청을 보내지 않았습니다.',
        );
      return { record, cursor: matches.at(-1)?.turn, explicit: Boolean(explicitKey) };
    }
    if (!explicitKey && messages.some((message) => message.role === 'assistant'))
      throw sessionError(
        'VS Code가 이 대화의 복원 식별자를 전달하지 않았습니다. 기존 대화를 임의로 추정하거나 새 웹 대화를 만들지 않았습니다. 모델을 처음 선택했다면 새 VS Code Chat에서 시작하세요.',
      );
    if (this.records.size >= 1000)
      throw sessionError(
        '웹 대화 매핑 한도에 도달했습니다. 기존 매핑을 지우거나 새 웹 대화를 자동으로 만들지 않았습니다.',
      );
    const created = {
      id: randomUUID(),
      scope,
      url: null,
      started: false,
      turns: [],
      calls: [],
      ...(explicitKey ? { explicitKey } : {}),
    };
    this.records.set(created.id, created);
    return { record: created, explicit: Boolean(explicitKey) };
  }

  check(binding) {
    if (!binding.explicit && binding.cursor && binding.cursor !== binding.record.turns.at(-1))
      throw sessionError(
        '이 대화가 이전 응답에서 분기되었거나 동시에 변경되었습니다. 다른 분기의 웹 대화에 요청을 보내지 않았습니다.',
      );
  }

  capture(record, info) {
    if (!info?.restorable) return;
    const url = webUrl(info.url);
    if (record.url && record.url !== url)
      throw sessionError('응답 도중 웹 대화가 바뀌어 결과를 전달하지 않았습니다.');
    record.url = url;
  }

  finish(record, text, calls) {
    const turn = randomUUID();
    const mapped = calls.map((call) => ({ ...call, id: 'm365_' + randomUUID().replaceAll('-', '') }));
    record.turns.push(turn);
    record.turns = record.turns.slice(-64);
    record.calls = [...record.calls, ...mapped.map((call) => ({ id: call.id, turn }))]
      .filter((call) => record.turns.includes(call.turn))
      .slice(-128);
    return {
      text: `[m365-chat:${record.id}:${turn}]: https://m365.cloud.microsoft/\n\n${cleanText(text)}`,
      calls: mapped,
    };
  }

  async save() {
    await this.state?.update(
      'modelWebConversations.v1',
      [...this.records.values()].filter(
        (record) => record.turns.length || (record.started && record.explicitKey),
      ),
    );
  }

  retain(record) {
    this.references.set(record.id, (this.references.get(record.id) || 0) + 1);
  }

  releaseUnused(record) {
    const remaining = (this.references.get(record.id) || 1) - 1;
    if (remaining) this.references.set(record.id, remaining);
    else {
      this.references.delete(record.id);
      if (!record.turns.length && !(record.started && record.explicitKey)) this.records.delete(record.id);
    }
  }
}

module.exports = { ModelConversations, cleanText, cleanMessages };
