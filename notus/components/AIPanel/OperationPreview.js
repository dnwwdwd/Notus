// OperationPreview — diff preview card shown in AI panel
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Icons } from '../ui/Icons';

export const OperationPreview = ({ blockIdx, oldContent, newContent, onApply, onCancel }) => (
  <div style={{
    background: 'var(--bg-ai-bubble)',
    border: '1px solid var(--accent-subtle)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-4)',
    marginTop: 12,
  }}>
    {/* Header */}
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
      fontSize: 'var(--text-sm)',
      fontWeight: 500,
    }}>
      <span style={{ color: 'var(--accent)' }}><Icons.robot size={14} /></span>
      <span>操作预览</span>
      <Badge tone="accent">#{blockIdx}</Badge>
    </div>

    {/* Diff */}
    <div style={{
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      lineHeight: 1.7,
      borderRadius: 4,
      overflow: 'hidden',
      border: '1px solid var(--border-subtle)',
    }}>
      {oldContent && (
        <div style={{
          background: 'var(--bg-diff-remove)',
          padding: '4px 10px',
          color: 'var(--danger)',
          textDecoration: 'line-through',
        }}>
          - {oldContent}
        </div>
      )}
      {newContent && (
        <div style={{
          background: 'var(--bg-diff-add)',
          padding: '4px 10px',
          color: 'var(--success)',
        }}>
          + {newContent}
        </div>
      )}
    </div>

    {/* Actions */}
    <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
      <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
      <Button variant="primary" size="sm" onClick={onApply}>应用修改</Button>
    </div>
  </div>
);
