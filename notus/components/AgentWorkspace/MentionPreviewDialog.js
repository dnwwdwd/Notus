import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Icons } from '../ui/Icons';
import { MarkdownPreview } from '../Editor/MarkdownPreview';

function errorText(response, fallback) {
  return response.json()
    .then((payload) => payload?.error || fallback)
    .catch(() => fallback);
}

function samePath(left, right) {
  return String(left || '').replace(/^\/+|\/+$/g, '') === String(right || '').replace(/^\/+|\/+$/g, '');
}

export function MentionPreviewDialog({ mention, onClose }) {
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [content, setContent] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState('');
  const isFolder = mention?.type === 'folder';

  const loadContent = useCallback(async (file) => {
    if (!file?.id) return;
    setSelectedFile(file);
    setLoadingContent(true);
    setError('');
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}`, { cache: 'no-store' });
      if (!response.ok) {
        const message = await errorText(response, '读取笔记失败');
        throw new Error(response.status === 404 ? '该笔记已不存在' : message);
      }
      const payload = await response.json();
      setContent(String(payload.content || ''));
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
  }, [isFolder, loadContent, mention]);

  const title = useMemo(() => (
    <span className="notus-mention-preview-title">
      {isFolder ? <Icons.folder size={17} /> : <Icons.file size={17} />}
      <span>{mention?.name || (isFolder ? '目录预览' : '笔记预览')}</span>
    </span>
  ), [isFolder, mention?.name]);

  return (
    <Dialog
      open={Boolean(mention)}
      onClose={onClose}
      title={title}
      maxWidth={960}
      className="notus-mention-preview-dialog"
    >
      <div className="notus-mention-preview" aria-busy={loadingList || loadingContent}>
        {mention?.path ? <div className="notus-mention-preview__path">{mention.path}</div> : null}
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
      </div>
    </Dialog>
  );
}
