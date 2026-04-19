// /indexing — Batch indexing progress page
import { Shell } from '../components/Layout/Shell';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Icons } from '../components/ui/Icons';
import { Spinner } from '../components/ui/Spinner';

const COMPLETED = [
  { name: '技术文章 / Redis 深入.md', chunks: 42, ok: true },
  { name: '技术文章 / 分布式系统 / 一致性.md', chunks: 28, ok: true },
  { name: '随笔 / 关于慢的意义.md', chunks: 12, ok: true },
  { name: '随笔 / 周末煮茶.md', chunks: 6, ok: true },
  { name: '随笔 / 搬家第三周.md', chunks: 0, ok: false },
  { name: '读书笔记 / 《思考快与慢》摘录.md', chunks: 18, ok: true },
];

export default function IndexingPage() {
  return (
    <Shell active="" showIndex tocDisabled>
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', padding: 32 }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 4 }}>正在建立索引</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>
            正在向量化你的笔记，这样你就能从任何一段话检索到它
          </div>

          {/* Progress card */}
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: 20,
            marginBottom: 24,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>82 / 128 篇</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>约剩 1 分 20 秒</div>
            </div>
            <ProgressBar value={64} max={100} />
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner size={11} />
              <span>→ 技术文章 / 缓存系列 / 性能优化实践.md</span>
            </div>
          </div>

          {/* Completed list */}
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            已完成
          </div>
          {COMPLETED.map((r, i) => (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 'var(--radius-sm)',
              background: i % 2 ? 'transparent' : 'var(--bg-secondary)',
            }}>
              <span style={{ color: r.ok ? 'var(--success)' : 'var(--warning)' }}>
                {r.ok ? <Icons.check size={14} /> : <Icons.warn size={14} />}
              </span>
              <span style={{ fontSize: 'var(--text-sm)', flex: 1 }}>{r.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                {r.ok ? `${r.chunks} 块` : '解析失败'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
