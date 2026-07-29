const path = require('path');
const { getEffectiveConfig } = require('./config');
const { parseDocument, parseUrl, extractWebUrls, SUPPORTED_EXTENSIONS } = require('./attachmentParsing');
const { hasAttachment, saveAttachment } = require('./parsedAttachmentStore');

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function sanitizeFileName(value) {
  return path.basename(String(value || '未命名附件')).replace(/[<>:"|?*\x00-\x1F]/g, '_').slice(0, 180) || '未命名附件';
}

function isImageAttachment(attachment = {}) {
  const name = String(attachment?.name || attachment?.file_name || attachment?.filename || '').toLowerCase();
  const type = String(attachment?.type || attachment?.contentType || '').split(';')[0].trim().toLowerCase();
  const extension = path.extname(name).toLowerCase();
  return attachment?.media_kind === 'image'
    || attachment?.source_kind === 'image'
    || type.startsWith('image/')
    || ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension);
}

function resolveUploadedAttachmentPath(storedName) {
  const config = getEffectiveConfig();
  const attachmentsDir = path.resolve(config.sessionDir, 'attachments');
  const safeStoredName = path.basename(String(storedName || ''));
  if (!safeStoredName) return null;
  const absolutePath = path.resolve(attachmentsDir, safeStoredName);
  if (!absolutePath.startsWith(`${attachmentsDir}${path.sep}`)) return null;
  return absolutePath;
}

function summarizeParseResult(result = {}, extra = {}) {
  return {
    source: result.source || extra.source || '',
    type: result.type || extra.type || 'plaintext',
    status: result.status || 'error',
    warning: result.warning || null,
    errorCode: result.errorCode || null,
    pageCount: result.pageCount ?? null,
    textLength: String(result.text || '').length,
    duplicate: Boolean(extra.duplicate),
  };
}

function parseGitHubRepositoryUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    const [owner, repo] = parts;
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
    return { owner, repo, source: url.toString() };
  } catch {
    return null;
  }
}

async function parseGitHubRepositoryReadme(value = '') {
  const repository = parseGitHubRepositoryUrl(value);
  if (!repository) return null;
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Notus-Agent-Source-Reader',
  };
  try {
    const repositoryResponse = await fetch(apiBase, { headers, signal: AbortSignal.timeout(12000) });
    if (repositoryResponse.status === 404) {
      return {
        source: repository.source,
        type: 'webpage',
        status: 'error',
        text: '',
        errorCode: 'GITHUB_REPOSITORY_NOT_FOUND',
        warning: 'GitHub 仓库不存在，或当前无法访问该仓库。',
        parsedAt: new Date().toISOString(),
      };
    }
    if (repositoryResponse.status === 403) {
      return {
        source: repository.source,
        type: 'webpage',
        status: 'error',
        text: '',
        errorCode: 'GITHUB_RATE_LIMITED',
        warning: 'GitHub API 当前限流，无法读取仓库 README。',
        parsedAt: new Date().toISOString(),
      };
    }
    if (!repositoryResponse.ok) {
      return {
        source: repository.source,
        type: 'webpage',
        status: 'error',
        text: '',
        errorCode: 'GITHUB_FETCH_FAILED',
        warning: `GitHub 仓库读取失败，HTTP ${repositoryResponse.status}。`,
        parsedAt: new Date().toISOString(),
      };
    }
    const repositoryMeta = await repositoryResponse.json().catch(() => ({}));
    const readmeResponse = await fetch(`${apiBase}/readme`, {
      headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
      signal: AbortSignal.timeout(12000),
    });
    if (readmeResponse.status === 404) {
      return {
        source: repository.source,
        type: 'webpage',
        status: 'error',
        text: '',
        errorCode: 'README_MISSING',
        warning: '仓库可访问，但没有可读取的 README。',
        parsedAt: new Date().toISOString(),
      };
    }
    if (readmeResponse.status === 403) {
      return {
        source: repository.source,
        type: 'webpage',
        status: 'error',
        text: '',
        errorCode: 'GITHUB_RATE_LIMITED',
        warning: 'GitHub API 当前限流，无法读取仓库 README。',
        parsedAt: new Date().toISOString(),
      };
    }
    if (!readmeResponse.ok) {
      return {
        source: repository.source,
        type: 'webpage',
        status: 'error',
        text: '',
        errorCode: 'README_FETCH_FAILED',
        warning: `仓库 README 读取失败，HTTP ${readmeResponse.status}。`,
        parsedAt: new Date().toISOString(),
      };
    }
    const text = await readmeResponse.text();
    if (!text.trim()) {
      return {
        source: repository.source,
        type: 'webpage',
        status: 'error',
        text: '',
        errorCode: 'README_MISSING',
        warning: '仓库 README 内容为空。',
        parsedAt: new Date().toISOString(),
      };
    }
    const fullName = String(repositoryMeta?.full_name || `${repository.owner}/${repository.repo}`);
    return {
      source: repository.source,
      type: 'webpage',
      status: 'success',
      text,
      metadata: {
        title: `${fullName} README`,
        repository: fullName,
        description: String(repositoryMeta?.description || ''),
      },
      parsedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      source: repository.source,
      type: 'webpage',
      status: 'error',
      text: '',
      errorCode: 'GITHUB_FETCH_FAILED',
      warning: `无法读取 GitHub 仓库 README：${error.message}`,
      parsedAt: new Date().toISOString(),
    };
  }
}

async function parseUploadedAttachment(conversationId, attachment = {}) {
  const displayName = sanitizeFileName(attachment.name || attachment.file_name || attachment.filename);
  const ext = path.extname(displayName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      source: displayName,
      type: 'plaintext',
      status: 'error',
      text: '',
      errorCode: 'UNSUPPORTED_FORMAT',
      warning: `不支持的文件格式：${ext || '未知'}。当前支持 PDF、DOCX、MD、TXT。`,
      parsedAt: new Date().toISOString(),
    };
  }
  if (hasAttachment(conversationId, displayName)) {
    return {
      source: displayName,
      type: 'plaintext',
      status: 'success',
      text: '',
      warning: '该文件已在本次对话中导入，无需重复解析。',
      parsedAt: new Date().toISOString(),
      duplicate: true,
    };
  }
  const filePath = resolveUploadedAttachmentPath(attachment.stored_name || attachment.storedName);
  if (!filePath) {
    return {
      source: displayName,
      type: 'plaintext',
      status: 'error',
      text: '',
      errorCode: 'PARSE_FAILED',
      warning: '附件临时文件引用无效。',
      parsedAt: new Date().toISOString(),
    };
  }
  const result = await parseDocument(filePath, displayName);
  if (result.status !== 'error') saveAttachment(conversationId, result);
  return result;
}

async function parseWebUrlForConversation(conversationId, url) {
  if (hasAttachment(conversationId, url)) {
    return {
      source: url,
      type: 'webpage',
      status: 'success',
      text: '',
      warning: '该链接已在本次对话中导入，无需重复抓取。',
      parsedAt: new Date().toISOString(),
      duplicate: true,
    };
  }
  const result = await parseGitHubRepositoryReadme(url) || await parseUrl(url);
  if (result.status !== 'error') saveAttachment(conversationId, result);
  return result;
}

async function parseAgentInputSources({ conversationId, attachments = [], userInputText, text = '', onEvent } = {}) {
  const normalizedConversationId = normalizePositiveInt(conversationId);
  if (!normalizedConversationId) return [];
  const results = [];
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const sourceText = userInputText === undefined ? text : userInputText;

  // 图片属于视觉上下文，不允许落入 PDF/DOCX 等文本附件解析器。
  const uploadedAttachments = (Array.isArray(attachments) ? attachments : []).filter((attachment) => !isImageAttachment(attachment));
  for (const attachment of uploadedAttachments) {
    const source = sanitizeFileName(attachment?.name || attachment?.file_name || attachment?.filename);
    emit({ type: 'attachment_parse_start', source, source_kind: attachment?.source_kind || 'file' });
    const result = await parseUploadedAttachment(normalizedConversationId, attachment);
    const summary = summarizeParseResult(result, { source });
    results.push(summary);
    emit({ ...summary, type: 'attachment_parse_done', source_kind: attachment?.source_kind || 'file' });
  }

  const urls = extractWebUrls(sourceText);
  for (const url of urls) {
    emit({ type: 'attachment_parse_start', source: url, source_kind: 'url' });
    const result = await parseWebUrlForConversation(normalizedConversationId, url);
    const summary = summarizeParseResult(result, { source: url, type: 'webpage' });
    results.push(summary);
    emit({ ...summary, type: 'attachment_parse_done', source_kind: 'url' });
  }

  return results;
}

module.exports = {
  parseAgentInputSources,
  parseUploadedAttachment,
  parseWebUrlForConversation,
  parseGitHubRepositoryReadme,
  parseGitHubRepositoryUrl,
  resolveUploadedAttachmentPath,
  sanitizeFileName,
  summarizeParseResult,
};
