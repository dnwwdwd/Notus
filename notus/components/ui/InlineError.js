// InlineError — compact error message with retry
import { Button } from './Button';
import { Icons } from './Icons';

export const InlineError = ({ message, onRetry }) => (
  <div style={{
    background: 'var(--danger-subtle)',
    borderRadius: 'var(--radius-md)',
    padding: '8px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 'var(--text-sm)',
  }}>
    <span style={{ color: 'var(--danger)' }}><Icons.x size={14} /></span>
    <span style={{ flex: 1 }}>{message}</span>
    {onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>重试</Button>}
  </div>
);
