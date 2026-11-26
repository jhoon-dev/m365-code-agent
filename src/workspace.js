// @ts-check
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ignore = require('ignore');
const { ProjectIndex, generatedPath } = require('./search');
/** @typedef {import('../types/contracts').ChangeProposal} ChangeProposal */
/** @typedef {import('../types/contracts').PreparedChange} PreparedChange */
/** @typedef {import('../types/contracts').DirectorySnapshot} DirectorySnapshot */

/** @param {string} text */
const digest = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
/** @param {Uint8Array} bytes */
const digestBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
/** @param {Buffer} buffer */
function decodeText(buffer) {
  const encoding =
    buffer[0] === 0xff && buffer[1] === 0xfe
      ? 'utf-16le'
      : buffer[0] === 0xfe && buffer[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  const content = new TextDecoder(encoding, { fatal: true }).decode(buffer ?? undefined);
  if (content.includes('\0')) throw new Error('바이너리 파일입니다.');
  return content;
}
const blocked =
  /(^|\/)(\.git|node_modules|\.venv|venv|\.ssh|\.aws|\.azure|\.kube|\.m365-agent)(\/|$)|(^|\/)\.env[^/]*$|\.(pem|key|pfx|p12|jks|keystore)$|(^|\/)(\.npmrc|\.pypirc|\.netrc|\.yarnrc\.ya?ml|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials(?:\.(json|ini|toml|ya?ml))?|appsettings(?:\.[^/]*)?\.json)$|\.tfstate(?:\.[^/]*)?$|(^|\/)\.docker\/config\.json$/i;

/** @param {string} directory @param {string[]} names */
async function readIgnores(directory, names) {
  const rules = ignore();
  for (const name of names) {
    try {
      const target = path.join(directory, name);
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw new Error('제외 규칙 파일을 안전하게 읽을 수 없습니다.');
      rules.add(await fs.readFile(target, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return rules;
}

class WorkspaceStore {
  /** @param {string} root @param {((target: string) => Promise<string | undefined>) | undefined} [readText] */
  constructor(root, readText, { maxFileBytes = 16 * 1024 * 1024 } = {}) {
    this.root = path.resolve(root);
    this.readText = readText;
    /** @type {Map<string, string>} */
    this.ledger = new Map();
    /** @type {Map<string, { hash: string, chunks: string[] }>} */
    this.editReads = new Map();
    /** @type {Map<string, string>} */
    this.deleteReads = new Map();
    /** @type {Map<string, string>} */
    this.directoryReads = new Map();
    this.ignores = ignore();
    /** @type {ProjectIndex | null} */
    this.codeIndex = null;
    this.maxFileBytes = maxFileBytes;
  }
  async initialize() {
    this.root = await fs.realpath(this.root);
    this.ignores = await readIgnores(this.root, ['.gitignore', '.m365agentignore']);
    return this;
  }
  /** Search inventory is separate from the bounded model-facing list_files tool.
   * @param {import('../types/contracts').DiscoveryOptions} [options]
   * @returns {Promise<import('../types/contracts').FileDiscovery>}
   */
  async discoverFiles({ paths, limit = 20000, maxDirectories = 10000, cancelled = () => false } = {}) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20000 ||
      !Number.isInteger(maxDirectories) ||
      maxDirectories < 1 ||
      maxDirectories > 10000
    )
      throw new Error('검색 탐색 한도가 올바르지 않습니다.');
    if (cancelled()) throw new Error('작업을 중지했습니다.');
    this.ignores = await readIgnores(this.root, ['.gitignore', '.m365agentignore']);
    const scopes = paths === undefined ? ['.'] : typeof paths === 'string' ? [paths] : paths;
    if (!Array.isArray(scopes) || scopes.length > 500 || scopes.some((scope) => typeof scope !== 'string'))
      throw new Error('검색 범위는 최대 500개의 상대 경로여야 합니다.');
    const files = new Set(),
      directories = new Set(),
      visited = new Set(),
      reasons = new Set();
    /** @type {{path: string, rules: {prefix: string, rules: ReturnType<typeof ignore>}[]}[]} */
    const queue = [];
    const check = () => {
      if (cancelled()) throw new Error('작업을 중지했습니다.');
    };
    // Include ignore rules from every ancestor even for a directly scoped search.
    /** @param {string} directory */
    const ancestorRules = async (directory) => {
      const rules = [];
      const parts = directory.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        const resolved = await this.resolve(prefix);
        rules.push({ prefix: prefix + '/', rules: await readIgnores(resolved.target, ['.gitignore']) });
      }
      return rules;
    };
    for (const scope of scopes) {
      check();
      if (scope === '.' || scope === './') {
        queue.push({ path: '', rules: [] });
        continue;
      }
      const resolved = await this.resolve(scope);
      const directory = (await fs.stat(resolved.target)).isDirectory();
      const parent = path.posix.dirname(resolved.normalized);
      const rules = await ancestorRules(parent === '.' ? '' : parent);
      if (
        rules.some((rule) =>
          rule.rules.ignores(resolved.normalized.slice(rule.prefix.length) + (directory ? '/' : '')),
        )
      )
        continue;
      if (generatedPath(resolved.normalized)) {
        reasons.add('generated-path');
        continue;
      }
      if (directory) queue.push({ path: resolved.normalized, rules });
      else files.add(resolved.normalized);
    }
    let entries = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      check();
      if (files.size >= limit || visited.size >= maxDirectories || entries >= 100000) {
        reasons.add('inventory-limit');
        break;
      }
      const current = queue[cursor];
      if (visited.has(current.path)) continue;
      visited.add(current.path);
      try {
        const target = current.path ? (await this.resolve(current.path)).target : this.root;
        const rules = current.path
          ? [
              ...current.rules,
              { prefix: current.path + '/', rules: await readIgnores(target, ['.gitignore']) },
            ]
          : current.rules;
        const directory = await fs.opendir(target);
        for await (const entry of directory) {
          check();
          if (++entries > 100000 || files.size >= limit) {
            reasons.add('inventory-limit');
            break;
          }
          const relative = current.path ? current.path + '/' + entry.name : entry.name;
          const scoped = relative + (entry.isDirectory() ? '/' : '');
          if (
            entry.isSymbolicLink() ||
            blocked.test(relative) ||
            generatedPath(relative) ||
            this.ignores.ignores(scoped) ||
            rules.some((rule) => rule.rules.ignores(scoped.slice(rule.prefix.length)))
          )
            continue;
          if (entry.isDirectory()) {
            if (!current.path) directories.add(relative);
            queue.push({ path: relative, rules });
          } else if (entry.isFile()) files.add(relative);
        }
      } catch (error) {
        check();
        reasons.add('unreadable-directory');
      }
    }
    return {
      files: [...files].slice(0, limit),
      directories: [...directories].sort().slice(0, 100),
      truncated: reasons.size > 0 || files.size > limit || directories.size > 100,
      reasons: [...reasons],
    };
  }
  /** @param {string} query @param {string | string[]} [paths]
   * @param {() => boolean} [cancelled] @param {import('../types/contracts').FileDiscovery} [listing] */
  async searchCode(query, paths, cancelled = () => false, listing) {
    if (typeof query !== 'string' || !query.trim() || query.length > 8000)
      throw new Error('관련 코드 검색어는 1~8,000자여야 합니다.');
    this.codeIndex ||= new ProjectIndex(this);
    return this.codeIndex.search(
      query,
      listing || (await this.discoverFiles({ paths, cancelled })),
      cancelled,
    );
  }
  /** @param {string} input */
  normalize(input) {
    if (
      typeof input !== 'string' ||
      !input ||
      input.includes('\0') ||
      path.win32.isAbsolute(input) ||
      path.posix.isAbsolute(input)
    )
      throw new Error('프로젝트 상대 경로만 사용할 수 있습니다.');
    const normalized = input.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    if (
      normalized
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[:<>"|?*]/.test(part) ||
            /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
        )
    )
      throw new Error('허용되지 않는 파일 경로입니다.');
    if (blocked.test(normalized) || this.ignores.ignores(normalized))
      throw new Error(`제외된 경로입니다: ${normalized}`);
    return normalized;
  }
  /** @param {string} input */
  async resolve(input, allowMissing = false) {
    const normalized = this.normalize(input);
    const target = path.join(this.root, ...normalized.split('/'));
    let cursor = this.root;
    for (const part of normalized.split('/')) {
      cursor = path.join(cursor, part);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) throw new Error('심볼릭 링크와 정션 경로는 접근하지 않습니다.');
        const real = await fs.realpath(cursor);
        const relative = path.relative(this.root, real);
        if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
          throw new Error('프로젝트 밖의 경로입니다.');
      } catch (error) {
        if (allowMissing && error.code === 'ENOENT') break;
        throw error;
      }
    }
    return { normalized, target };
  }
  async listFiles(limit = 250, directory = '') {
    if (directory === '.' || directory === './') directory = '';
    limit = Math.max(1, Math.min(Number(limit) || 250, 1000));
    /** @type {string[]} */
    const files = [];
    let truncated = false;
    /** @param {string} directory @param {string} [prefix] */
    const walk = async (directory, prefix = '') => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      /** @param {import('node:fs').Dirent} entry */
      const priority = (entry) =>
        entry.isDirectory() ? (/^(src|app|lib|server|client)$/i.test(entry.name) ? 1 : 2) : 0;
      entries.sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        const relative = prefix + entry.name;
        if (entry.isSymbolicLink() || blocked.test(relative)) continue;
        if (this.ignores.ignores(relative + (entry.isDirectory() ? '/' : ''))) continue;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/');
        else if (entry.isFile()) files.push(relative);
      }
    };
    let topTarget = this.root,
      topPrefix = '';
    if (directory) {
      const { normalized, target } = await this.resolve(directory);
      if (!(await fs.stat(target)).isDirectory()) throw new Error('목록 경로는 디렉터리여야 합니다.');
      topTarget = target;
      topPrefix = normalized + '/';
      await walk(target, normalized + '/');
    } else await walk(this.root);
    const directories = (await fs.readdir(topTarget, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !blocked.test(topPrefix + entry.name) &&
          !this.ignores.ignores(topPrefix + entry.name + '/'),
      )
      .map((entry) => topPrefix + entry.name);
    return {
      files,
      truncated: truncated || directories.length > 100,
      directories: directories.slice(0, 100),
    };
  }
  /** @param {string} input */
  async loadFile(input, diskOnly = false) {
    const { normalized, target } = await this.resolve(input);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > this.maxFileBytes)
      throw new Error(
        `${Math.floor(this.maxFileBytes / 1024 / 1024)}MB 이하의 텍스트 파일만 읽을 수 있습니다. 더 큰 파일은 파일 크기 설정을 조정하세요.`,
      );
    const openText = this.readText && !diskOnly ? await this.readText(target) : undefined;
    const buffer = typeof openText === 'string' ? null : await fs.readFile(target);
    const encoding =
      buffer?.[0] === 0xff && buffer?.[1] === 0xfe
        ? 'utf-16le'
        : buffer?.[0] === 0xfe && buffer?.[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    const content =
      typeof openText === 'string'
        ? openText
        : new TextDecoder(encoding, { fatal: true }).decode(buffer ?? undefined);
    if (content.includes('\0') || Buffer.byteLength(content, 'utf8') > this.maxFileBytes)
      throw new Error('바이너리 또는 너무 큰 파일입니다.');
    const hash = digest(content);
    return { path: normalized, hash, content };
  }
  /** @param {string} input */
  async loadBytes(input) {
    const { normalized, target } = await this.resolve(input);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('파일 경로가 필요합니다. 폴더는 folder_info로 확인하세요.');
    if (stat.size > this.maxFileBytes)
      throw new Error('파일 크기 제한을 초과했습니다. 파일 크기 설정을 확인하세요.');
    const buffer = await fs.readFile(target);
    if (buffer.length > this.maxFileBytes) throw new Error('파일 크기 제한을 초과했습니다.');
    return { path: normalized, target, buffer, hash: digestBytes(buffer) };
  }
  /** @param {string} input @returns {Promise<import('../types/contracts').FileInfo>} */
  async fileInfo(input, cancelled = () => false) {
    if (cancelled()) throw new Error('작업을 중지했습니다.');
    const file = await this.loadBytes(input);
    this.deleteReads.set(file.path, file.hash);
    return {
      path: file.path,
      kind: 'file',
      hash: file.hash,
      hashType: 'sha256-bytes',
      size: file.buffer.length,
    };
  }
  // Host-only recovery dispatch. The model-facing file_info never authorizes a folder.
  /** @param {string} input */
  async deletionInfo(input, cancelled = () => false) {
    const resolved = await this.resolve(input);
    return (await fs.stat(resolved.target)).isDirectory()
      ? this.folderInfo(input, cancelled)
      : this.fileInfo(input, cancelled);
  }
  /** @param {string} input @returns {Promise<DirectorySnapshot>} */
  async loadDirectory(input, includeBytes = false, cancelled = () => false) {
    const root = await this.resolve(input),
      stat = await fs.stat(root.target);
    if (!stat.isDirectory()) throw new Error('folder_info에는 프로젝트 안의 폴더 경로가 필요합니다.');
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    /** @type {DirectorySnapshot['files']} */
    const files = [];
    /** @type {string[]} */
    const directories = [];
    let size = 0,
      count = 0;
    /** @param {string} relative */
    const walk = async (relative) => {
      if (cancelled()) throw new Error('작업을 중지했습니다.');
      const resolved = await this.resolve(relative);
      if (this.ignores.ignores(resolved.normalized + '/'))
        throw new Error(`제외된 폴더가 포함되어 있습니다: ${resolved.normalized}`);
      directories.push(resolved.normalized);
      if (++count > 1000)
        throw new Error('폴더 삭제는 하위 파일·폴더 합계 1,000개까지 지원합니다. 범위를 나누세요.');
      for (const entry of (await fs.readdir(resolved.target, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (cancelled()) throw new Error('작업을 중지했습니다.');
        const filename = resolved.normalized + '/' + entry.name;
        this.normalize(filename); // An excluded child prevents deleting the whole folder.
        if (entry.isSymbolicLink()) throw new Error('링크·정션이 포함된 폴더는 삭제하지 않습니다.');
        if (entry.isDirectory()) await walk(filename);
        else if (entry.isFile()) {
          if (++count > 1000)
            throw new Error('폴더 삭제는 하위 파일·폴더 합계 1,000개까지 지원합니다. 범위를 나누세요.');
          const file = await this.loadBytes(filename);
          size += file.buffer.length;
          if (size > 32 * 1024 * 1024)
            throw new Error('한 번의 폴더 삭제 백업은 총 32MB까지 지원합니다. 범위를 나누세요.');
          files.push({
            path: file.path,
            hash: file.hash,
            size: file.buffer.length,
            ...(includeBytes ? { bytes: file.buffer } : {}),
          });
        } else throw new Error('일반 파일·폴더만 삭제할 수 있습니다.');
      }
    };
    await walk(root.normalized);
    const hash = digest(
      JSON.stringify({
        identity,
        directories,
        files: files.map((file) => ({ path: file.path, hash: file.hash, size: file.size })),
      }),
    );
    return { path: root.normalized, target: root.target, identity, hash, files, directories, size };
  }
  /** @param {string} input @returns {Promise<import('../types/contracts').FolderInfo>} */
  async folderInfo(input, cancelled = () => false) {
    const folder = await this.loadDirectory(input, false, cancelled);
    this.directoryReads.set(folder.path, folder.hash);
    const names = [...folder.directories, ...folder.files.map((file) => file.path)];
    return {
      path: folder.path,
      kind: 'directory',
      hash: folder.hash,
      size: folder.size,
      fileCount: folder.files.length,
      directoryCount: folder.directories.length,
      entries: names.slice(0, 12).map((name) => (name.length > 160 ? name.slice(0, 157) + '...' : name)),
      truncated: names.length > 12 || names.some((name) => name.length > 160),
    };
  }
  /** @param {string} input @param {import('../types/contracts').ReadOptions} [options] */
  async readFile(input, options) {
    const file = await this.loadFile(input);
    /** @type {import('../types/contracts').FileRead} */
    let result = file;
    if (options) {
      const lines = file.content.split('\n');
      const start = options.startLine ?? 1,
        count = options.lineCount ?? 80,
        column = options.startColumn ?? 1;
      const maxCharacters = options.maxCharacters ?? 8000;
      if (
        !Number.isInteger(start) ||
        start < 1 ||
        start > lines.length ||
        !Number.isInteger(column) ||
        column < 1 ||
        column > lines[start - 1].length + 1 ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 200 ||
        !Number.isInteger(maxCharacters) ||
        maxCharacters < 128 ||
        maxCharacters > 22000
      )
        throw new Error('줄 범위가 올바르지 않습니다. startLine/startColumn>=1, lineCount=1~200.');
      let content = '',
        end = start - 1;
      /** @type {number | null} */
      let nextLine = start;
      /** @type {number | null} */
      let nextColumn = column;
      for (let index = start - 1; index < Math.min(lines.length, start - 1 + count); index++) {
        const offset = index === start - 1 ? column - 1 : 0;
        const line = lines[index].slice(offset) + (index < lines.length - 1 ? '\n' : '');
        if (content.length + line.length > maxCharacters) {
          if (!content.length) {
            content = line.slice(0, maxCharacters);
            if (/[\ud800-\udbff]$/.test(content) && /[\udc00-\udfff]/.test(line[content.length] || ''))
              content = content.slice(0, -1);
            end = index + 1;
            nextLine = index + 1;
            nextColumn = offset + content.length + 1;
          }
          break;
        }
        content += line;
        end = index + 1;
        nextLine = index + 1 < lines.length ? index + 2 : null;
        nextColumn = nextLine ? 1 : null;
      }
      result = {
        ...file,
        content,
        startLine: start,
        startColumn: column,
        endLine: end,
        totalLines: lines.length,
        complete: start === 1 && column === 1 && nextLine === null,
        nextLine,
        nextColumn,
      };
    }
    if (!options || result.complete) this.ledger.set(file.path, file.hash);
    let observed = this.editReads.get(file.path);
    if (!observed || observed.hash !== file.hash) observed = { hash: file.hash, chunks: [] };
    if (!observed.chunks.includes(result.content)) observed.chunks.push(result.content);
    observed.chunks = observed.chunks.slice(-40);
    this.editReads.set(file.path, observed);
    return result;
  }
  /** @param {string} query @param {string | string[]} [paths] */
  async search(query, paths, cancelled = () => false) {
    if (typeof query !== 'string' || !query || query.length > 200)
      throw new Error('검색어는 1~200자여야 합니다.');
    const listing = await this.discoverFiles({ paths, cancelled });
    const matches = [];
    const reasons = new Set(listing.reasons);
    let searchedFiles = 0,
      skippedFiles = 0,
      bytes = 0;
    for (const filename of listing.files) {
      if (cancelled()) throw new Error('작업을 중지했습니다.');
      let file;
      try {
        const { target } = await this.resolve(filename);
        const stat = await fs.stat(target);
        if (bytes + stat.size > 64 * 1024 * 1024) {
          skippedFiles++;
          reasons.add('search-byte-limit');
          continue;
        }
        bytes += stat.size;
        file = await this.loadFile(filename, true);
      } catch {
        skippedFiles++;
        reasons.add('unreadable-file');
        continue;
      }
      searchedFiles++;
      for (const [index, line] of file.content.split(/\r?\n/).entries()) {
        if (cancelled()) throw new Error('작업을 중지했습니다.');
        const found = line.toLowerCase().indexOf(query.toLowerCase());
        if (found >= 0) {
          const start = Math.max(0, found - 80);
          matches.push({
            path: file.path,
            line: index + 1,
            column: start + 1,
            text: line.slice(start, start + 400),
          });
        }
        if (matches.length >= 40)
          return {
            matches,
            truncated: true,
            searchedFiles,
            skippedFiles,
            reasons: [...reasons, 'result-limit'],
          };
      }
    }
    return {
      matches,
      truncated: listing.truncated || skippedFiles > 0,
      searchedFiles,
      skippedFiles,
      reasons: [...reasons],
    };
  }
  /** @param {ChangeProposal[]} files @returns {Promise<PreparedChange[]>} */
  async prepareChanges(files, cancelled = () => false) {
    if (!Array.isArray(files) || !files.length || files.length > 30)
      throw new Error('변경 파일은 1~30개여야 합니다.');
    const seen = new Set();
    /** @type {PreparedChange[]} */
    const changes = [];
    let bytes = 0;
    let deletedBytes = 0;
    for (const file of files) {
      if (
        !file ||
        !['create', 'replace', 'edit', 'delete'].includes(file.action) ||
        (['create', 'replace'].includes(file.action) &&
          (!('content' in file) || typeof file.content !== 'string'))
      )
        throw new Error('지원하지 않는 변경 형식입니다.');
      const { normalized, target } = await this.resolve(file.path, file.action === 'create');
      const key = normalized.toLowerCase();
      if (seen.has(key)) throw new Error('동일 파일을 중복 변경할 수 없습니다.');
      seen.add(key);
      if (file.action === 'delete') {
        if ((await fs.stat(target)).isDirectory()) {
          if (typeof file.baseHash !== 'string' || this.directoryReads.get(normalized) !== file.baseHash)
            throw new Error(
              `먼저 folder_info로 폴더 전체를 확인하고 정확한 hash를 사용해야 합니다: ${normalized}`,
            );
          const snapshot = await this.loadDirectory(normalized, true, cancelled);
          if (snapshot.hash !== file.baseHash)
            throw new Error(`확인 뒤 폴더 내용이 변경되었습니다. 다시 확인하세요: ${normalized}`);
          deletedBytes += snapshot.size;
          if (deletedBytes > 32 * 1024 * 1024) throw new Error('한 번의 삭제 백업은 총 32MB까지 지원합니다.');
          changes.push({
            path: normalized,
            target,
            action: 'delete',
            directory: true,
            content: '',
            original:
              '폴더 삭제 목록\n' +
              [
                ...snapshot.directories.map((name) => name + '/'),
                ...snapshot.files.map((item) => item.path),
              ].join('\n'),
            directorySnapshot: {
              ...snapshot,
              files: snapshot.files.map((file) => {
                if (!Buffer.isBuffer(file.bytes)) throw new Error('폴더 삭제 원본 바이트 백업이 없습니다.');
                return { ...file, bytes: file.bytes };
              }),
            },
            expectedHash: snapshot.hash,
            expectedDiskHash: snapshot.hash,
          });
          continue;
        }
        const byteRead = this.deleteReads.get(normalized) === file.baseHash;
        if (
          typeof file.baseHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(file.baseHash) ||
          (!byteRead && this.editReads.get(normalized)?.hash !== file.baseHash)
        )
          throw new Error(
            `먼저 read_file 또는 file_info로 파일을 확인하고 정확한 hash를 사용해야 합니다: ${normalized}`,
          );
        const snapshot = await this.loadBytes(normalized);
        if (
          byteRead ? snapshot.hash !== file.baseHash : digest(decodeText(snapshot.buffer)) !== file.baseHash
        )
          throw new Error(`확인 뒤 파일이 변경되었습니다. 다시 확인하세요: ${normalized}`);
        deletedBytes += snapshot.buffer.length;
        if (deletedBytes > 32 * 1024 * 1024)
          throw new Error('한 번의 삭제 백업은 총 32MB까지 지원합니다. 파일 묶음을 줄이세요.');
        let original,
          binary = false;
        try {
          original = decodeText(snapshot.buffer);
        } catch {
          binary = true;
          original = `[바이너리 파일 · ${snapshot.buffer.length.toLocaleString()} bytes]\n`;
        }
        changes.push({
          path: normalized,
          target,
          action: 'delete',
          directory: false,
          content: '',
          original,
          binary,
          originalBytes: snapshot.buffer,
          expectedHash: file.baseHash,
          expectedDiskHash: snapshot.hash,
        });
        continue;
      }
      /** @type {{path: string, hash: string, content: string} | null} */
      let original = null;
      let content = 'content' in file ? file.content : '';
      if (file.action === 'create') {
        try {
          await fs.lstat(target);
          throw new Error(`이미 존재하는 파일입니다: ${normalized}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (file.baseHash !== null) throw new Error('새 파일의 baseHash는 null이어야 합니다.');
      } else if (file.action === 'replace') {
        if (this.ledger.get(normalized) !== file.baseHash)
          throw new Error(`먼저 파일을 읽고 정확한 hash를 사용해야 합니다: ${normalized}`);
        original = await this.loadFile(normalized);
        if (original.hash !== file.baseHash)
          throw new Error(`읽은 뒤 변경된 파일입니다. 다시 읽어야 합니다: ${normalized}`);
      } else {
        const observed = this.editReads.get(normalized);
        if (!observed || observed.hash !== file.baseHash)
          throw new Error(`먼저 수정할 줄을 읽고 정확한 hash를 사용해야 합니다: ${normalized}`);
        original = await this.loadFile(normalized);
        if (original.hash !== file.baseHash)
          throw new Error(`읽은 뒤 변경된 파일입니다. 다시 읽어야 합니다: ${normalized}`);
        if (!Array.isArray(file.edits) || file.edits.length < 1 || file.edits.length > 20)
          throw new Error('부분 수정은 1~20개의 oldText/newText 쌍이어야 합니다.');
        const crlf =
          original.content.includes('\r\n') && !original.content.replace(/\r\n/g, '').includes('\n');
        /** @param {string} text */
        const eol = (text) => (crlf ? text.replace(/\r?\n/g, '\r\n') : text);
        const observedContent = original.content;
        const spans = file.edits
          .map((edit) => {
            if (
              !edit ||
              typeof edit.oldText !== 'string' ||
              !edit.oldText ||
              typeof edit.newText !== 'string' ||
              edit.oldText.includes('\0') ||
              edit.newText.includes('\0')
            )
              throw new Error('부분 수정의 텍스트가 올바르지 않습니다.');
            const oldText = eol(edit.oldText),
              newText = eol(edit.newText);
            if (!observed.chunks.some((chunk) => chunk.includes(oldText)))
              throw new Error('수정할 oldText가 읽은 범위에 없습니다. 해당 줄을 먼저 읽으세요.');
            const start = observedContent.indexOf(oldText);
            if (start < 0 || observedContent.indexOf(oldText, start + 1) >= 0)
              throw new Error('oldText는 파일에서 정확히 한 번 나타나야 합니다. 앞뒤 문맥을 더 포함하세요.');
            return { start, end: start + oldText.length, text: newText };
          })
          .sort((a, b) => a.start - b.start);
        for (let index = 1; index < spans.length; index++)
          if (spans[index].start < spans[index - 1].end) throw new Error('부분 수정 범위가 겹칩니다.');
        content = original.content;
        for (const span of spans.reverse())
          content = content.slice(0, span.start) + span.text + content.slice(span.end);
      }
      bytes += Buffer.byteLength(file.action === 'edit' ? JSON.stringify(file.edits) : content, 'utf8');
      if (
        bytes > 512 * 1024 ||
        Buffer.byteLength(content, 'utf8') > this.maxFileBytes ||
        content.includes('\0')
      )
        throw new Error('변경 내용이 너무 크거나 텍스트가 아닙니다.');
      changes.push({
        ...file,
        directory: false,
        content,
        path: normalized,
        target,
        original: original?.content ?? '',
        expectedHash: original?.hash ?? null,
      });
    }
    for (const change of changes.filter((change) => change.directory))
      if (
        changes.some(
          (other) => other !== change && other.path.toLowerCase().startsWith(change.path.toLowerCase() + '/'),
        )
      )
        throw new Error('폴더와 그 내부 경로를 같은 묶음에서 중복 변경할 수 없습니다. 폴더만 지정하세요.');
    return changes;
  }
  /** @param {PreparedChange[]} changes */
  async verifyChanges(changes, cancelled = () => false) {
    for (const change of changes) {
      if (cancelled()) throw new Error('작업을 중지했습니다.');
      await this.resolve(change.path, change.action === 'create');
      if (change.action === 'create') {
        try {
          await fs.lstat(change.target);
          throw new Error(`새 파일 경로가 이미 생겼습니다: ${change.path}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      } else if (change.action === 'delete') {
        if (
          (change.directory
            ? await this.loadDirectory(change.path, false, cancelled)
            : await this.loadBytes(change.path)
          ).hash !== change.expectedDiskHash
        )
          throw new Error(`미리보기 이후 파일·폴더가 변경되었습니다: ${change.path}`);
      } else if ((await this.loadFile(change.path)).hash !== change.expectedHash)
        throw new Error(`미리보기 이후 파일이 변경되었습니다: ${change.path}`);
    }
  }
}
module.exports = { WorkspaceStore, decodeText, digest, digestBytes };
