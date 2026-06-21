const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { hybridSearch } = require('./retrieval');
const { createFile, getFileByPath, writeMarkdownFile, sha256, extractTitle } = require('./files');
const { triggerIncrementalIndex } = require('./indexer');
const { createOperationSet, getOperationSetById, markOperationSetStatus } = require('./canvasOperationSets');
const {
  checkAndIncrementToolCount,
  getSession,
  normalizeAgentPath,
  resolveInsideNotes,
  summarizeToolResult,
  trackCreatedFile,
  validateWrite,
} = require('./agentSession');

const ANALYZE_FOLDER_MAX_FILES = 200;

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties,
      required,
    },
  };
}

function buildToolDefinitions() {
  return [
    tool('search_knowledge', '在用户的笔记知识库中检索相关内容。需要了解笔记事实时调用。', {
      query: { type: 'string', description: '检索关键词或问题' },
      scope_paths: { type: 'array', items: { type: 'string' }, description: '可选，限定检索目录或文件路径' },
      top_k: { type: 'integer', default: 5, description: '返回结果数，最大 10' },
    }, ['query']),
    tool('read_file', '读取任意 Markdown 笔记全文。读取不受写入授权范围限制。', {
      path: { type: 'string', description: '相对 notes 根目录的 Markdown 文件路径' },
    }, ['path']),
    tool('create_note', '在授权范围内新建 Markdown 笔记。新建后会记录到当前任务并支持回滚。', {
      path: { type: 'string', description: '新笔记路径，例如 drafts/article.md' },
      title: { type: 'string', description: '可选标题' },
      content: { type: 'string', description: 'Markdown 正文' },
    }, ['path', 'content']),
    tool('preview_patch_files', '为已有文件生成修改预览。必须作为该轮唯一工具调用，用户确认后才写入。', {
      patches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old: { type: 'string', description: '要替换的原文，必须来自 read_file 或 search_knowledge 结果' },
            new: { type: 'string', description: '替换后的新文本' },
          },
          required: ['file_path', 'old', 'new'],
        },
      },
    }, ['patches']),
    tool('analyze_folder', '分析目录下的 Markdown 文件结构，返回文件路径、标题和可选内容预览。', {
      folder_path: { type: 'string', description: '目录路径，空字符串表示根目录' },
      include_content_preview: { type: 'boolean', default: false },
    }, ['folder_path']),
    tool('check_links', '检查内部链接，返回孤立笔记和断链。', {
      scope_path: { type: 'string', description: '检查范围，空字符串表示全库' },
    }, ['scope_path']),
  ];
}

function listFilesUnderScope(scopePaths = []) {
  const db = getDb();
  const scopes = (Array.isArray(scopePaths) ? scopePaths : []).map((item) => {
    try { return normalizeAgentPath(item, { allowRoot: true }); } catch { return null; }
  }).filter((item) => item !== null);
  if (scopes.length === 0) return [];
  const rows = db.prepare('SELECT id, path, title FROM files').all();
  return rows.filter((row) => scopes.some((scope) => !scope || row.path === scope || row.path.startsWith(`${scope}/`)));
}

async function executeSearchKnowledge({ query, scope_paths: scopePaths = [], top_k: topK = 5 } = {}, sessionId) {
  const q = String(query || '').trim();
  if (!q) return { error: 'QUERY_REQUIRED', message: 'search_knowledge 需要 query' };
  const counter = checkAndIncrementToolCount(sessionId, 'search_knowledge');
  if (!counter.allowed) return { error: 'SEARCH_LIMIT_REACHED', message: '知识库检索已达本次任务上限' };
  const session = getSession(sessionId);
  const hasScopeRequest = Array.isArray(scopePaths) && scopePaths.map((item) => String(item || '').trim()).filter(Boolean).length > 0;
  const scopedFiles = listFilesUnderScope(scopePaths);
  const fileIds = scopedFiles.length > 0 ? scopedFiles.map((file) => Number(file.id)) : [];
  const limit = session.search_knowledge_limit;
  const remaining = limit === null ? '不限' : Math.max(0, Number(limit) - Number(counter.count));
  if (hasScopeRequest && fileIds.length === 0) {
    return {
      call_index: counter.count,
      remaining_calls: remaining,
      results: [],
      scoped: true,
      message: 'scope_paths 没有匹配到可检索文件',
    };
  }
  const chunks = await hybridSearch(q, {
    topK: Math.min(Math.max(1, Number(topK) || 5), 10),
    fileIds,
  });
  return {
    call_index: counter.count,
    remaining_calls: remaining,
    results: chunks.map((chunk) => ({
      file_title: chunk.file_title,
      file_path: chunk.file_path,
      heading_path: chunk.heading_path || '',
      content: String(chunk.content || '').length > 800 ? `${String(chunk.content || '').slice(0, 800)}…[已截断，如需完整内容请用 read_file]` : String(chunk.content || ''),
      score: Math.round(Number(chunk.score || 0) * 100) / 100,
      line_start: chunk.line_start || null,
      line_end: chunk.line_end || null,
    })),
  };
}

function executeReadFile({ path: filePath } = {}) {
  let normalized;
  try { normalized = normalizeAgentPath(filePath, { ensureMarkdown: true }); } catch (error) { return { error: 'INVALID_PATH', message: error.message }; }
  const file = getFileByPath(normalized);
  if (!file) return { error: 'FILE_NOT_FOUND', file_path: normalized };
  return {
    file_path: file.path,
    title: file.title,
    hash: sha256(file.content || ''),
    content: file.content || '',
  };
}

function buildAgentFrontmatterContent(title = '', content = '') {
  const cleanTitle = String(title || '').trim();
  const body = String(content || '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  const titleLine = cleanTitle ? `title: ${JSON.stringify(cleanTitle)}` : '';
  const frontmatter = ['---', 'created_by: notus_agent', titleLine, '---'].filter(Boolean).join('\n');
  return `${frontmatter}\n\n${body}`;
}

async function executeCreateNote({ path: filePath, content = '', title = '' } = {}, sessionId, notesDir = getEffectiveConfig().notesDir) {
  const session = getSession(sessionId);
  let normalized;
  try { normalized = normalizeAgentPath(filePath, { ensureMarkdown: true }); } catch (error) { return { error: 'INVALID_PATH', message: error.message }; }
  const check = validateWrite(session.session_token, normalized, 'create');
  if (!check.valid) return { error: 'PERMISSION_DENIED', reason: check.reason, path: normalized };
  const target = resolveInsideNotes(notesDir, normalized);
  if (fs.existsSync(target.absolutePath)) return { error: 'FILE_ALREADY_EXISTS', path: normalized };
  const finalContent = buildAgentFrontmatterContent(title, content);
  const file = createFile(normalized, finalContent);
  const finalHash = sha256(file.content || finalContent);
  trackCreatedFile(sessionId, file.path, finalHash);
  triggerIncrementalIndex(file.path).catch((error) => console.warn('[AgentLoop] 增量索引失败（非致命）:', file.path, error.message));
  return { path: file.path, title: file.title, created: true, hash: finalHash };
}

function normalizePatch(patch = {}) {
  const filePath = normalizeAgentPath(patch.file_path || patch.path, { ensureMarkdown: true });
  return {
    file_path: filePath,
    old: String(patch.old ?? ''),
    new: String(patch.new ?? ''),
  };
}

function findUniqueIndex(source = '', target = '') {
  if (!target) return -1;
  const first = source.indexOf(target);
  if (first < 0) return -1;
  return source.indexOf(target, first + target.length) < 0 ? first : -2;
}

function buildCollapsedWhitespaceIndex(value = '') {
  const source = String(value || '');
  let normalized = '';
  const map = [];
  let previousWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) {
      if (!previousWhitespace) {
        normalized += ' ';
        map.push(index);
        previousWhitespace = true;
      }
    } else {
      normalized += char;
      map.push(index);
      previousWhitespace = false;
    }
  }
  return { source, normalized, map };
}

function alignPatchOldText(currentContent = '', oldText = '') {
  const current = String(currentContent || '');
  const old = String(oldText ?? '');
  if (!old) return { ok: true, old: '', strategy: 'empty' };
  if (current.includes(old)) return { ok: true, old, strategy: 'exact' };

  const trimmed = old.trim();
  if (trimmed) {
    const trimmedIndex = findUniqueIndex(current, trimmed);
    if (trimmedIndex >= 0) {
      return { ok: true, old: current.slice(trimmedIndex, trimmedIndex + trimmed.length), strategy: 'trimmed' };
    }
  }

  const currentIndex = buildCollapsedWhitespaceIndex(current);
  const oldCollapsed = buildCollapsedWhitespaceIndex(old).normalized.trim();
  if (!oldCollapsed) return { ok: false, reason: 'EMPTY_OLD_AFTER_NORMALIZE' };
  const collapsedIndex = findUniqueIndex(currentIndex.normalized, oldCollapsed);
  if (collapsedIndex >= 0) {
    const endCollapsedIndex = collapsedIndex + oldCollapsed.length - 1;
    const start = currentIndex.map[collapsedIndex];
    const end = currentIndex.map[endCollapsedIndex] + 1;
    return { ok: true, old: currentIndex.source.slice(start, end), strategy: 'collapsed_whitespace' };
  }
  if (collapsedIndex === -2) {
    return { ok: false, reason: 'OLD_MATCH_NOT_UNIQUE', message: 'old 文本在当前文件中出现多处近似匹配，请扩大 old 范围后重试。' };
  }
  return { ok: false, reason: 'OLD_NOT_FOUND', message: 'old 文本没有在当前文件中找到唯一匹配，请先 read_file 读取精确原文后重试。' };
}

async function executePreviewPatchFiles({ patches = [] } = {}, sessionId) {
  const session = getSession(sessionId);
  const normalized = (Array.isArray(patches) ? patches : []).map((patch) => {
    try { return normalizePatch(patch); } catch { return null; }
  }).filter(Boolean);
  if (normalized.length === 0) return { error: 'PATCHES_REQUIRED', message: 'preview_patch_files 需要 patches' };
  for (const patch of normalized) {
    const check = validateWrite(session.session_token, patch.file_path, 'modify');
    if (!check.valid) return { error: 'PERMISSION_DENIED', reason: check.reason, path: patch.file_path };
    const file = getFileByPath(patch.file_path);
    if (!file) return { error: 'FILE_NOT_FOUND', path: patch.file_path };
    const current = String(file.content || '');
    if (patch.old === '' && current !== '') return { error: 'OLD_REQUIRED', path: patch.file_path, message: '非空文件必须提供可二次校验的 old 文本' };
    const aligned = alignPatchOldText(current, patch.old);
    if (!aligned.ok) {
      return {
        error: 'OLD_NOT_FOUND',
        path: patch.file_path,
        reason: aligned.reason,
        message: aligned.message || 'old 文本没有在当前文件中找到唯一匹配',
      };
    }
    patch.old = aligned.old;
  }
  const operationSet = createOperationSet({
    conversationId: session.conversation_id,
    agentSessionId: session.id,
    articleHash: sha256(JSON.stringify(normalized)),
    mode: normalized.length > 1 ? 'multiple_files' : 'single_file',
    operations: [],
    patches: normalized,
    status: 'pending',
  });
  return { operation_set_id: operationSet.id, patch_count: normalized.length, patches: normalized.map((patch) => ({ file_path: patch.file_path })) };
}

function getSnapshotHashMap(sessionId) {
  const rows = getDb().prepare('SELECT file_path, file_hash FROM agent_snapshots WHERE session_id = ?').all(sessionId);
  return new Map(rows.map((row) => [row.file_path, row.file_hash]));
}

async function applyPreviewWithConflictCheck(operationSetId, sessionId, { force = false } = {}) {
  const set = getOperationSetById(operationSetId);
  if (!set) return { success: false, error: 'OPERATION_SET_NOT_FOUND' };
  if (Number(set.agent_session_id || 0) !== Number(sessionId)) return { success: false, error: 'SESSION_OPERATION_SET_MISMATCH' };
  if (set.status !== 'pending') return { success: false, error: 'OPERATION_SET_NOT_PENDING', status: set.status };
  const patches = Array.isArray(set.patches) ? set.patches.map(normalizePatch) : [];
  if (patches.length === 0) return { success: false, error: 'PATCHES_REQUIRED' };
  const snapshotHashes = getSnapshotHashMap(Number(sessionId));
  const conflicts = [];
  for (const patch of patches) {
    const file = getFileByPath(patch.file_path);
    if (!file) { conflicts.push({ path: patch.file_path, reason: 'FILE_NOT_FOUND' }); continue; }
    const snapshotHash = snapshotHashes.get(patch.file_path);
    const currentHash = sha256(file.content || '');
    if (snapshotHash && currentHash !== snapshotHash && !force) conflicts.push({ path: patch.file_path, reason: 'FILE_CHANGED' });
    const current = String(file.content || '');
    if (patch.old === '' && current !== '') conflicts.push({ path: patch.file_path, reason: 'OLD_REQUIRED' });
    else if (!current.includes(patch.old)) conflicts.push({ path: patch.file_path, reason: 'OLD_NOT_FOUND' });
  }
  if (conflicts.length > 0) return { success: false, conflict: true, conflicting_files: conflicts };

  const changed = [];
  for (const patch of patches) {
    const file = getFileByPath(patch.file_path);
    const current = String(file.content || '');
    const next = current.replace(patch.old, patch.new);
    writeMarkdownFile(patch.file_path, next);
    changed.push(patch.file_path);
  }
  markOperationSetStatus(set.id, 'applied');
  changed.forEach((filePath) => triggerIncrementalIndex(filePath).catch((error) => console.warn('[AgentLoop] 增量索引失败（非致命）:', filePath, error.message)));
  return { success: true, applied: true, changed_files: changed };
}

function listMarkdownFiles(absPath, notesDir) {
  const results = [];
  if (!fs.existsSync(absPath)) return results;
  const stat = fs.statSync(absPath);
  if (stat.isFile()) {
    if (/\.md$/i.test(absPath)) results.push(absPath);
    return results;
  }
  if (!stat.isDirectory()) return results;
  fs.readdirSync(absPath, { withFileTypes: true }).forEach((entry) => {
    if (entry.name.startsWith('.')) return;
    const next = path.join(absPath, entry.name);
    if (entry.isDirectory()) results.push(...listMarkdownFiles(next, notesDir));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) results.push(next);
  });
  return results;
}

function executeAnalyzeFolder({ folder_path: folderPath = '', include_content_preview: includePreview = false } = {}, sessionId, notesDir = getEffectiveConfig().notesDir) {
  let target;
  try { target = resolveInsideNotes(notesDir, folderPath, { allowRoot: true }); } catch (error) { return { error: 'INVALID_PATH', message: error.message }; }
  if (!fs.existsSync(target.absolutePath)) return { error: 'FOLDER_NOT_FOUND', path: target.relativePath };
  const all = listMarkdownFiles(target.absolutePath, notesDir);
  const truncated = all.length > ANALYZE_FOLDER_MAX_FILES;
  const selected = truncated ? all.slice(0, ANALYZE_FOLDER_MAX_FILES) : all;
  const files = selected.map((absPath) => {
    const relPath = path.relative(path.resolve(notesDir), absPath).replace(/\\/g, '/');
    const content = fs.readFileSync(absPath, 'utf8');
    const item = { path: relPath, title: extractTitle(relPath, content) };
    if (includePreview) item.preview = content.slice(0, 160);
    return item;
  });
  return { folder_path: target.relativePath, file_count: files.length, total_count: all.length, truncated, truncate_limit: ANALYZE_FOLDER_MAX_FILES, files };
}

function normalizeLinkTarget(rawTarget = '', currentPath = '') {
  const rawClean = String(rawTarget || '').split('|')[0].split('#')[0].split('?')[0].trim();
  let clean = rawClean;
  try { clean = decodeURIComponent(rawClean); } catch {}
  if (!clean || /^https?:\/\//i.test(clean) || clean.startsWith('mailto:')) return null;
  if (/\.[a-z0-9]+$/i.test(clean) && !/\.md$/i.test(clean)) return null;
  const baseDir = path.posix.dirname(currentPath);
  const withExt = /\.md$/i.test(clean) ? clean : `${clean}.md`;
  const resolved = clean.startsWith('/') ? withExt.replace(/^\/+/, '') : path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, withExt));
  if (!resolved || resolved === '.' || resolved.startsWith('../')) return null;
  return resolved;
}

function extractInternalLinks(content = '', currentPath = '') {
  const links = [];
  const wikiRe = /\[\[([^\]]+)\]\]/g;
  let match = wikiRe.exec(content);
  while (match) {
    const target = normalizeLinkTarget(match[1], currentPath);
    if (target) links.push(target);
    match = wikiRe.exec(content);
  }
  const mdRe = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
  match = mdRe.exec(content);
  while (match) {
    const target = normalizeLinkTarget(match[1], currentPath);
    if (target) links.push(target);
    match = mdRe.exec(content);
  }
  return [...new Set(links)];
}

function executeCheckLinks({ scope_path: scopePath = '' } = {}, sessionId, notesDir = getEffectiveConfig().notesDir) {
  let scope;
  try { scope = resolveInsideNotes(notesDir, scopePath, { allowRoot: true }); } catch (error) { return { error: 'INVALID_PATH', message: error.message }; }
  const files = listMarkdownFiles(scope.absolutePath, notesDir).map((absPath) => {
    const relPath = path.relative(path.resolve(notesDir), absPath).replace(/\\/g, '/');
    const content = fs.readFileSync(absPath, 'utf8');
    return { path: relPath, title: extractTitle(relPath, content), content };
  });
  const existing = new Set(files.map((file) => file.path));
  const incoming = new Map(files.map((file) => [file.path, 0]));
  const outgoing = new Map();
  const brokenLinks = [];
  files.forEach((file) => {
    const links = extractInternalLinks(file.content, file.path);
    outgoing.set(file.path, links);
    links.forEach((target) => {
      if (existing.has(target)) incoming.set(target, Number(incoming.get(target) || 0) + 1);
      else brokenLinks.push({ from: file.path, target });
    });
  });
  const orphans = files
    .filter((file) => Number(incoming.get(file.path) || 0) === 0 && (outgoing.get(file.path) || []).length === 0)
    .map((file) => ({ path: file.path, title: file.title }));
  return { orphan_count: orphans.length, orphans, broken_count: brokenLinks.length, broken_links: brokenLinks };
}

function validateToolUseBlock(toolUseBlocks = []) {
  const blocks = Array.isArray(toolUseBlocks) ? toolUseBlocks : [];
  const preview = blocks.find((block) => block.name === 'preview_patch_files');
  if (preview && blocks.length > 1) {
    return { error: true, errorToolUseId: preview.id, message: 'preview_patch_files 必须是该轮的唯一工具调用，请在下一轮单独调用它。' };
  }
  return { error: false };
}

function extractTargetPaths(toolUse = {}) {
  const input = toolUse.input || {};
  if (toolUse.name === 'create_note') return [input.path].filter(Boolean);
  if (toolUse.name === 'preview_patch_files') return (Array.isArray(input.patches) ? input.patches : []).map((patch) => patch.file_path || patch.path).filter(Boolean);
  return [];
}

function summarizeInput(toolUse = {}) {
  const input = toolUse.input || {};
  if (toolUse.name === 'search_knowledge') return input.query || '';
  if (toolUse.name === 'read_file') return input.path || '';
  if (toolUse.name === 'create_note') return input.path || '';
  if (toolUse.name === 'preview_patch_files') return `${Array.isArray(input.patches) ? input.patches.length : 0} 个文件修改`; 
  if (toolUse.name === 'analyze_folder') return input.folder_path || '根目录';
  if (toolUse.name === 'check_links') return input.scope_path || '全库';
  return toolUse.name || '';
}

async function executeToolSafely(toolUse = {}, session, notesDir = getEffectiveConfig().notesDir) {
  try {
    if (['create_note', 'preview_patch_files'].includes(toolUse.name)) {
      const paths = extractTargetPaths(toolUse);
      for (const targetPath of paths) {
        const operation = toolUse.name === 'create_note' ? 'create' : 'modify';
        const check = validateWrite(session.session_token, targetPath, operation);
        if (!check.valid) return { error: 'PERMISSION_DENIED', path: targetPath, reason: check.reason };
      }
    }
    const executor = TOOL_EXECUTORS[toolUse.name];
    if (!executor) return { error: 'UNKNOWN_TOOL', tool_name: toolUse.name };
    return await executor(toolUse.input || {}, session.id, notesDir);
  } catch (error) {
    return { error: 'TOOL_EXECUTION_ERROR', message: error.message };
  }
}

const TOOL_EXECUTORS = {
  search_knowledge: executeSearchKnowledge,
  read_file: executeReadFile,
  create_note: executeCreateNote,
  preview_patch_files: executePreviewPatchFiles,
  analyze_folder: executeAnalyzeFolder,
  check_links: executeCheckLinks,
};

module.exports = {
  buildToolDefinitions,
  validateToolUseBlock,
  extractTargetPaths,
  summarizeInput,
  summarizeToolResult,
  executeToolSafely,
  executeSearchKnowledge,
  executeReadFile,
  executeCreateNote,
  executePreviewPatchFiles,
  executeAnalyzeFolder,
  executeCheckLinks,
  applyPreviewWithConflictCheck,
  alignPatchOldText,
  TOOL_EXECUTORS,
};
