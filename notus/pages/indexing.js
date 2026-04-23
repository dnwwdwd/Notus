// /indexing — Batch indexing progress page
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { Shell } from '../components/Layout/Shell';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Icons } from '../components/ui/Icons';
import { Spinner } from '../components/ui/Spinner';
import { Button } from '../components/ui/Button';
import { InlineError } from '../components/ui/InlineError';
import { useToast } from '../components/ui/Toast';
import { useAppStatus } from '../contexts/AppStatusContext';

async function consumeSseResponse(response, onPayload) {
  if (!response.ok) {
    let message = '索引重建启动失败';
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      message = await response.text();
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error('接口没有返回可读取的流');

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
      onPayload(JSON.parse(line.slice(5)));
    });
  }
}

export default function IndexingPage() {
  const router = useRouter();
  const toast = useToast();
  const { status, refreshStatus } = useAppStatus();
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, currentFile: '' });
  const [completed, setCompleted] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  const percent = useMemo(() => {
    if (progress.total) return Math.round((Math.min(progress.current, progress.total) / progress.total) * 100);
    if (status.index.total) return Math.round((status.index.indexed / status.index.total) * 100);
    return 100;
  }, [progress, status.index.indexed, status.index.total]);

  const startRebuild = async () => {
    setStarted(true);
    setRunning(true);
    setError(null);
    setCompleted([]);
    setSummary(null);
    setProgress({ current: 0, total: status.index.total || 0, currentFile: '' });

    try {
      const response = await fetch('/api/index/rebuild', { method: 'POST' });
      await consumeSseResponse(response, (event) => {
        if (event.type === 'queued') {
          setProgress({
            current: 0,
            total: event.generation?.total_files || status.index.total || 0,
            currentFile: '',
          });
        }
        if (event.type === 'progress') {
          setProgress({
            current: event.current || 0,
            total: event.total || 0,
            currentFile: event.currentFile || '',
          });
          setCompleted((prev) => [
            {
              name: event.currentFile || `文件 ${event.current || prev.length + 1}`,
              chunks: event.chunksCount || 0,
              ok: event.status !== 'failed',
              status: event.status || 'indexed',
              error: event.error || '',
            },
            ...prev.slice(0, 39),
          ]);
        }
        if (event.type === 'catching_up') {
          setCompleted((prev) => [
            {
              name: event.currentFile || '补差同步',
              chunks: 0,
              ok: true,
              status: 'catching_up',
              error: event.dirty_files ? `剩余 ${event.dirty_files} 个变更` : '',
            },
            ...prev.slice(0, 39),
          ]);
        }
        if (event.type === 'activated') {
          setSummary({
            total: event.generation?.total_files || progress.total,
            indexed: event.generation?.total_files || progress.total,
            failed: 0,
            skipped: 0,
          });
        }
        if (event.type === 'done') {
          setSummary(event);
          setProgress((prev) => ({ ...prev, current: event.total || prev.total, total: event.total || prev.total }));
        }
        if (event.type === 'failed') throw new Error(event.error || '索引重建失败');
      });
      await refreshStatus();
      toast('索引构建完成', 'success');
    } catch (rebuildError) {
      setError(rebuildError.message || '索引重建失败');
      toast(rebuildError.message || '索引重建失败', 'error');
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (started || running) return;
    const shouldStart = status.needsIndexing;
    if (shouldStart) startRebuild();
  }, [started, running, status.needsIndexing]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Shell active="" showIndex tocDisabled>
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', padding: 32 }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 4 }}>
            {running ? '正在建立索引' : '索引状态'}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>
            正在向量化你的笔记，这样你就能从任何一段话检索到它
          </div>

          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: 20,
            marginBottom: 24,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>
                {progress.total ? `${Math.min(progress.current, progress.total)} / ${progress.total}` : `${status.index.indexed} / ${status.index.total}`} 篇
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {running ? '处理中' : `${status.index.queued + status.index.running} 待处理 · ${status.index.failed} 失败`}
              </div>
            </div>
            <ProgressBar value={percent} max={100} />
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 8 }}>
              {running ? <Spinner size={11} /> : <Icons.check size={12} />}
              <span>{running ? `→ ${progress.currentFile || '准备中…'}` : (status.index.total ? '索引构建已完成' : '当前没有 Markdown 文件')}</span>
            </div>
            {summary && (
              <div style={{ marginTop: 10, fontSize: 11, color: summary.failed > 0 ? 'var(--warning)' : 'var(--success)' }}>
                新建 {summary.indexed || 0}，跳过 {summary.skipped || 0}，失败 {summary.failed || 0}
              </div>
            )}
          </div>

          {error && (
            <div style={{ marginBottom: 16 }}>
              <InlineError message={error} onRetry={startRebuild} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
            <Button variant="primary" disabled={running} onClick={() => router.push('/files')}>进入 Notus</Button>
            <Button variant="secondary" loading={running} onClick={startRebuild}>重新构建索引</Button>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            最近处理
          </div>
          {completed.length === 0 ? (
            <div style={{ padding: '18px 12px', borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
              {running ? '正在等待第一个文件…' : '暂无本轮处理记录'}
            </div>
          ) : completed.map((item, index) => (
            <div key={`${item.name}-${index}`} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 'var(--radius-sm)',
              background: index % 2 ? 'transparent' : 'var(--bg-secondary)',
            }}>
              <span style={{ color: item.ok ? 'var(--success)' : 'var(--warning)' }}>
                {item.ok ? <Icons.check size={14} /> : <Icons.warn size={14} />}
              </span>
              <span style={{ fontSize: 'var(--text-sm)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                {item.ok ? `${item.chunks} 块` : (item.error || '失败')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
