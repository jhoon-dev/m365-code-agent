// @ts-check
'use strict';
const { t } = require('./localization');
const fs = require('node:fs/promises');
const path = require('node:path');
/** @typedef {{text: string, line: number, column: number, frequencies: Map<string, number>, length: number}} Chunk */

/** @param {string} name */
const generatedPath = (name) =>
  /(^|\/)(dist|build|coverage|vendor|bin|obj|\.test-output|\.vscode-test|\.next|\.nuxt|target)(\/|$)|(?:\.min\.[cm]?js|\.map|\.lock)$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml)$/i.test(
    name,
  );
/** @param {string} name */
const textPath = (name) =>
  /\.(?:[cm]?[jt]sx?|py|cs|java|kt|go|rs|rb|php|vue|svelte|cpp|c|h|hpp|swift|html|css|scss|less|sql|graphql|gql|sh|ps1|ya?ml|json|toml|xml|md|txt|ini|cfg|config)$/i.test(
    name,
  ) || /(^|\/)(Makefile|Dockerfile|Gemfile)$/i.test(name);
const stopWords = new Set(
  'a an and are as at be by can code do does explain file files find for from how i in is it me of on or please project show the this to use want what where which with you your 코드 파일 프로젝트 찾아줘 알려줘 설명해줘 수정해줘 분석해줘'.split(
    ' ',
  ),
);
/** @type {[RegExp, string][]} */
const concepts = [
  [/로그인/, 'login sign auth'],
  [/인증/, 'auth authentication credential'],
  [/토큰/, 'token'],
  [/갱신|만료/, 'refresh renew expiry expire'],
  [/세션/, 'session'],
  [/권한/, 'permission authorization access'],
  [/검색/, 'search query find'],
  [/저장/, 'save store persist'],
  [/삭제/, 'delete remove'],
  [/오류|에러|예외/, 'error exception failure'],
  [/연결/, 'connect connection'],
  [/캐시/, 'cache'],
  [/테스트/, 'test spec'],
  [/결제/, 'payment checkout billing'],
  [/설정/, 'config settings'],
];

/** @param {string} text */
function terms(text) {
  const words =
    text
      .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
      .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, '$1 $2')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [];
  return words.filter((word) => word.length > 1 && word.length <= 100 && !stopWords.has(word));
}
/** @param {string} query */
function queryTerms(query) {
  const result = terms(query);
  for (const [pattern, expansion] of concepts) if (pattern.test(query)) result.push(...expansion.split(' '));
  return [...new Set(result)].slice(0, 32);
}
/** @param {string[]} files @param {string} query */
function rankFiles(files, query) {
  const tokens = queryTerms(query);
  const exact = query.toLowerCase().replace(/\\/g, '/');
  /** @param {string} file */
  const score = (file) => {
    const name = file.toLowerCase(),
      base = path.posix.basename(name),
      words = new Set(terms(file));
    let value = textPath(name) ? 30 : 0;
    if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|readme(?:\.md)?|.*\.sln)$/.test(base))
      value += 25;
    if (/(^|\/)(src|app|lib|server|client)\//.test(name)) value += 20;
    if (/^(index|main|app|program|startup|extension)\./.test(base)) value += 20;
    if (generatedPath(name)) value -= 100;
    if (exact.includes(name) || exact.includes(base)) value += 500;
    for (const token of tokens)
      if (words.has(token)) value += 45;
      else if (name.includes(token)) value += 10;
    return value;
  };
  const scores = new Map(files.map((file) => [file, score(file)]));
  return [...files].sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0) || a.localeCompare(b));
}

// Chunk by both lines and characters, including long single-line source files.
/** @param {string} content */
function chunksOf(content) {
  /** @type {Chunk[]} */
  const chunks = [];
  /** @type {string[]} */
  let parts = [];
  let length = 0,
    start = 1;
  /** @param {string} text @param {number} line @param {number} [column] */
  const add = (text, line, column = 1) => {
    const words = terms(text),
      frequencies = new Map();
    for (const word of words) frequencies.set(word, (frequencies.get(word) || 0) + 1);
    chunks.push({ text, line, column, frequencies, length: words.length });
  };
  const flush = () => {
    if (parts.length) add(parts.join('\n'), start);
    parts = [];
    length = 0;
  };
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.length > 6000) {
      flush();
      for (let offset = 0; offset < line.length; offset += 6000)
        add(line.slice(offset, offset + 6000), index + 1, offset + 1);
    } else {
      if (parts.length >= 40 || length + line.length > 6000) flush();
      if (!parts.length) start = index + 1;
      parts.push(line);
      length += line.length + 1;
    }
  }
  flush();
  return chunks;
}
/** @param {Chunk} chunk @param {string[]} tokens */
function snippet(chunk, tokens) {
  const lines = chunk.text.split('\n');
  let best = 0,
    weight = -1;
  for (let i = 0; i < lines.length; i++) {
    const words = new Set(terms(lines[i]));
    const score = tokens.filter((token) => words.has(token)).length;
    const definition = /\b(function|class|def|func|interface|type|const|public|private)\b/.test(lines[i])
      ? 0.25
      : 0;
    if (score + definition > weight) {
      weight = score + definition;
      best = i;
    }
  }
  const line = lines[best],
    lower = line.toLowerCase();
  const offset = Math.max(
    0,
    Math.min(...tokens.map((token) => lower.indexOf(token)).filter((i) => i >= 0)) - 80,
  );
  const column = (best === 0 ? chunk.column : 1) + (Number.isFinite(offset) ? offset : 0);
  return {
    line: chunk.line + best,
    column,
    text: line.slice(
      column - (best === 0 ? chunk.column : 1),
      column - (best === 0 ? chunk.column : 1) + 400,
    ),
  };
}

class ProjectIndex {
  /** @param {import('./workspace').WorkspaceStore} store */
  constructor(store) {
    this.store = store;
    // Task-local memory only. A fresh inventory and metadata are checked on every search.
    /** @type {Map<string, {stamp: string, chunks: Chunk[]}>} */
    this.documents = new Map();
  }
  /** @param {string} query @param {import('../types/contracts').FileDiscovery} listing @param {() => boolean} [cancelled] */
  async search(query, listing, cancelled = () => false) {
    if (typeof query !== 'string' || !query.trim() || query.length > 8000)
      throw new Error(t('관련 코드 검색어는 1~8,000자여야 합니다.'));
    const check = () => {
      if (cancelled()) throw new Error(t('작업을 중지했습니다.'));
    };
    check();
    const names = rankFiles(listing.files, query),
      retained = new Set();
    let bytes = 0,
      count = 0,
      reservedFiles = 0,
      chunkCount = 0,
      totalLength = 0,
      skippedFiles = 0;
    const reasons = new Set(listing.reasons);
    /** @param {string} name */
    const indexFile = async (name) => {
      check();
      if (!textPath(name)) {
        skippedFiles++;
        return;
      }
      try {
        const { target } = await this.store.resolve(name);
        const stat = await fs.stat(target);
        if (
          stat.size > 256 * 1024 ||
          bytes + stat.size > 32 * 1024 * 1024 ||
          reservedFiles >= 10000 ||
          chunkCount >= 40000
        ) {
          skippedFiles++;
          reasons.add('index-limit');
          return;
        }
        bytes += stat.size;
        reservedFiles++;
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        let document = this.documents.get(name);
        if (!document || document.stamp !== stamp) {
          // Disk reads never invoke editor hooks or grant a read/hash for editing.
          const file = await this.store.loadFile(name, true);
          check();
          const after = await fs.stat(target);
          if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) {
            skippedFiles++;
            reasons.add('changed-during-index');
            return;
          }
          document = { stamp, chunks: chunksOf(file.content) };
        }
        if (chunkCount + document.chunks.length > 40000) {
          skippedFiles++;
          reasons.add('index-limit');
          return;
        }
        this.documents.set(name, document);
        retained.add(name);
        count++;
        chunkCount += document.chunks.length;
        for (const chunk of document.chunks) totalLength += chunk.length;
      } catch {
        check();
        skippedFiles++;
        reasons.add('unreadable-file');
      }
    };
    let cursor = 0;
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(4, names.length) }, async () => {
        while (cursor < names.length) await indexFile(names[cursor++]);
      }),
    );
    const failed = workers.find((worker) => worker.status === 'rejected');
    if (failed) throw failed.reason;
    for (const name of this.documents.keys()) if (!retained.has(name)) this.documents.delete(name);
    const tokens = queryTerms(query),
      df = new Map(tokens.map((token) => [token, 0]));
    for (const document of this.documents.values())
      for (const chunk of document.chunks) {
        check();
        for (const token of tokens) if (chunk.frequencies.has(token)) df.set(token, (df.get(token) || 0) + 1);
      }
    const average = Math.max(1, totalLength / Math.max(1, chunkCount)),
      matches = [];
    for (const name of names) {
      check();
      const pathTerms = new Set(terms(name)),
        lower = name.toLowerCase();
      const pathHits = tokens.filter((token) => pathTerms.has(token)).length;
      const exact = query.toLowerCase().replace(/\\/g, '/').includes(lower);
      let best,
        bestScore = 0;
      for (const chunk of this.documents.get(name)?.chunks || []) {
        let score = 0,
          coverage = 0;
        for (const token of tokens) {
          const tf = chunk.frequencies.get(token) || 0;
          if (!tf) continue;
          coverage++;
          const frequency = df.get(token) || 0;
          const idf = Math.log(1 + (chunkCount - frequency + 0.5) / (frequency + 0.5));
          score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * chunk.length) / average));
        }
        score *= 1 + coverage / Math.max(1, tokens.length);
        if (score > bestScore) {
          bestScore = score;
          best = chunk;
        }
      }
      let score = bestScore + pathHits * 4 + (exact ? 1000 : 0);
      if (!exact && /\.(md|txt)$/i.test(name) && !/\b(docs?|documentation|readme)\b|문서/i.test(query))
        score *= 0.4;
      if (score > 0)
        matches.push({
          path: name,
          ...(best ? snippet(best, tokens) : { line: 1, column: 1, text: '' }),
          score: Math.round(score * 100) / 100,
        });
    }
    matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    if (matches.length > 20) reasons.add('result-limit');
    return {
      matches: matches.slice(0, 20),
      discoveredFiles: listing.files.length,
      indexedFiles: count,
      skippedFiles,
      truncated: listing.truncated || reasons.size > 0 || skippedFiles > 0 || matches.length > 20,
      reasons: [...reasons],
      note: 'Ranked disk snippets only; use read_file before editing. Scope paths to narrow an incomplete search.',
    };
  }
}
module.exports = { ProjectIndex, rankFiles, generatedPath, queryTerms };
