import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Icons } from '../ui/Icons';
import { Spinner } from '../ui/Spinner';
import { useAppStatus } from '../../contexts/AppStatusContext';

const DISMISSED_SNAPSHOT_KEY = 'notus-unindexed-files-dismissed';

function getSnapshot(files = []) {
  return files
    .map((file) => `${Number(file.id)}:${String(file.hash || '')}`)
    .sort()
    .join('|');
}

async function consumeSseResponse(response, onEvent) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || '索引任务启动失败');
  }
  if (!response.body) throw new Error('索引接口没有返回可读取的流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    events.forEach((event) => {
      const line = event.split('\n').find((item) => item.startsWith('data:'));
      if (!line) return;
      onEvent(JSON.parse(line.slice(5)));
    });
  }
}

export function UnindexedFilesDialog() {
  const { status, loading: statusLoading, refreshStatus } = useAppStatus();
  const [files, setFiles] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [visible, setVisible] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');

  const shouldCheck = !statusLoading && !status.needsSetup && (
    Number(status.index.pending || 0) > 0 || Number(status.index.failed || 0) > 0
  );
  const snapshot = useMemo(() => getSnapshot(files), [files]);

  const loadFiles = useCallback(async ({ resetSelection = false } = {}) => {
    setLoadingFiles(true);
    try {
      const response = await fetch('/api/index/unindexed', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '读取待索引文件失败');
      const nextFiles = Array.isArray(payload.files) ? payload.files : [];
      const nextSnapshot = getSnapshot(nextFiles);
      setFiles(nextFiles);
      setSelectedIds((previous) => {
        if (resetSelection) return new Set(nextFiles.map((file) => Number(file.id)));
        const available = new Set(nextFiles.map((file) => Number(file.id)));
        return new Set([...previous].filter((id) => available.has(id)));
      });
      if (nextFiles.length === 0) {
        setVisible(false);
        return nextFiles;
      }
      const dismissed = typeof window !== 'undefined'
        ? window.sessionStorage.getItem(DISMISSED_SNAPSHOT_KEY)
        : '';
      if (dismissed !== nextSnapshot) {
        setVisible(true);
        if (resetSelection) setSelectedIds(new Set(nextFiles.map((file) => Number(file.id))));
      }
      return nextFiles;
    } catch (loadError) {
      setError(loadError.message || '读取待索引文件失败');
      setVisible(true);
      return [];
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  useEffect(() => {
    if (!shouldCheck || running) return;
    loadFiles({ resetSelection: true }).catch(() => {});
  }, [loadFiles, running, shouldCheck, status.index.failed, status.index.pending]);

  const dismiss = () => {
    if (running) return;
    if (snapshot && typeof window !== 'undefined') {
      window.sessionStorage.setItem(DISMISSED_SNAPSHOT_KEY, snapshot);
    }
    setVisible(false);
    setError('');
    setSummary(null);
  };

  const toggleFile = (id) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === files.length) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(files.map((file) => Number(file.id))));
  };

  const startSelectedIndexing = async () => {
    const fileIds = [...selectedIds];
    if (fileIds.length === 0) return;
    setRunning(true);
    setError('');
    setSummary(null);
    setProgress({ current: 0, total: fileIds.length, currentFile: '' });
    try {
      const response = await fetch('/api/index/selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: fileIds }),
      });
      await consumeSseResponse(response, (event) => {
        if (event.type === 'progress') {
          setProgress({
            current: Number(event.current || 0),
            total: Number(event.total || fileIds.length),
            currentFile: event.currentFile || '',
          });
        }
        if (event.type === 'done') setSummary(event);
        if (event.type === 'error') throw new Error(event.error || '索引处理失败');
      });
      await refreshStatus({ quiet: true });
      const remaining = await loadFiles();
      if (remaining.length > 0) {
        setSelectedIds((previous) => new Set([...previous].filter((id) => remaining.some((file) => Number(file.id) === id))));
      }
    } catch (runError) {
      setError(runError.message || '索引处理失败');
    } finally {
      setRunning(false);
    }
  };

  if (!visible && !loadingFiles) return null;

  const selectedCount = selectedIds.size;
  const allSelected = files.length > 0 && selectedCount === files.length;

  return (
    <Dialog
      open={visible}
      onClose={dismiss}
      title={running ? '正在建立索引' : '发现未建立索引的文件'}
      maxWidth={680}
      closeOnBackdrop={!running}
      dialogStyle={{ maxHeight: 'min(720px, calc(100dvh - 24px))', display: 'flex', flexDirection: 'column' }}
      bodyStyle={{ overflow: 'auto', minHeight: 0 }}
      footer={(
        <>
          <Button variant="ghost" disabled={running} onClick={dismiss}>暂不处理</Button>
          <Button variant="primary" loading={running} disabled={selectedCount === 0 || loadingFiles} onClick={startSelectedIndexing}>
            {running ? '处理中…' : `索引已选 ${selectedCount} 个`}
          </Button>
        </>
      )}
    >
      {loadingFiles ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}><Spinner size={16} />正在读取文件…</div>
      ) : (
        <>
          <p style={{ margin: '0 0 14px', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.7 }}>
            这些文件尚未建立可检索索引。只会处理你勾选的文件，不会清空其他笔记的索引。
          </p>
          {running && progress ? (
            <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Spinner size={14} />{progress.current} / {progress.total}</div>
              {progress.currentFile ? <div style={{ marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{progress.currentFile}</div> : null}
            </div>
          ) : null}
          {summary ? (
            <div style={{ marginBottom: 12, color: summary.failed ? 'var(--warning)' : 'var(--success)', fontSize: 'var(--text-sm)' }}>
              本次完成：{summary.indexed || 0} 个成功，{summary.skipped || 0} 个跳过，{summary.failed || 0} 个失败。
            </div>
          ) : null}
          {error ? <div style={{ marginBottom: 12, color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{error}</div> : null}
          {files.length > 0 ? (
            <>
              <button type="button" onClick={toggleAll} disabled={running} style={{ border: 0, background: 'transparent', padding: '0 0 8px', color: 'var(--accent)', fontSize: 12, cursor: running ? 'default' : 'pointer' }}>
                {allSelected ? '取消全选' : '全选全部'}
              </button>
              <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'auto', maxHeight: 340 }}>
                {files.map((file) => {
                  const id = Number(file.id);
                  const checked = selectedIds.has(id);
                  const failed = file.status === 'failed';
                  return (
                    <label key={id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', cursor: running ? 'default' : 'pointer', background: checked ? 'var(--accent-subtle)' : 'transparent' }}>
                      <input type="checkbox" checked={checked} disabled={running} onChange={() => toggleFile(id)} style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--text-sm)' }}>{file.title || file.path}</span>
                        <span style={{ display: 'block', marginTop: 2, color: failed ? 'var(--warning)' : 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                          {failed ? file.error || '上次索引失败' : file.path}
                        </span>
                      </span>
                      {failed ? <Icons.warn size={15} /> : null}
                    </label>
                  );
                })}
              </div>
            </>
          ) : !error ? <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>当前没有待处理文件。</div> : null}
        </>
      )}
    </Dialog>
  );
}
