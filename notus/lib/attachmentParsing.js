const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const cheerio = require('cheerio');

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.md', '.markdown', '.txt', '.csv']);
const WEB_DOWNLOAD_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.zip', '.rar', '.7z',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
]);
const MIN_WEB_CONTENT_LENGTH = 200;
const WEB_FETCH_TIMEOUT_MS = 15000;
const MAX_WEB_RESPONSE_BYTES = 2 * 1024 * 1024;

let LiteParseClass = null;

function nowIso() {
  return new Date().toISOString();
}

function buildBase(source, type) {
  return {
    source: String(source || '').trim(),
    type,
    parsedAt: nowIso(),
  };
}

function parseError(source, type, errorCode, warning) {
  return {
    ...buildBase(source, type),
    status: 'error',
    text: '',
    errorCode,
    warning,
  };
}

function detectGarbled(text = '') {
  const source = String(text || '');
  if (!source) return false;
  const replacementChars = (source.match(/\uFFFD/g) || []).length;
  return replacementChars / source.length > 0.2;
}

async function getLiteParse() {
  if (!LiteParseClass) {
    const liteParseModule = await import('@llamaindex/liteparse');
    LiteParseClass = liteParseModule.LiteParse || liteParseModule.default;
  }
  return LiteParseClass;
}

async function parsePdf(filePath, fileName) {
  const base = buildBase(fileName, 'pdf');
  let result;
  try {
    const LiteParse = await getLiteParse();
    const parser = new LiteParse({
      ocrEnabled: false,
      outputFormat: 'text',
      imageMode: 'off',
      quiet: true,
    });
    result = await parser.parse(filePath);
  } catch (error) {
    return parseError(fileName, 'pdf', 'PARSE_FAILED', `PDF 解析失败：${error.message}`);
  }

  const text = String(result?.text || '').trim();
  const pages = Array.isArray(result?.pages) ? result.pages : [];
  const pageCount = pages.length;
  const allPagesEmpty = pages.length > 0 && pages.every((page) => (
    !String(page?.text || '').trim() && (!Array.isArray(page?.textItems) || page.textItems.length === 0)
  ));

  if (!text || allPagesEmpty) {
    return {
      ...base,
      status: 'error',
      text: '',
      pageCount,
      errorCode: 'IMAGE_PDF',
      warning: '此 PDF 是扫描件或图片 PDF，没有可提取的文字层。Notus 当前不执行 OCR。',
    };
  }

  if (detectGarbled(text)) {
    return {
      ...base,
      status: 'partial',
      text,
      pageCount,
      errorCode: 'GARBLED_TEXT',
      warning: '部分文字可能显示异常，原因可能是 PDF 使用了非标准字体编码。',
    };
  }

  return {
    ...base,
    status: 'success',
    text,
    pageCount,
  };
}

async function parseDocx(filePath, fileName) {
  const base = buildBase(fileName, 'docx');
  let result;
  try {
    result = await mammoth.extractRawText({ path: filePath });
  } catch (error) {
    return parseError(fileName, 'docx', 'PARSE_FAILED', `Word 文档解析失败：${error.message}`);
  }

  const text = String(result?.value || '').trim();
  if (!text) {
    return parseError(fileName, 'docx', 'EMPTY_CONTENT', '文档内容为空，或内容仅为图片/图表，无法提取文字。');
  }

  const hasWarnings = Array.isArray(result?.messages) && result.messages.some((message) => message?.type === 'warning');
  return {
    ...base,
    status: hasWarnings ? 'partial' : 'success',
    text,
    warning: hasWarnings ? '文档中部分复杂元素未能完整提取。' : undefined,
  };
}

async function parsePlaintext(filePath, fileName, type) {
  const base = buildBase(fileName, type);
  let text;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    return parseError(fileName, type, 'PARSE_FAILED', `文件读取失败：${error.message}`);
  }
  if (!String(text || '').trim()) {
    return parseError(fileName, type, 'EMPTY_CONTENT', '文件内容为空。');
  }
  return {
    ...base,
    status: 'success',
    text,
  };
}

function getDocumentTypeFromExtension(extension) {
  const ext = String(extension || '').toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.txt') return 'plaintext';
  return 'plaintext';
}

async function parseDocument(filePath, fileName) {
  const ext = path.extname(String(fileName || filePath || '')).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return parseError(fileName, 'plaintext', 'UNSUPPORTED_FORMAT', `不支持的文件格式：${ext || '未知'}。当前支持 PDF、DOCX、MD、TXT、CSV。`);
  }
  if (ext === '.pdf') return parsePdf(filePath, fileName);
  if (ext === '.docx') return parseDocx(filePath, fileName);
  return parsePlaintext(filePath, fileName, getDocumentTypeFromExtension(ext));
}

function normalizeWebText(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readWebResponseText(response) {
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_WEB_RESPONSE_BYTES) {
    throw Object.assign(new Error('网页响应过大。'), { code: 'CONTENT_TOO_LARGE' });
  }
  if (!response.body?.getReader) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_WEB_RESPONSE_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('网页响应过大。'), { code: 'CONTENT_TOO_LARGE' });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractWithReadability(html, url) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  const text = normalizeWebText(article?.textContent || '');
  if (!article || text.length < MIN_WEB_CONTENT_LENGTH) return null;
  return {
    title: String(article.title || '').trim(),
    text,
  };
}

function extractWithCheerio(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, header, footer, aside, [role=navigation]').remove();
  const selectors = ['main', 'article', '[role=main]', '#content', '.content'];
  for (const selector of selectors) {
    const text = normalizeWebText($(selector).text());
    if (text.length >= MIN_WEB_CONTENT_LENGTH) return text;
  }
  return normalizeWebText($('body').text());
}

function normalizeUrl(value) {
  const raw = String(value || '').trim().replace(/[)\]}>，。；;：:]+$/g, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname || '').toLowerCase();
    return WEB_DOWNLOAD_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function extractWebUrls(text = '') {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return [...new Set(matches.map(normalizeUrl).filter(Boolean).filter((url) => !isDownloadUrl(url)))];
}

async function parseUrl(url, { validateUrl } = {}) {
  const normalizedUrl = normalizeUrl(url);
  const base = buildBase(normalizedUrl || url, 'webpage');
  if (!normalizedUrl) {
    return parseError(url, 'webpage', 'FETCH_FAILED', '链接格式无效。');
  }
  let response;
  let html;
  let resolvedUrl = normalizedUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (isDownloadUrl(resolvedUrl)) {
      return parseError(resolvedUrl, 'webpage', 'UNSUPPORTED_FORMAT', '该链接指向文件下载，请先下载后作为附件上传。');
    }
    if (typeof validateUrl === 'function') {
      const validation = await validateUrl(resolvedUrl);
      if (validation?.error) return parseError(resolvedUrl, 'webpage', validation.error, validation.message || '链接不允许读取。');
    }
    try {
      response = await fetch(resolvedUrl, {
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Notus/1.0)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
      });
    } catch (error) {
      return parseError(resolvedUrl, 'webpage', 'FETCH_FAILED', `无法访问该链接：${error.message}`);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location) return parseError(resolvedUrl, 'webpage', 'FETCH_FAILED', '网页重定向缺少目标地址。');
    try {
      resolvedUrl = new URL(location, resolvedUrl).toString();
    } catch {
      return parseError(resolvedUrl, 'webpage', 'FETCH_FAILED', '网页重定向地址无效。');
    }
  }
  if (!response || [301, 302, 303, 307, 308].includes(response.status)) {
    return parseError(resolvedUrl, 'webpage', 'TOO_MANY_REDIRECTS', '网页重定向次数过多。');
  }
  try {
    if (!response.ok) {
      return parseError(resolvedUrl, 'webpage', 'FETCH_FAILED', `请求失败，HTTP ${response.status}。`);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
      return parseError(resolvedUrl, 'webpage', 'UNSUPPORTED_FORMAT', `该链接返回 ${contentType}，不是可解析网页。`);
    }
    html = await readWebResponseText(response);
  } catch (error) {
    return parseError(resolvedUrl, 'webpage', error.code || 'FETCH_FAILED', `无法访问该链接：${error.message}`);
  }

  const readability = extractWithReadability(html, resolvedUrl);
  if (readability) {
    return {
      ...base,
      source: resolvedUrl,
      status: 'success',
      text: readability.text,
      metadata: readability.title ? { title: readability.title } : undefined,
    };
  }

  const $ = cheerio.load(html);
  $('script, style').remove();
  const bodyText = normalizeWebText($('body').text());
  if (bodyText.length < 100) {
    return parseError(
      resolvedUrl,
      'webpage',
      'CSR_PAGE',
      '此页面可能由 JavaScript 动态渲染，无法直接抓取正文。可以复制网页正文后粘贴到输入框。'
    );
  }

  const fallbackText = extractWithCheerio(html);
  if (fallbackText.length < MIN_WEB_CONTENT_LENGTH) {
    return parseError(resolvedUrl, 'webpage', 'EMPTY_CONTENT', '页面内容过少，无法有效提取正文。');
  }

  return {
    ...base,
    source: resolvedUrl,
    status: 'partial',
    text: fallbackText,
    warning: '页面结构不标准，已尽量提取正文，内容可能包含少量导航或无关文字。',
  };
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  extractWebUrls,
  getDocumentTypeFromExtension,
  isDownloadUrl,
  normalizeUrl,
  parseDocument,
  parseUrl,
};
