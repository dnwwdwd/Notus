import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Icons } from '../ui/Icons';

function resolveBlockLabel(blocks = [], operation = {}) {
  const index = (Array.isArray(blocks) ? blocks : []).findIndex((block) => block.id === operation.block_id);
  return index >= 0 ? `#${index + 1}` : operation.block_id || '未知块';
}

function resolveOldContent(blocks = [], operation = {}) {
  const block = (Array.isArray(blocks) ? blocks : []).find((item) => item.id === operation.block_id);
  return operation.old || block?.content || '';
}

export function BatchOperationCard({
  operationSet,
  blocks = [],
  onApply,
  onCancel,
}) {
  if (!operationSet) return null;
  const operations = Array.isArray(operationSet.operations) ? operationSet.operations : [];
  const stale = operationSet.status === 'stale';

  return (
    <div style={{
      background: 'var(--bg-ai-bubble)',
      border: '1px solid var(--accent-subtle)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-4)',
      marginTop: 12,
      display: 'grid',
      gap: 10,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 'var(--text-sm)',
        fontWeight: 500,
        flexWrap: 'wrap',
      }}>
        <span style={{ color: 'var(--accent)' }}><Icons.robot size={14} /></span>
        <span>{stale ? '预览已过期' : '批量修改预览'}</span>
        <Badge tone={stale ? 'default' : 'accent'}>{operations.length} 项</Badge>
        <Badge tone="default">{operationSet.mode || 'single'}</Badge>
      </div>

      {stale ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          当前文章内容已经变化，这组预览不能直接应用。你可以查看 diff，再重新生成一次修改。
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 8 }}>
        {operations.slice(0, 3).map((operation, index) => (
          <div
            key={`${operation.block_id || 'insert'}-${index}`}
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 12,
              overflow: 'hidden',
              background: 'var(--bg-primary)',
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: 12,
              color: 'var(--text-secondary)',
            }}>
              <span>{resolveBlockLabel(blocks, operation)}</span>
              <span>{operation.op === 'delete' ? '删除' : operation.op === 'insert' ? '新增' : '改写'}</span>
            </div>
            {operation.op !== 'insert' && (
              <div style={{
                background: 'var(--bg-diff-remove)',
                padding: '6px 10px',
                color: 'var(--danger)',
                fontSize: 12,
                lineHeight: 1.7,
                textDecoration: operation.op === 'delete' ? 'line-through' : 'none',
                whiteSpace: 'pre-wrap',
              }}>
                - {resolveOldContent(blocks, operation)}
              </div>
            )}
            {operation.new ? (
              <div style={{
                background: 'var(--bg-diff-add)',
                padding: '6px 10px',
                color: 'var(--success)',
                fontSize: 12,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
              }}>
                + {operation.new}
              </div>
            ) : null}
          </div>
        ))}
        {operations.length > 3 ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            还有 {operations.length - 3} 项修改未展开显示
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={() => onCancel?.(operationSet)}>
          {stale ? '关闭预览' : '取消'}
        </Button>
        {!stale ? (
          <Button variant="primary" size="sm" onClick={() => onApply?.(operationSet)}>
            应用全部修改
          </Button>
        ) : null}
      </div>
    </div>
  );
}
