// EditorToolbar — formatting buttons for the Tiptap WYSIWYG editor
// editor: Tiptap editor instance (lifted from WysiwygEditor via onEditorReady)
import { useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/router';
import { Dialog } from '../ui/Dialog';
import { DropdownSelect } from '../ui/DropdownSelect';
import { Icons } from '../ui/Icons';
import { TextInput } from '../ui/Input';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

const Divider = () => (
  <div style={{ width: 1, height: 20, background: 'var(--border-subtle)', margin: '0 4px' }} />
);

const ToolbarButton = ({ active, title, onClick, disabled, children }) => {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 30, height: 30,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 'var(--radius-sm)',
        color: active ? 'var(--accent)' : (disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)'),
        background: active ? 'var(--accent-subtle)' : 'transparent',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background var(--transition-fast)',
      }}
      onMouseEnter={(event) => { if (!active && !disabled) event.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(event) => { if (!active && !disabled) event.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );

  return (
    <Tooltip content={title}>
      <span style={{ display: 'inline-flex' }}>{button}</span>
    </Tooltip>
  );
};

const UrlDialog = ({ title, placeholder, defaultValue = 'https://', confirmLabel = '确认', onConfirm, onClose }) => {
  const [url, setUrl] = useState(defaultValue);

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => onConfirm(url)}>{confirmLabel}</Button>
        </>
      }
    >
      <TextInput
        autoFocus
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onConfirm(url);
          if (event.key === 'Escape') onClose();
        }}
        placeholder={placeholder}
      />
    </Dialog>
  );
};

const ImageDialog = ({ onConfirm, onClose }) => {
  const fileInputRef = useRef(null);
  const [mode, setMode] = useState('local');
  const [selectedFile, setSelectedFile] = useState(null);
  const [url, setUrl] = useState('https://');
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (mode === 'link') {
      if (!url || url === 'https://') return;
      onConfirm(url);
      return;
    }

    if (!selectedFile) return;
    setSubmitting(true);
    const reader = new FileReader();
    reader.onload = () => {
      onConfirm(String(reader.result || ''));
      setSubmitting(false);
    };
    reader.onerror = () => {
      setSubmitting(false);
    };
    reader.readAsDataURL(selectedFile);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="插入图片"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={mode === 'local' ? !selectedFile : !url || url === 'https://'}
            onClick={handleConfirm}
          >
            插入图片
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { value: 'local', label: '选择图片' },
            { value: 'link', label: '图片链接' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setMode(option.value)}
              style={{
                height: 32,
                padding: '0 14px',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${mode === option.value ? 'var(--accent)' : 'var(--border-primary)'}`,
                background: mode === option.value ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                color: mode === option.value ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        {mode === 'local' ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
            />
            <Button
              variant="secondary"
              onClick={() => fileInputRef.current?.click()}
              icon={<Icons.image size={14} />}
              style={{ justifyContent: 'center' }}
            >
              选择本地图片
            </Button>
            <div style={{ fontSize: 'var(--text-sm)', color: selectedFile ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
              {selectedFile ? `已选择：${selectedFile.name}` : '默认优先插入本地图片，内容会以内嵌数据的形式写入 Markdown。'}
            </div>
          </div>
        ) : (
          <TextInput
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/image.png"
          />
        )}
      </div>
    </Dialog>
  );
};

export const EditorToolbar = ({ editor, fileId, showAICreate = true, isDirty = false, requestAction }) => {
  const router = useRouter();
  const [dialogMode, setDialogMode] = useState(null);

  const e = editor;
  const disabled = !e;

  const isActive = useCallback((name, attrs) => {
    if (!e) return false;
    return attrs ? e.isActive(name, attrs) : e.isActive(name);
  }, [e]);

  const handleLink = () => {
    if (!e) return;
    if (e.isActive('link')) {
      e.chain().focus().unsetLink().run();
    } else {
      setDialogMode('link');
    }
  };

  const confirmLink = (url) => {
    if (url && url !== 'https://') {
      e.chain().focus().setLink({ href: url }).run();
    }
    setDialogMode(null);
  };

  const confirmImage = (url) => {
    if (url && url !== 'https://') {
      e.chain().focus().setImage({ src: url }).run();
    }
    setDialogMode(null);
  };

  const handleAICreate = () => {
    const params = fileId ? `?fileId=${fileId}` : '';
    const action = () => router.push(`/canvas${params}`);
    if (requestAction) {
      requestAction(action);
      return;
    }
    action();
  };

  const headingOptions = useMemo(() => ([
    { value: 'paragraph', label: '正文' },
    { value: 'h1', label: 'H1 大标题' },
    { value: 'h2', label: 'H2 中标题' },
    { value: 'h3', label: 'H3 小标题' },
    { value: 'h4', label: 'H4' },
    { value: 'h5', label: 'H5' },
    { value: 'h6', label: 'H6' },
  ]), []);

  const currentHeadingValue = useMemo(() => {
    if (!e) return 'paragraph';
    const current = [1, 2, 3, 4, 5, 6].find((level) => isActive('heading', { level }));
    return current ? `h${current}` : 'paragraph';
  }, [e, isActive]);

  const codeLanguageOptions = useMemo(() => ([
    { value: 'plaintext', label: '纯文本' },
    { value: 'javascript', label: 'JavaScript' },
    { value: 'typescript', label: 'TypeScript' },
    { value: 'jsx', label: 'JSX' },
    { value: 'tsx', label: 'TSX' },
    { value: 'python', label: 'Python' },
    { value: 'java', label: 'Java' },
    { value: 'go', label: 'Go' },
    { value: 'rust', label: 'Rust' },
    { value: 'cpp', label: 'C++' },
    { value: 'c', label: 'C' },
    { value: 'bash', label: 'Bash / Shell' },
    { value: 'json', label: 'JSON' },
    { value: 'yaml', label: 'YAML' },
    { value: 'toml', label: 'TOML' },
    { value: 'sql', label: 'SQL' },
    { value: 'html', label: 'HTML' },
    { value: 'css', label: 'CSS' },
    { value: 'xml', label: 'XML / SVG' },
    { value: 'markdown', label: 'Markdown' },
    { value: 'dockerfile', label: 'Dockerfile' },
    { value: 'nginx', label: 'Nginx' },
    { value: 'ini', label: 'INI' },
  ]), []);

  const currentCodeLanguage = useMemo(() => {
    if (!e || !isActive('codeBlock')) return 'plaintext';
    return e.getAttributes('codeBlock').language || 'plaintext';
  }, [e, isActive]);

  return (
    <>
      {dialogMode === 'link' && (
        <UrlDialog
          title="插入链接"
          placeholder="https://"
          onConfirm={confirmLink}
          onClose={() => setDialogMode(null)}
        />
      )}
      {dialogMode === 'image' && <ImageDialog onConfirm={confirmImage} onClose={() => setDialogMode(null)} />}
      <div style={{
        height: 40,
        background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 4,
        flexShrink: 0,
        position: 'relative',
        overflowX: 'auto',
      }}>
        {/* Undo / Redo */}
        <ToolbarButton title="撤销" disabled={disabled} onClick={() => e?.chain().focus().undo().run()}>
          <Icons.undo size={15} />
        </ToolbarButton>
        <ToolbarButton title="重做" disabled={disabled} onClick={() => e?.chain().focus().redo().run()}>
          <Icons.redo size={15} />
        </ToolbarButton>
        <Divider />

        {/* Heading dropdown */}
        <Tooltip content="设置标题层级">
          <div style={{ width: 112, flexShrink: 0 }}>
            <DropdownSelect
              value={currentHeadingValue}
              options={headingOptions}
              onChange={(nextValue) => {
                if (!e) return;
                if (nextValue === 'paragraph') {
                  e.chain().focus().setParagraph().run();
                } else {
                  e.chain().focus().toggleHeading({ level: Number(nextValue.slice(1)) }).run();
                }
              }}
              disabled={disabled}
              buttonStyle={{
                minHeight: 30,
                height: 30,
                background: 'transparent',
                border: 'none',
                padding: '0 8px',
                color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
              }}
              menuStyle={{ minWidth: 160 }}
              renderValue={(option) => option?.label || '标题'}
            />
          </div>
        </Tooltip>
        <Divider />

        {/* Inline format */}
        <ToolbarButton title="加粗" active={isActive('bold')} disabled={disabled} onClick={() => e?.chain().focus().toggleBold().run()}>
          <Icons.bold size={15} />
        </ToolbarButton>
        <ToolbarButton title="斜体" active={isActive('italic')} disabled={disabled} onClick={() => e?.chain().focus().toggleItalic().run()}>
          <Icons.italic size={15} />
        </ToolbarButton>
        <ToolbarButton title="下划线" active={isActive('underline')} disabled={disabled} onClick={() => e?.chain().focus().toggleUnderline().run()}>
          <UnderlineIcon />
        </ToolbarButton>
        <ToolbarButton title="删除线" active={isActive('strike')} disabled={disabled} onClick={() => e?.chain().focus().toggleStrike().run()}>
          <Icons.strike size={15} />
        </ToolbarButton>
        <ToolbarButton title="行内代码" active={isActive('code')} disabled={disabled} onClick={() => e?.chain().focus().toggleCode().run()}>
          <Icons.code size={15} />
        </ToolbarButton>
        <Divider />

        {/* Insert */}
        <ToolbarButton title="链接" active={isActive('link')} disabled={disabled} onClick={handleLink}>
          <Icons.link size={15} />
        </ToolbarButton>
        <ToolbarButton title="插入图片" disabled={disabled} onClick={() => setDialogMode('image')}>
          <Icons.image size={15} />
        </ToolbarButton>
        <Divider />

        {/* Block */}
        <ToolbarButton title="无序列表" active={isActive('bulletList')} disabled={disabled} onClick={() => e?.chain().focus().toggleBulletList().run()}>
          <Icons.listUl size={15} />
        </ToolbarButton>
        <ToolbarButton title="有序列表" active={isActive('orderedList')} disabled={disabled} onClick={() => e?.chain().focus().toggleOrderedList().run()}>
          <Icons.listOl size={15} />
        </ToolbarButton>
        <ToolbarButton title="任务列表" active={isActive('taskList')} disabled={disabled} onClick={() => e?.chain().focus().toggleTaskList().run()}>
          <ChecklistIcon />
        </ToolbarButton>
        <Divider />

        <ToolbarButton title="引用块" active={isActive('blockquote')} disabled={disabled} onClick={() => e?.chain().focus().toggleBlockquote().run()}>
          <Icons.quote size={15} />
        </ToolbarButton>
        <ToolbarButton title="代码块" active={isActive('codeBlock')} disabled={disabled} onClick={() => e?.chain().focus().toggleCodeBlock({ language: currentCodeLanguage }).run()}>
          <CodeBlockIcon />
        </ToolbarButton>
        {isActive('codeBlock') && (
          <Tooltip content="选择代码语言">
            <div style={{ width: 148, flexShrink: 0 }}>
              <DropdownSelect
                value={currentCodeLanguage}
                options={codeLanguageOptions}
                onChange={(nextValue) => {
                  if (!e) return;
                  if (!e.isActive('codeBlock')) {
                    e.chain().focus().setCodeBlock({ language: nextValue }).run();
                  } else {
                    e.chain().focus().updateAttributes('codeBlock', { language: nextValue }).run();
                  }
                }}
                searchable
                searchPlaceholder="搜索语言"
                buttonStyle={{
                  minHeight: 30,
                  height: 30,
                  background: 'transparent',
                  border: '1px solid var(--border-subtle)',
                  padding: '0 8px',
                  color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                }}
                menuStyle={{ minWidth: 180 }}
                renderValue={(option) => option?.label || '代码语言'}
              />
            </div>
          </Tooltip>
        )}
        <ToolbarButton title="分隔线" disabled={disabled} onClick={() => e?.chain().focus().setHorizontalRule().run()}>
          <Icons.divider size={15} />
        </ToolbarButton>
        <ToolbarButton
          title="清除样式"
          disabled={disabled}
          onClick={() => e?.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          <ClearFormatIcon />
        </ToolbarButton>

        <div style={{ flex: 1 }} />

        {/* AI 创作 */}
        {showAICreate && (
          <button
            onClick={handleAICreate}
            style={{
              height: 28, padding: '0 12px', marginLeft: 6,
              display: 'flex', alignItems: 'center', gap: 6,
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-xs)',
              fontWeight: 500,
              background: 'var(--accent)',
              color: '#fff',
              cursor: 'pointer',
              transition: 'opacity var(--transition-fast)',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(event) => { event.currentTarget.style.opacity = '0.85'; }}
            onMouseLeave={(event) => { event.currentTarget.style.opacity = '1'; }}
          >
            <Icons.sparkles size={13} /> AI 创作
          </button>
        )}
      </div>
      {isDirty && (
        <div style={{
          height: 2,
          background: 'var(--warning)',
          opacity: 0.75,
          animation: 'pulse-border 2s ease infinite',
          flexShrink: 0,
        }} />
      )}
    </>
  );
};

// Inline SVG icons not in Icons.js
const ChecklistIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="4" height="4" rx="1" />
    <path d="m4 7 1 1 2-2M10 7h11M3 13h2M10 13h11M3 19h2M10 19h11" />
    <rect x="3" y="17" width="4" height="4" rx="1" />
  </svg>
);

const CodeBlockIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m8 9-3 3 3 3M16 9l3 3-3 3M13 8l-2 8" />
  </svg>
);

const UnderlineIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4v6a6 6 0 0 0 12 0V4M4 20h16" />
  </svg>
);

const ClearFormatIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4h12M9 4v6a3 3 0 0 0 6 0V4M4 20h10M14 14l6 6M20 14l-6 6" />
  </svg>
);
