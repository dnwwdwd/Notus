// CanvasBlock — single editable block in the AI creation canvas
// States: default | hover | editing | modified | processing | applied
import { useState, useEffect, useRef } from 'react';
import { useShortcuts } from '../../contexts/ShortcutsContext';
import { Icons } from '../ui/Icons';
import { Badge } from '../ui/Badge';

export const CanvasBlock = ({
  idx,
  blockId,
  content,
  state: externalState = 'default',
  onAI,
  onContentChange,
  dragHandleProps,
}) => {
  const [state, setState] = useState(externalState || 'default');
  const [editContent, setEditContent] = useState(content);
  const textareaRef = useRef(null);
  const { shortcuts, matchShortcut } = useShortcuts();

  // Sync external state (e.g. AI modifies the block from parent)
  useEffect(() => {
    if (externalState && externalState !== 'default') {
      setState(externalState);
    }
  }, [externalState]);

  // Keep edit content in sync when not editing
  useEffect(() => {
    if (state !== 'editing') setEditContent(content);
  }, [content, state]);

  // Auto-focus + position cursor when entering editing mode
  useEffect(() => {
    if (state === 'editing' && textareaRef.current) {
      const el = textareaRef.current;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [state]);

  const saveEdit = () => {
    if (editContent.trim() !== content) {
      onContentChange?.(blockId, editContent);
    }
    setState('default');
  };

  const discardEdit = () => {
    setEditContent(content);
    setState('default');
  };

  const handleKeyDown = (e) => {
    if (matchShortcut(e, shortcuts.blockCancel.combo)) {
      e.preventDefault();
      discardEdit();
    } else if (matchShortcut(e, shortcuts.blockSave.combo)) {
      e.preventDefault();
      saveEdit();
    }
  };

  const handleTextareaChange = (e) => {
    setEditContent(e.target.value);
    // Auto-resize
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  const stateStyles = {
    default:    { borderLeft: '3px solid transparent', background: 'transparent' },
    hover:      { borderLeft: '3px solid var(--border-primary)', background: 'transparent' },
    editing:    { borderLeft: '3px solid var(--accent)', background: 'var(--accent-subtle)' },
    modified:   { borderLeft: '3px solid var(--warning)', background: 'var(--bg-diff-modified, rgba(255,165,0,0.06))' },
    processing: { borderLeft: '3px solid var(--accent)', background: 'var(--accent-subtle)', animation: 'pulse-border 1.5s infinite' },
    applied:    { borderLeft: '3px solid var(--success)', background: 'var(--success-subtle, rgba(34,197,94,0.08))', animation: 'flashSuccess 300ms ease forwards' },
  };

  const s = stateStyles[state] || stateStyles.default;
  const showActions = state === 'hover' || state === 'modified';

  return (
    <div
      style={{
        position: 'relative',
        padding: '10px 16px 10px 20px',
        borderLeft: s.borderLeft,
        background: s.background,
        fontFamily: 'var(--font-editor)',
        fontSize: 'var(--text-base)',
        lineHeight: 1.75,
        transition: 'background var(--transition-fast), border-color var(--transition-fast)',
        borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
      }}
      onMouseEnter={() => state === 'default' && setState('hover')}
      onMouseLeave={() => state === 'hover' && setState('default')}
    >
      {/* Action toolbar (hover or modified) */}
      {showActions && (
        <div style={{
          position: 'absolute',
          right: 12, top: 8,
          display: 'flex',
          gap: 2,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-sm)',
          padding: 2,
          zIndex: 2,
          animation: 'fadeIn var(--transition-fast)',
        }}>
          <button
            title="拖拽排序"
            style={{ width: 26, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', cursor: 'grab', borderRadius: 'var(--radius-sm)' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            {...dragHandleProps}
          >
            <Icons.drag size={12} />
          </button>
          <button
            title="编辑 (双击)"
            onClick={() => setState('editing')}
            style={{ width: 26, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <Icons.edit size={12} />
          </button>
          <button
            title="AI 优化"
            onClick={() => onAI?.(blockId)}
            style={{ width: 26, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', borderRadius: 'var(--radius-sm)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-subtle)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icons.sparkles size={12} />
          </button>
        </div>
      )}

      {/* Modified badge */}
      {state === 'modified' && (
        <div style={{ marginBottom: 4 }}>
          <Badge tone="warning">AI 已修改</Badge>
        </div>
      )}

      {/* Block index */}
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginBottom: 4, opacity: state === 'editing' ? 1 : 0.6 }}>
        #{idx}
      </div>

      {/* Content */}
      {state === 'processing' ? (
        <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>AI 正在为你重写这一段…</span>
      ) : state === 'editing' ? (
        <>
          <textarea
            ref={textareaRef}
            value={editContent}
            onChange={handleTextareaChange}
            onBlur={saveEdit}
            onKeyDown={handleKeyDown}
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              overflow: 'hidden',
              fontFamily: 'var(--font-editor)',
              fontSize: 'var(--text-base)',
              lineHeight: 1.75,
              color: 'var(--text-primary)',
              padding: 0,
              margin: 0,
            }}
          />
        </>
      ) : (
        <div
          style={{ whiteSpace: 'pre-wrap', cursor: 'text' }}
          onDoubleClick={() => setState('editing')}
        >
          {content}
        </div>
      )}
    </div>
  );
};

// Insert indicator between blocks
export const InsertIndicator = () => (
  <div style={{ position: 'relative', height: 10, margin: '0 16px', display: 'flex', alignItems: 'center' }}>
    <div style={{ flex: 1, height: 1, background: 'var(--accent)' }} />
    <div style={{
      width: 20, height: 20,
      borderRadius: '50%',
      background: 'var(--accent)',
      color: '#fff',
      fontSize: 12,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      margin: '0 6px',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <Icons.plus size={12} />
    </div>
    <div style={{ flex: 1, height: 1, background: 'var(--accent)' }} />
  </div>
);

// Add block button at the bottom
export const AddBlockButton = ({ onClick }) => (
  <div
    onClick={onClick}
    style={{
      marginTop: 8,
      padding: '12px 16px',
      textAlign: 'center',
      border: '1px dashed var(--border-primary)',
      borderRadius: 'var(--radius-md)',
      color: 'var(--text-tertiary)',
      fontSize: 'var(--text-sm)',
      cursor: 'pointer',
      transition: 'all var(--transition-fast)',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.borderColor = 'var(--accent)';
      e.currentTarget.style.color = 'var(--accent)';
      e.currentTarget.style.background = 'var(--accent-subtle)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = 'var(--border-primary)';
      e.currentTarget.style.color = 'var(--text-tertiary)';
      e.currentTarget.style.background = 'transparent';
    }}
  >
    + 新建块
  </div>
);
