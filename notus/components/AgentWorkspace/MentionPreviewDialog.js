import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Icons } from '../ui/Icons';
import { MarkdownPreview } from '../Editor/MarkdownPreview';

const mentionContentCache = new Map();

function visibleMentionMarkdown(content = '') {
  const source = String(content || '').replace(/\r\n/g, '\n');
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return source;
  const fields = {};
  match[1].split('\n').forEach((line) => {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) fields[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, '');
  });
  const keys = Object.keys(fields);
  const isSystemFrontmatter = String(fields.id || '').startsWith('notus_')
    && keys.length > 0
    && keys.every((key) => ['id', 'created_by', 'title'].includes(key))
    && (keys.length === 1 || fields.created_by === 'notus_agent');
  return isSystemFrontmatter ? source.slice(match[0].length).replace(/^\n+/, '') : source;
}

function errorText(response, fallback) {
  return response.json()
    .then((payload) => payload?.error || fallback)
    .catch(() => fallback);
}

function samePath(left, right) {
  return String(left || '').replace(/^\/+|\/+$/g, '') === String(right || '').replace(/^\/+|\/+$/g, '');
}

function mentionContentKey(file = {}) {
  return `${file?.id || ''}:${String(file?.path || '').replace(/^\/+|\/+$/g, '')}`;
}

async function fetchMentionContent(file = {}) {
  const key = mentionContentKey(file);
  const cached = mentionContentCache.get(key);
  if (cached?.content !== undefined) return cached;
  if (cached?.promise) return cached.promise;
  const promise = fetch(`/api/files/${encodeURIComponent(file.id)}`, { cache: 'force-cache' })
    .then(async (response) => {
      if (!response.ok) throw new Error(response.status === 404 ? '该笔记已不存在' : await errorText(response, '读取笔记失败'));
      const payload = await response.json();
      const resolved = { content: visibleMentionMarkdown(payload.content) };
      mentionContentCache.set(key, resolved);
      return resolved;
    })
    .catch((error) => {
      mentionContentCache.delete(key);
      throw error;
    });
  mentionContentCache.set(key, { promise });
  return promise;
}

export function prefetchMentionDocument(mention = {}) {
  const fileId = Number(mention?.id);
  if (mention?.type === 'folder' || mention?.type === 'skill' || !Number.isFinite(fileId) || fileId <= 0) return;
  void fetchMentionContent(mention).catch(() => {});
}

export function MentionPreviewDialog({ mention, onClose, onOpenDocument }) {
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [content, setContent] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState('');
  const isFolder = mention?.type === 'folder';
  const isSkill = mention?.type === 'skill';

  const loadContent = useCallback(async (file) => {
    if (!file?.id) return;
    setSelectedFile(file);
    setError('');
    const cached = mentionContentCache.get(mentionContentKey(file));
    if (cached?.content !== undefined) {
      setContent(cached.content);
      setLoadingContent(false);
      return;
    }
    setLoadingContent(true);
    try {
      const payload = await fetchMentionContent(file);
      setContent(payload.content);
    } catch (nextError) {
      setContent('');
      setError(nextError.message || '读取笔记失败');
    } finally {
      setLoadingContent(false);
    }
  }, []);

  useEffect(() => {
    if (!mention) return undefined;
    let cancelled = false;
    setFiles([]);
    setSelectedFile(null);
    setContent('');
    setError('');

    const load = async () => {
      setLoadingList(true);
      try {
        if (isSkill) return;
        const fileId = Number(mention?.id);
        if (!isFolder && Number.isFinite(fileId) && fileId > 0) {
          const directFile = { id: mention.id, path: mention.path, name: mention.name, title: mention.name };
          setFiles([directFile]);
          await loadContent(directFile);
          return;
        }
        const response = await fetch('/api/files', { cache: 'no-store' });
        if (!response.ok) throw new Error(await errorText(response, '读取笔记列表失败'));
        const allFiles = await response.json();
        if (cancelled) return;
        const matching = isFolder
          ? allFiles.filter((file) => String(file?.path || '').startsWith(`${String(mention.path || '').replace(/^\/+|\/+$/g, '')}/`))
          : allFiles.filter((file) => String(file?.id || '') === String(mention.id || '') || samePath(file?.path, mention.path));
        if (cancelled) return;
        setFiles(matching);
        if (!isFolder && matching.length === 0) {
          setError('该笔记已不存在');
          return;
        }
        if (matching[0]) await loadContent(matching[0]);
      } catch (nextError) {
        if (!cancelled) setError(nextError.message || '读取笔记列表失败');
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [isFolder, isSkill, loadContent, mention]);

  const title = useMemo(() => {
    const label = selectedFile?.title || selectedFile?.name || mention?.name || (isFolder ? '目录预览' : '笔记预览');
    const openDocument = () => {
      if (isFolder || !selectedFile?.path) return;
      onClose?.();
      onOpenDocument?.(selectedFile.path);
    };
    return (
      <span className="notus-mention-preview-title">
        {isFolder ? <Icons.folder size={17} /> : <Icons.file size={17} />}
        {isFolder ? <span>{label}</span> : (
          <button type="button" className="notus-mention-preview__title-link" onClick={openDocument} title="在编辑器中打开">
            {label}
          </button>
        )}
      </span>
    );
  }, [isFolder, mention?.name, onClose, onOpenDocument, selectedFile?.name, selectedFile?.path, selectedFile?.title]);

  return (
    <Dialog
      open={Boolean(mention)}
      onClose={onClose}
      title={title}
      maxWidth={960}
      className="notus-mention-preview-dialog"
      dialogStyle={{ maxHeight: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column' }}
      bodyStyle={{ minHeight: 0, display: 'flex', flex: 1, overflow: 'hidden' }}
    >
      <div className="notus-mention-preview" aria-busy={loadingList || loadingContent}>
        {isSkill ? <div className="notus-mention-preview__status">Skill 说明会显示在名称悬停提示中。</div> : null}
        {loadingList ? <div className="notus-mention-preview__status">正在加载笔记列表…</div> : null}
        {!loadingList && error ? <div className="notus-mention-preview__error">{error}</div> : null}
        {!loadingList && !error && isFolder && files.length === 0 ? <div className="notus-mention-preview__status">该目录下暂无笔记</div> : null}
        {!loadingList && !error && files.length > 0 ? (
          <div className={`notus-mention-preview__body${isFolder ? ' is-folder' : ''}`}>
            {isFolder ? (
              <aside className="notus-mention-preview__list" aria-label="目录内笔记">
                {files.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    className={Number(selectedFile?.id) === Number(file.id) ? 'is-active' : ''}
                    onClick={() => { void loadContent(file); }}
                    title={file.path}
                  >
                    <Icons.file size={14} />
                    <span>{file.title || file.name || file.path}</span>
                  </button>
                ))}
              </aside>
            ) : null}
            <section className="notus-mention-preview__content">
              {loadingContent ? <div className="notus-mention-preview__status">正在加载笔记内容…</div> : null}
              {!loadingContent && !error ? <MarkdownPreview content={content} /> : null}
            </section>
          </div>
        ) : null}
        {!isSkill && !loadingList && !error && selectedFile ? (
          <div className="notus-mention-preview__footer">
            <span className="notus-mention-preview__footer-path">{selectedFile.path}</span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
